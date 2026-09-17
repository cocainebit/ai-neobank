import {
  createPostgresJobQueue,
  Deferred,
  ExecutionRejected,
  type ExecutionContext,
  type JobRecord,
  type PostgresJobQueue,
  type PublishContext,
  type SimulationEvidence,
  type Simulator
} from "@ai-neobank/database";
import type { ResolvedAsset, SignedTransaction, TransferRequest } from "@ai-neobank/chain-core";
import { EvmAdapter } from "@ai-neobank/evm-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { SafeGovernanceAdapter, recoverSafeSigner, type CompiledSafeTransaction, type SafeContractAddresses } from "@ai-neobank/safe-adapter";
import { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { decryptSecret } from "@ai-neobank/signer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import type { Hex } from "viem";

export interface WorkerChainConfig {
  signerMasterKey: Uint8Array;
  evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string; confirmations?: number; safeContracts?: SafeContractAddresses };
  solana?: { network: `solana:${string}`; rpcUrl: string; finality?: "confirmed" | "finalized" };
}

export interface WorkerHooks {
  /** Test seam: called after the signed transaction is persisted and before it is broadcast. Throwing simulates a crash. */
  beforeBroadcast?: (context: ExecutionContext, signed: SignedTransaction) => Promise<void>;
}

function resolvedAsset(asset: ExecutionContext["asset"]): ResolvedAsset {
  if (asset.kind === "native") return { kind: "native", decimals: asset.decimals };
  if (asset.kind === "erc20") return { kind: "erc20", address: asset.address ?? "", decimals: asset.decimals };
  return { kind: "spl", mint: asset.address ?? "", decimals: asset.decimals };
}

function safeAsset(asset: ExecutionContext["asset"]): { kind: "native" } | { kind: "erc20"; address: string } {
  return asset.kind === "erc20" ? { kind: "erc20", address: asset.address ?? "" } : { kind: "native" };
}

function squadsAsset(asset: ExecutionContext["asset"]): { kind: "native" } | { kind: "spl"; mint: string; decimals: number } {
  return asset.kind === "spl" ? { kind: "spl", mint: asset.address ?? "", decimals: asset.decimals } : { kind: "native" };
}

function directCompiledHash(context: { intentId: string; network: string; assetId: string; amountBaseUnits: string; to: string }): string {
  return createHash("sha256").update([context.intentId, context.network, context.assetId, context.amountBaseUnits, context.to, "transfer"].join("|")).digest("hex");
}

export class DurableWorker {
  constructor(private readonly queue: PostgresJobQueue, private readonly chainConfig?: WorkerChainConfig, private readonly workerId = crypto.randomUUID(), private readonly hooks: WorkerHooks = {}) {}

  async runOnce(): Promise<boolean> {
    await this.queue.pumpOutbox();
    const job = await this.queue.claim(this.workerId);
    if (!job) return false;
    try {
      await this.handle(job);
      await this.queue.complete(job.id);
    } catch (error) {
      if (error instanceof Deferred) await this.queue.defer(job, error.delaySeconds, error.message);
      else await this.queue.fail(job, error);
    }
    return true;
  }

  /** Runs until the queue is idle or the budget is spent; returns the number of jobs handled. */
  async drain(maxJobs = 50): Promise<number> {
    let handled = 0;
    while (handled < maxJobs && await this.runOnce()) handled += 1;
    return handled;
  }

  private intentIdOf(job: JobRecord): string {
    const intentId = job.payload.intentId;
    if (typeof intentId !== "string") throw new Error(`${job.type} requires intentId`);
    return intentId;
  }

  private async handle(job: JobRecord): Promise<void> {
    const intentId = this.intentIdOf(job);
    switch (job.type) {
      case "intent.evaluate": return this.queue.evaluateIntent(intentId, this.chainConfig ? (input) => this.simulate(input) : undefined);
      case "approval.expire": return this.queue.expireApproval(intentId);
      case "proposal.publish": return this.publish(intentId);
      case "proposal.observe": return this.queue.observeProposal(intentId, (input) => this.observe(input));
      case "transaction.execute": return this.execute(intentId);
      case "transaction.confirm": return this.confirm(intentId);
      default: throw new Error(`No handler registered for ${job.type}`);
    }
  }

  // Adapters

  private evm(network: string): EvmAdapter {
    const config = this.chainConfig?.evm;
    if (!config || config.network !== network) throw new Error(`No EVM adapter configured for ${network}`);
    return new EvmAdapter(config);
  }

  private solana(network: string): SolanaAdapter {
    const config = this.chainConfig?.solana;
    if (!config || config.network !== network) throw new Error(`No Solana adapter configured for ${network}`);
    return new SolanaAdapter(config);
  }

  private safe(network: string): SafeGovernanceAdapter {
    const config = this.chainConfig?.evm;
    if (!config || config.network !== network) throw new Error(`No EVM adapter configured for ${network}`);
    return new SafeGovernanceAdapter({ rpcUrl: config.rpcUrl, chainId: config.chainId, ...(config.safeContracts ? { contracts: config.safeContracts } : {}) });
  }

  private squads(network: string): SquadsGovernanceAdapter {
    return new SquadsGovernanceAdapter(this.solana(network));
  }

  adapterFor(chainFamily: "evm" | "svm", network: string): EvmAdapter | SolanaAdapter {
    return chainFamily === "evm" ? this.evm(network) : this.solana(network);
  }

  private decrypt(context: { encryptedSecret: string; encryptionNonce: string; authTag: string; keyVersion: number }): Uint8Array {
    if (!this.chainConfig) throw new Error("Chain execution is not configured");
    return decryptSecret({ ciphertext: context.encryptedSecret, nonce: context.encryptionNonce, authTag: context.authTag, keyVersion: context.keyVersion }, this.chainConfig.signerMasterKey);
  }

  // Intake simulation

  private async simulate(input: Parameters<Simulator>[0]): Promise<SimulationEvidence> {
    const asset = resolvedAsset(input.asset);
    const adapter = this.adapterFor(input.chainFamily, input.network);
    const amount = BigInt(input.amountBaseUnits);
    const balance = await adapter.getBalance(input.from, asset).catch(() => null);
    let simulation;
    if (input.governance === "squads") {
      simulation = await this.squads(input.network).simulateVaultTransfer(String(input.treasuryConfiguration.multisigPda ?? ""), input.to, squadsAsset(input.asset), amount);
    } else {
      // Direct and Safe both simulate the transfer as the treasury address; the Safe's own call wraps it later.
      simulation = await adapter.simulateTransfer({ from: input.from, to: input.to, asset, amountBaseUnits: amount, idempotencyKey: input.intentId });
    }
    const evidence: SimulationEvidence = { ok: simulation.ok, feeBaseUnits: simulation.feeBaseUnits.toString(), sourceBalanceBaseUnits: balance?.toString() ?? "unknown" };
    if (simulation.error) evidence.error = simulation.error;
    if (simulation.ok && balance !== null && balance < amount) {
      evidence.ok = false;
      evidence.error = `Insufficient balance: ${balance} < ${input.amountBaseUnits}`;
    }
    return evidence;
  }

  // Governed proposals

  private async publish(intentId: string): Promise<void> {
    let context: PublishContext;
    try {
      context = await this.queue.getPublishContext(intentId);
    } catch (error) {
      if (error instanceof ExecutionRejected) { await this.queue.markFailed(intentId, error.message); return; }
      throw error;
    }
    const amount = BigInt(context.amountBaseUnits);
    if (context.governance === "safe") {
      const safe = this.safe(context.network);
      const [compiled, observed] = await Promise.all([safe.compileTransfer(context.from, safeAsset(context.asset), context.to, amount), safe.observe(context.from)]);
      await this.queue.completePublication(intentId, {
        compiledHash: compiled.safeTxHash.replace(/^0x/, ""),
        requiredApprovals: Math.max(context.minApprovals, observed.threshold),
        externalRef: { kind: "safe", safeAddress: context.from, chainId: this.chainConfig?.evm?.chainId, threshold: observed.threshold, owners: observed.owners, safeTx: compiled }
      });
      return;
    }
    const squads = this.squads(context.network);
    const multisigPda = String(context.treasuryConfiguration.multisigPda ?? "");
    if (!multisigPda) { await this.queue.markFailed(intentId, "Squads treasury has no multisigPda in its observed configuration"); return; }
    const executor = new PublicKey(context.executorAddress);
    const observed = await squads.observe(multisigPda);
    let transactionIndex = observed.transactionIndex + 1n;
    const previous = context.publication?.transactionIndex ? BigInt(String(context.publication.transactionIndex)) : null;
    let alreadyPublished = false;
    if (previous !== null) {
      // A prior attempt recorded an index before broadcasting: either it landed, or the index was taken meanwhile.
      if (await squads.publishedBy(multisigPda, previous, context.executorAddress)) { transactionIndex = previous; alreadyPublished = true; }
      else if (previous > observed.transactionIndex) transactionIndex = previous;
    }
    const proposal = await squads.prepareProposal(multisigPda, executor, transactionIndex, context.to, squadsAsset(context.asset), amount, `relay:${intentId}`);
    if (!alreadyPublished) {
      await this.queue.recordPublication(intentId, { multisigPda, transactionIndex: transactionIndex.toString(), proposalPda: proposal.ref.proposalPda, executor: context.executorAddress });
      const secret = this.decrypt(context);
      let signed: SignedTransaction;
      try { signed = await this.solana(context.network).signInstructions(proposal.instructions, Keypair.fromSecretKey(secret)); } finally { secret.fill(0); }
      await this.solana(context.network).broadcast(signed);
      await squads.waitFor(signed.hash);
    }
    await this.queue.completePublication(intentId, {
      compiledHash: createHash("sha256").update(`squads|${multisigPda}|${transactionIndex}|${context.to}|${context.amountBaseUnits}|${context.asset.id}`).digest("hex"),
      requiredApprovals: observed.threshold,
      externalRef: { kind: "squads", ...proposal.ref, threshold: observed.threshold, members: observed.members }
    });
  }

  private async observe(input: Parameters<typeof this.queue.observeProposal>[1] extends (arg: infer A) => unknown ? A : never) {
    if (input.externalRef.kind !== "squads") return null;
    return this.squads(input.network).observeProposal(String(input.externalRef.multisigPda), BigInt(String(input.externalRef.transactionIndex)));
  }

  // Execution

  private async execute(intentId: string): Promise<void> {
    if (!this.chainConfig) throw new Error("Chain execution is not configured");
    let context: ExecutionContext;
    try {
      context = await this.queue.getExecutionContext(intentId);
    } catch (error) {
      if (error instanceof ExecutionRejected) { await this.queue.markFailed(intentId, error.message); return; }
      throw error;
    }
    const adapter = this.adapterFor(context.chainFamily, context.network);

    // Recovery: a signed transaction exists, so the chain decides what happened.
    if (context.execution?.status === "signed" && context.execution.signedPayload && context.execution.transactionHash) {
      const signed: SignedTransaction = { hash: context.execution.transactionHash, raw: context.execution.signedPayload, nonce: context.execution.nonce ?? "", validUntil: context.execution.validUntil ?? "" };
      const status = await adapter.broadcastStatus(signed);
      if (status.state === "unseen_dead") { await this.queue.markFailed(intentId, `Signed transaction can never land: ${status.reason}`); return; }
      if (status.state === "unseen_resendable") await adapter.broadcast(signed);
      await this.queue.markSubmitted(intentId, context.execution.id);
      return;
    }
    if (context.execution && !["simulated", "signed"].includes(context.execution.status)) {
      throw new Error(`Execution is already ${context.execution.status}`);
    }

    const build = await this.buildExecution(context);
    if ("failure" in build) { await this.queue.markFailed(intentId, build.failure); return; }
    const executionId = context.execution?.id ?? await this.queue.recordSimulation(context, build.feeBaseUnits, build.compiledPayload, build.compiledHash);
    const secret = this.decrypt(context);
    let signed: SignedTransaction;
    try {
      signed = await build.sign(secret);
    } finally {
      secret.fill(0);
    }
    await this.queue.markSigned(executionId, signed);
    if (this.hooks.beforeBroadcast) await this.hooks.beforeBroadcast(context, signed);
    await adapter.broadcast(signed);
    await this.queue.markSubmitted(intentId, executionId);
  }

  /** Compiles, simulates, and prepares the signer for the intent's governance kind. */
  private async buildExecution(context: ExecutionContext): Promise<{ failure: string } | { feeBaseUnits: bigint; compiledPayload: Record<string, unknown>; compiledHash: string; sign: (secret: Uint8Array) => Promise<SignedTransaction> }> {
    const amount = BigInt(context.amountBaseUnits);
    if (context.governance === "direct") {
      const compiledHash = directCompiledHash(context);
      if (compiledHash !== context.approvalCompiledHash) return { failure: "Compiled payload no longer matches the approved hash" };
      const request: TransferRequest = { from: context.from, to: context.to, asset: resolvedAsset(context.asset), amountBaseUnits: amount, idempotencyKey: context.intentId };
      const adapter = this.adapterFor(context.chainFamily, context.network);
      const simulation = await adapter.simulateTransfer(request);
      if (!simulation.ok) return { failure: `Simulation failed before signing: ${simulation.error ?? "unknown"}` };
      return {
        feeBaseUnits: simulation.feeBaseUnits,
        compiledPayload: { kind: `${context.asset.kind}_transfer`, network: context.network, from: context.from, to: context.to, assetId: context.assetId, amountBaseUnits: context.amountBaseUnits },
        compiledHash,
        sign: (secret) => context.chainFamily === "evm"
          ? (adapter as EvmAdapter).signTransfer(request, `0x${Buffer.from(secret).toString("hex")}`)
          : (adapter as SolanaAdapter).signTransfer(request, Keypair.fromSecretKey(secret))
      };
    }
    if (context.governance === "safe") {
      const ref = context.externalRef as { safeTx?: CompiledSafeTransaction; owners?: string[]; threshold?: number } | null;
      if (!ref?.safeTx || !ref.owners) return { failure: "Approval request has no Safe transaction" };
      const compiled = ref.safeTx;
      if (compiled.safeTxHash.replace(/^0x/, "") !== context.approvalCompiledHash) return { failure: "Safe transaction no longer matches the approved hash" };
      const safe = this.safe(context.network);
      const observed = await safe.observe(context.from);
      if (observed.nonce !== compiled.nonce) return { failure: `Safe nonce moved to ${observed.nonce} while ${compiled.nonce} was approved; re-submit the intent` };
      const owners = new Set(observed.owners.map((owner) => owner.toLowerCase()));
      const signatures: { owner: string; signature: string }[] = [];
      for (const entry of context.ownerSignatures) {
        const recovered = await recoverSafeSigner(compiled.safeTxHash, entry.signedPayload).catch(() => null);
        if (recovered && owners.has(recovered.toLowerCase()) && recovered.toLowerCase() === entry.signerAddress.toLowerCase()) signatures.push({ owner: recovered, signature: entry.signedPayload });
      }
      if (signatures.length < observed.threshold) return { failure: `Only ${signatures.length} valid owner signatures for a threshold of ${observed.threshold}` };
      const data = safe.encodeExecution(compiled, signatures);
      const evm = this.evm(context.network);
      const simulation = await evm.simulateCall({ from: context.signerAddress, to: context.from, data });
      if (!simulation.ok) return { failure: `Safe execution simulation failed: ${simulation.error ?? "unknown"}` };
      return {
        feeBaseUnits: simulation.feeBaseUnits,
        compiledPayload: { kind: "safe_exec_transaction", network: context.network, safe: context.from, to: context.to, assetId: context.assetId, amountBaseUnits: context.amountBaseUnits, safeTxHash: compiled.safeTxHash, nonce: compiled.nonce, signers: signatures.map((entry) => entry.owner) },
        compiledHash: context.approvalCompiledHash,
        sign: (secret) => evm.signCall({ from: context.signerAddress, to: context.from, data }, `0x${Buffer.from(secret).toString("hex")}` as Hex)
      };
    }
    const ref = context.externalRef as { multisigPda?: string; transactionIndex?: string } | null;
    if (!ref?.multisigPda || !ref.transactionIndex) return { failure: "Approval request has no Squads proposal" };
    const squads = this.squads(context.network);
    const transactionIndex = BigInt(ref.transactionIndex);
    const proposal = await squads.observeProposal(ref.multisigPda, transactionIndex);
    if (!proposal) return { failure: "Squads proposal account is missing" };
    if (proposal.status !== "approved") return { failure: `Squads proposal is ${proposal.status}, not approved` };
    const execute = await squads.prepareExecute(ref.multisigPda, transactionIndex, new PublicKey(context.signerAddress));
    const solana = this.solana(context.network);
    const simulation = await solana.simulateInstructions([execute.instruction], new PublicKey(context.signerAddress), execute.lookupTableAccounts);
    if (!simulation.ok) return { failure: `Squads execution simulation failed: ${simulation.error ?? "unknown"}` };
    return {
      feeBaseUnits: simulation.feeBaseUnits,
      compiledPayload: { kind: "squads_vault_transaction_execute", network: context.network, multisigPda: ref.multisigPda, transactionIndex: ref.transactionIndex, to: context.to, assetId: context.assetId, amountBaseUnits: context.amountBaseUnits, approved: proposal.approved },
      compiledHash: context.approvalCompiledHash,
      sign: (secret) => solana.signInstructions([execute.instruction], Keypair.fromSecretKey(secret), [], execute.lookupTableAccounts)
    };
  }

  private async confirm(intentId: string): Promise<void> {
    const context = await this.queue.getConfirmationContext(intentId);
    const adapter = this.adapterFor(context.chainFamily, context.network);
    const asset = resolvedAsset(context.asset);
    let receipt;
    try {
      receipt = await adapter.waitForTransaction(context.transactionHash, { to: context.to, asset, amountBaseUnits: BigInt(context.amountBaseUnits) });
    } catch (error) {
      // Not yet visible at the queried commitment; look again shortly.
      throw new Deferred(error instanceof Error ? error.message : "Transaction not yet visible", 3);
    }
    if (receipt.failed) {
      await this.queue.markFailed(intentId, "Transaction executed but failed on chain", { feeBaseUnits: receipt.feeBaseUnits, network: context.network, transactionHash: context.transactionHash });
      return;
    }
    if (!receipt.finalized) throw new Deferred(`Awaiting finality (${receipt.confirmations} confirmations)`, 3);
    await this.queue.markFinalized(context, receipt);
  }
}

export function createWorker(databaseUrl: string, chainConfig?: WorkerChainConfig, hooks?: WorkerHooks): { worker: DurableWorker; queue: PostgresJobQueue; close: () => Promise<void> } {
  const queue = createPostgresJobQueue(databaseUrl);
  return { worker: new DurableWorker(queue, chainConfig, undefined, hooks), queue, close: () => queue.close() };
}
