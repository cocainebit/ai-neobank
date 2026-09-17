import {
  createPostgresJobQueue,
  Deferred,
  ExecutionRejected,
  OperationsStore,
  RotationStore,
  type PostgresControlPlaneStore,
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
import { X402PaymentClient, X402QuoteError, solanaWireNetwork, type PaymentPayload, type X402Quote } from "@ai-neobank/x402-adapter";
import { LocalKeyring, kmsEvmAccount, openSecret, rewrapSecret, type KeyEncryptionProvider, type KmsClient } from "@ai-neobank/signer";
import type { SignerKeyMaterial } from "@ai-neobank/database";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface WorkerChainConfig {
  /** Legacy single master key; equivalent to a keyring holding only version "1". */
  signerMasterKey?: Uint8Array;
  /** Key-encryption provider for software signers' data keys (local keyring or KMS). */
  keys?: KeyEncryptionProvider;
  /** KMS used by signers whose private key never leaves it. */
  kms?: KmsClient;
  evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string; confirmations?: number; safeContracts?: SafeContractAddresses };
  solana?: { network: `solana:${string}`; rpcUrl: string; finality?: "confirmed" | "finalized"; /** CAIP-2 id on the x402 wire; derived from the genesis hash when omitted. */ x402Network?: string };
}

/** How a signed execution reaches the network and how a retry finds out what happened to it. */
interface ExecutionPlan {
  feeBaseUnits: bigint;
  compiledPayload: Record<string, unknown>;
  compiledHash: string;
  sign(keys: SigningKeys): Promise<SignedTransaction>;
  broadcast(signed: SignedTransaction): Promise<Settlement | void>;
  recover(signed: SignedTransaction): Promise<{ outcome: "resend" } | { outcome: "settled"; settlement?: Settlement } | { outcome: "dead"; reason: string }>;
}

interface Settlement { transactionHash: string; payTo: string; amountBaseUnits: string; observed?: Record<string, unknown> }

/** Whatever signs for this execution: an EVM account (local key or KMS) or a Solana keypair. */
export interface SigningKeys {
  evm(): LocalAccount;
  solana(): Keypair;
  /** Raw secret bytes, for SDKs that need them (x402 Solana); absent for KMS custody. */
  secret(): Uint8Array;
}

export interface WorkerOptions {
  /** Periodic work: chain sync for every active treasury on a configured network, and recurring payments. Off unless set. */
  maintenance?: { syncIntervalMs: number; scheduleIntervalMs: number };
  /** Upper bound on EVM blocks read per sync, so a long gap is caught up over several runs. */
  evmMaxBlocksPerSync?: number;
}

export interface SyncResult {
  treasuryId: string;
  assets: { assetId: string; opened: boolean; inflows: number; reconciliation: string | null; error: string | null }[];
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
  private readonly operations: OperationsStore;
  private readonly rotations: RotationStore;
  private lastSyncEnqueue = 0;
  private lastScheduleEnqueue = 0;

  constructor(private readonly queue: PostgresJobQueue, private readonly chainConfig?: WorkerChainConfig, private readonly workerId = crypto.randomUUID(), private readonly hooks: WorkerHooks = {}, private readonly options: WorkerOptions = {}) {
    this.operations = new OperationsStore(queue.sql);
    this.rotations = new RotationStore(queue.sql);
  }

  /** Enqueues periodic jobs once per interval bucket; dedupe keys keep several workers from doubling them. */
  private async maintain(): Promise<void> {
    const maintenance = this.options.maintenance;
    if (!maintenance) return;
    const now = Date.now();
    if (now - this.lastScheduleEnqueue >= maintenance.scheduleIntervalMs) {
      this.lastScheduleEnqueue = now;
      await this.queue.enqueueJob(null, "schedules.enqueue", {}, `schedules:${Math.floor(now / maintenance.scheduleIntervalMs)}`);
    }
    if (now - this.lastSyncEnqueue >= maintenance.syncIntervalMs) {
      this.lastSyncEnqueue = now;
      const targets = await this.operations.listSyncTargets(this.configuredNetworks());
      for (const target of targets) {
        await this.queue.enqueueJob(target.organizationId, "treasury.sync", { treasuryId: target.treasuryId }, `sync:${target.treasuryId}:${Math.floor(now / maintenance.syncIntervalMs)}`);
      }
    }
  }

  private configuredNetworks(): string[] {
    const networks: string[] = [];
    if (this.chainConfig?.evm) networks.push(this.chainConfig.evm.network);
    if (this.chainConfig?.solana) networks.push(this.chainConfig.solana.network);
    return networks;
  }

  async runOnce(): Promise<boolean> {
    await this.maintain();
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
    if (job.type === "schedules.enqueue") { await this.enqueueSchedules(); return; }
    if (job.type.startsWith("rotation.")) {
      const rotationId = job.payload.rotationId;
      if (typeof rotationId !== "string") throw new Error(`${job.type} requires rotationId`);
      try {
        if (job.type === "rotation.publish") await this.publishRotation(rotationId);
        else if (job.type === "rotation.observe") await this.observeRotation(rotationId);
        else if (job.type === "rotation.execute") await this.executeRotation(rotationId);
        else throw new Error(`No handler registered for ${job.type}`);
      } catch (error) {
        if (error instanceof ExecutionRejected) { await this.rotations.fail(rotationId, error.message); return; }
        throw error;
      }
      return;
    }
    if (job.type === "treasury.sync") {
      const treasuryId = job.payload.treasuryId;
      if (typeof treasuryId !== "string") throw new Error("treasury.sync requires treasuryId");
      await this.syncTreasury(treasuryId);
      return;
    }
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

  private x402Cache: X402PaymentClient | null = null;

  private async x402(): Promise<X402PaymentClient> {
    if (this.x402Cache) return this.x402Cache;
    if (!this.chainConfig) throw new Error("Chain execution is not configured");
    const solana = this.chainConfig.solana;
    this.x402Cache = new X402PaymentClient({
      ...(this.chainConfig.evm ? { evm: { network: this.chainConfig.evm.network, chainId: this.chainConfig.evm.chainId, rpcUrl: this.chainConfig.evm.rpcUrl } } : {}),
      ...(solana ? { solana: { network: solana.network, rpcUrl: solana.rpcUrl, wireNetwork: solana.x402Network ?? await solanaWireNetwork(solana.network, solana.rpcUrl) } } : {})
    });
    return this.x402Cache;
  }

  private keyProvider(): KeyEncryptionProvider {
    if (this.chainConfig?.keys) return this.chainConfig.keys;
    if (this.chainConfig?.signerMasterKey) return new LocalKeyring({ "1": this.chainConfig.signerMasterKey }, "1");
    throw new Error("No signer key provider is configured");
  }

  /**
   * Opens the signer for one use. Software secrets are zeroed when `use`
   * returns; KMS custody never brings key material into the process.
   */
  private async withSigner<T>(key: SignerKeyMaterial, chainFamily: "evm" | "svm", use: (keys: SigningKeys) => Promise<T>): Promise<T> {
    if (key.custody === "kms") {
      if (chainFamily !== "evm") throw new ExecutionRejected("KMS custody signs EVM transactions only");
      if (!this.chainConfig?.kms || !key.kmsKeyId) throw new Error("KMS is not configured for this worker");
      const account = await kmsEvmAccount(this.chainConfig.kms, key.kmsKeyId);
      const unavailable = (): never => { throw new ExecutionRejected("This operation needs a key held outside KMS"); };
      return use({ evm: () => account, solana: unavailable, secret: unavailable });
    }
    const secret = await openSecret({ ciphertext: key.encryptedSecret!, nonce: key.encryptionNonce!, authTag: key.authTag!, keyVersion: key.keyVersion, dataKey: key.dataKey, dataKeyVersion: key.dataKeyVersion }, this.keyProvider());
    try {
      return await use({
        evm: () => privateKeyToAccount(`0x${Buffer.from(secret).toString("hex")}`),
        solana: () => Keypair.fromSecretKey(secret),
        secret: () => secret
      });
    } finally {
      secret.fill(0);
    }
  }

  // Intake simulation

  private async simulate(input: Parameters<Simulator>[0]): Promise<SimulationEvidence> {
    const asset = resolvedAsset(input.asset);
    const adapter = this.adapterFor(input.chainFamily, input.network);
    const amount = BigInt(input.amountBaseUnits);
    const balance = await adapter.getBalance(input.from, asset).catch(() => null);
    if (input.kind === "x402") {
      // The quote is the compiled transaction: what the approver authorises is the seller's exact terms.
      let quote: X402Quote;
      try {
        quote = await (await this.x402()).quote({ url: input.to }, { chainFamily: input.chainFamily, network: input.network, assetAddress: input.asset.address ?? "", maxAmountBaseUnits: amount });
      } catch (error) {
        return { ok: false, feeBaseUnits: "0", sourceBalanceBaseUnits: balance?.toString() ?? "unknown", error: error instanceof X402QuoteError ? `x402 quote ${error.code}: ${error.message}` : `x402 quote failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const price = BigInt(quote.requirements.amount);
      const evidence: SimulationEvidence = {
        ok: balance === null || balance >= price,
        feeBaseUnits: "0",
        sourceBalanceBaseUnits: balance?.toString() ?? "unknown",
        quote: { url: quote.url, method: quote.method, x402Version: quote.x402Version, requirements: quote.requirements, resource: quote.resource, paymentRequired: quote.paymentRequired, quotedAt: new Date().toISOString() },
        compiledHash: X402PaymentClient.quoteHash(quote)
      };
      if (!evidence.ok) evidence.error = `Insufficient token balance for the quoted price: ${balance} < ${price}`;
      return evidence;
    }
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
      const signed = await this.withSigner(context.key, "svm", (keys) => this.solana(context.network).signInstructions(proposal.instructions, keys.solana()));
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
    if (context.execution && !["simulated", "signed"].includes(context.execution.status)) {
      throw new Error(`Execution is already ${context.execution.status}`);
    }
    const build = await this.buildExecution(context);
    if ("failure" in build) { await this.queue.markFailed(intentId, build.failure); return; }

    // Recovery: something signed exists, so the network decides what happened to it.
    if (context.execution?.status === "signed" && context.execution.signedPayload && context.execution.transactionHash) {
      const signed: SignedTransaction = { hash: context.execution.transactionHash, raw: context.execution.signedPayload, nonce: context.execution.nonce ?? "", validUntil: context.execution.validUntil ?? "" };
      const recovered = await build.recover(signed);
      if (recovered.outcome === "dead") { await this.queue.markFailed(intentId, `Signed transaction can never land: ${recovered.reason}`); return; }
      const settlement = recovered.outcome === "resend" ? await build.broadcast(signed) : recovered.settlement;
      await this.queue.markSubmitted(intentId, context.execution.id, settlement ?? undefined);
      return;
    }

    const executionId = context.execution?.id ?? await this.queue.recordSimulation(context, build.feeBaseUnits, build.compiledPayload, build.compiledHash);
    const signed = await this.withSigner(context.key, context.chainFamily, (keys) => build.sign(keys));
    await this.queue.markSigned(executionId, signed);
    if (this.hooks.beforeBroadcast) await this.hooks.beforeBroadcast(context, signed);
    const settlement = await build.broadcast(signed);
    await this.queue.markSubmitted(intentId, executionId, settlement ?? undefined);
  }

  /** Chain broadcast and recovery shared by direct, Safe, and Squads executions. */
  private chainDelivery(adapter: EvmAdapter | SolanaAdapter): Pick<ExecutionPlan, "broadcast" | "recover"> {
    return {
      broadcast: async (signed) => { await adapter.broadcast(signed); },
      recover: async (signed) => {
        const status = await adapter.broadcastStatus(signed);
        if (status.state === "seen") return { outcome: "settled" };
        if (status.state === "unseen_resendable") return { outcome: "resend" };
        return { outcome: "dead", reason: status.reason };
      }
    };
  }

  /** Compiles, simulates, and prepares the signer for the intent's governance kind. */
  private async buildExecution(context: ExecutionContext): Promise<{ failure: string } | ExecutionPlan> {
    const amount = BigInt(context.amountBaseUnits);
    if (context.kind === "x402") return this.buildX402(context);
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
        sign: (keys) => context.chainFamily === "evm"
          ? (adapter as EvmAdapter).signTransfer(request, keys.evm())
          : (adapter as SolanaAdapter).signTransfer(request, keys.solana()),
        ...this.chainDelivery(adapter)
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
        sign: (keys) => evm.signCall({ from: context.signerAddress, to: context.from, data }, keys.evm()),
        ...this.chainDelivery(evm)
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
      sign: (keys) => solana.signInstructions([execute.instruction], keys.solana(), [], execute.lookupTableAccounts),
      ...this.chainDelivery(solana)
    };
  }

  /**
   * x402: the "signed transaction" is the payment payload (an EIP-3009
   * authorization or a payer-signed Solana transaction), persisted before the
   * paid request. Broadcasting is the paid request itself; the settlement hash
   * comes back from the seller. A retry re-sends the same payload, which the
   * network can only honour once.
   */
  private async buildX402(context: ExecutionContext): Promise<{ failure: string } | ExecutionPlan> {
    const stored = context.x402 as { url?: string; method?: string; x402Version?: number; requirements?: X402Quote["requirements"]; resource?: X402Quote["resource"]; paymentRequired?: X402Quote["paymentRequired"] } | null;
    if (!stored?.url || !stored.requirements || !stored.paymentRequired || !stored.resource) return { failure: "Intent has no x402 quote" };
    const quote: X402Quote = { url: stored.url, method: stored.method ?? "GET", x402Version: stored.x402Version ?? 2, requirements: stored.requirements, resource: stored.resource, paymentRequired: stored.paymentRequired };
    if (X402PaymentClient.quoteHash(quote) !== context.approvalCompiledHash) return { failure: "x402 quote no longer matches the approved hash" };
    const client = await this.x402();
    const adapter = this.adapterFor(context.chainFamily, context.network);
    const price = BigInt(quote.requirements.amount);
    const balance = await adapter.getBalance(context.from, resolvedAsset(context.asset));
    if (balance < price) return { failure: `Insufficient token balance for the quoted price: ${balance} < ${price}` };
    const settlementOf = (transactionHash: string, observed: Record<string, unknown>): Settlement => ({ transactionHash, payTo: quote.requirements.payTo, amountBaseUnits: quote.requirements.amount, observed });
    const lookup = async (): Promise<Settlement | null> => {
      const found = context.chainFamily === "evm"
        ? await client.findEvmSettlement(context.asset.address ?? "", context.from, quote.requirements.payTo)
        : await client.findSolanaSettlement(context.asset.address ?? "", context.from, quote.requirements.payTo);
      return found ? settlementOf(found.transactionHash, { source: "chain_lookup", amount: found.amount.toString() }) : null;
    };
    return {
      feeBaseUnits: 0n,
      compiledPayload: { kind: "x402_exact", network: context.network, url: quote.url, method: quote.method, payTo: quote.requirements.payTo, settledAmountBaseUnits: quote.requirements.amount, assetId: context.assetId, wireNetwork: quote.requirements.network },
      compiledHash: context.approvalCompiledHash,
      sign: async (keys) => {
        const payload = await client.createPayload(quote, context.chainFamily === "evm" ? { evmAccount: keys.evm() } : { solanaSecretKey: keys.secret() });
        return { hash: X402PaymentClient.payloadId(payload), raw: JSON.stringify(payload), nonce: "", validUntil: "" };
      },
      broadcast: async (signed) => {
        const payload = JSON.parse(signed.raw) as PaymentPayload;
        const paid = await client.pay(quote, payload);
        if (paid.settle?.success && paid.settle.transaction) return settlementOf(paid.settle.transaction, { resourceStatus: paid.status, bodyHash: paid.bodyHash, contentType: paid.contentType, payer: paid.settle.payer ?? null });
        if (paid.status === 402) {
          // Refused: either never settled (fail cleanly) or settled earlier and the seller no longer honours the payload.
          const settled = await lookup();
          if (settled) return settled;
          throw new ExecutionRejected(`Seller refused the payment: ${paid.refusal ?? "unknown"}`);
        }
        throw new Error(`Seller responded ${paid.status} without a settlement`);
      },
      recover: async () => {
        const settled = await lookup();
        return settled ? { outcome: "settled", settlement: settled } : { outcome: "resend" };
      }
    };
  }

  // Executor rotation (Squads): the current executor proposes swapping itself for the new signer; members approve on chain.

  private async publishRotation(rotationId: string): Promise<void> {
    const rotation = await this.rotations.context(rotationId);
    if (rotation.status !== "publishing") return;
    if (rotation.governance !== "squads") throw new ExecutionRejected("Only Squads rotations need an on-chain proposal");
    const multisigPda = String(rotation.treasuryConfiguration.multisigPda ?? "");
    const squads = this.squads(rotation.network);
    const observed = await squads.observe(multisigPda);
    if (!observed.members.some((member) => member.key === rotation.fromAddress && member.canInitiate)) throw new ExecutionRejected("The current executor is no longer a member that can propose");
    let transactionIndex = observed.transactionIndex + 1n;
    const previous = rotation.publication?.transactionIndex ? BigInt(String(rotation.publication.transactionIndex)) : null;
    let alreadyPublished = false;
    if (previous !== null) {
      if (await squads.configPublishedBy(multisigPda, previous, rotation.fromAddress)) { transactionIndex = previous; alreadyPublished = true; }
      else if (previous > observed.transactionIndex) transactionIndex = previous;
    }
    const proposal = squads.prepareMemberSwap(multisigPda, new PublicKey(rotation.fromAddress), transactionIndex, { key: rotation.toAddress, role: "executor" }, rotation.fromAddress, `relay:rotation:${rotationId}`);
    if (!alreadyPublished) {
      await this.rotations.recordPublication(rotationId, { multisigPda, transactionIndex: transactionIndex.toString() });
      const signed = await this.withSigner(rotation.fromKey, "svm", (keys) => this.solana(rotation.network).signInstructions(proposal.instructions, keys.solana()));
      await this.solana(rotation.network).broadcast(signed);
      await squads.waitFor(signed.hash);
    }
    await this.rotations.published(rotationId, { kind: "squads_config", ...proposal.ref, threshold: observed.threshold, adds: rotation.toAddress, removes: rotation.fromAddress });
  }

  private async observeRotation(rotationId: string): Promise<void> {
    const rotation = await this.rotations.context(rotationId);
    if (rotation.status !== "approval_required" || !rotation.externalRef) return;
    const proposal = await this.squads(rotation.network).observeProposal(String(rotation.externalRef.multisigPda), BigInt(String(rotation.externalRef.transactionIndex)));
    if (!proposal) throw new Deferred("Rotation proposal not yet visible", 3);
    const outcome = proposal.status === "approved" ? "approved" : proposal.status === "rejected" || proposal.status === "cancelled" ? "rejected" : "pending";
    await this.rotations.observed(rotationId, outcome);
  }

  private async executeRotation(rotationId: string): Promise<void> {
    const rotation = await this.rotations.context(rotationId);
    if (rotation.status !== "executing" || !rotation.externalRef) return;
    const multisigPda = String(rotation.externalRef.multisigPda);
    const squads = this.squads(rotation.network);
    const membersNow = async () => (await squads.observe(multisigPda)).members;
    const swapped = (members: Awaited<ReturnType<typeof membersNow>>) => members.some((member) => member.key === rotation.toAddress) && !members.some((member) => member.key === rotation.fromAddress);
    // A retry after a crash may find the config change already applied.
    if (!swapped(await membersNow())) {
      const instruction = squads.prepareConfigExecute(multisigPda, BigInt(String(rotation.externalRef.transactionIndex)), new PublicKey(rotation.fromAddress));
      const signed = await this.withSigner(rotation.fromKey, "svm", (keys) => this.solana(rotation.network).signInstructions([instruction], keys.solana()));
      await this.solana(rotation.network).broadcast(signed);
      await squads.waitFor(signed.hash);
    }
    const members = await membersNow();
    if (!swapped(members)) throw new Error("Config transaction executed but the member set did not change");
    await this.rotations.complete(rotationId, { members });
  }

  /** Creates intents for recurring payments that are due. */
  enqueueSchedules(): Promise<number> {
    return this.operations.enqueueDueSchedules();
  }

  /**
   * Reads what arrived at a treasury since the last sync, books it (matching
   * invoices on the way), and compares the chain balance with the ledger.
   * The first sync of an asset books its current balance as the opening balance.
   */
  async syncTreasury(treasuryId: string): Promise<SyncResult> {
    const target = (await this.operations.listSyncTargets(this.configuredNetworks())).find((candidate) => candidate.treasuryId === treasuryId);
    if (!target) throw new Error(`Treasury ${treasuryId} is not active on a configured network`);
    const result: SyncResult = { treasuryId, assets: [] };
    for (const asset of target.assets) {
      const resolved = resolvedAsset({ id: asset.id, kind: asset.kind, address: asset.address, decimals: asset.decimals });
      const entry = { assetId: asset.id, opened: false, inflows: 0, reconciliation: null as string | null, error: null as string | null };
      result.assets.push(entry);
      try {
      const cursor = await this.operations.getCursor(treasuryId, asset.id);
      const record = async (inflows: Awaited<ReturnType<SolanaAdapter["scanInflows"]>>["inflows"]) => {
        for (const inflow of inflows) {
          const recorded = await this.operations.recordInflow({ organizationId: target.organizationId, treasuryAccountId: treasuryId, network: target.network, assetId: asset.id, transactionHash: inflow.transactionHash, eventKey: inflow.eventKey, amountBaseUnits: inflow.amountBaseUnits.toString(), fromAddress: inflow.from, blockCursor: inflow.blockCursor, ...(inflow.accountKeys ? { accountKeys: inflow.accountKeys } : {}) });
          if (recorded.created) entry.inflows += 1;
        }
      };
      if (target.chainFamily === "evm") {
        const evm = this.evm(target.network);
        const safeHead = await evm.safeHead();
        if (cursor === null) {
          entry.opened = await this.operations.openCursor({ organizationId: target.organizationId, treasuryId, assetId: asset.id, cursor: safeHead.toString(), chainBalanceBaseUnits: await evm.getBalanceAt(target.address, resolved, safeHead) });
        } else {
          const from = BigInt(cursor) + 1n;
          const to = [safeHead, BigInt(cursor) + BigInt(this.options.evmMaxBlocksPerSync ?? 2_000)].reduce((a, b) => (a < b ? a : b));
          if (from <= to) {
            await record(resolved.kind === "native" ? await evm.scanNativeInflows(target.address, from, to) : await evm.scanTokenInflows(resolved.kind === "erc20" ? resolved.address : "", target.address, from, to));
            await this.operations.advanceCursor(treasuryId, asset.id, to.toString());
          }
          if (to < safeHead) continue;
        }
        const reconciliation = await this.operations.recordReconciliation({ organizationId: target.organizationId, treasuryId, assetId: asset.id, chainBalanceBaseUnits: await evm.getBalanceAt(target.address, resolved, safeHead) });
        entry.reconciliation = reconciliation.status;
        continue;
      }
      const solana = this.solana(target.network);
      const watched = solana.watchAddress(target.address, resolved);
      let newest: string | null;
      if (cursor === null) {
        const opening = await solana.getFinalizedBalance(target.address, resolved);
        newest = await solana.signatureAtOrBefore(watched, opening.slot);
        entry.opened = await this.operations.openCursor({ organizationId: target.organizationId, treasuryId, assetId: asset.id, cursor: newest ?? "none", chainBalanceBaseUnits: opening.balance });
      } else {
        const scanned = await solana.scanInflows(target.address, resolved, cursor === "none" ? null : cursor);
        await record(scanned.inflows);
        newest = scanned.newest;
        if (newest && newest !== cursor) await this.operations.advanceCursor(treasuryId, asset.id, newest);
      }
      const { balance } = await solana.getFinalizedBalance(target.address, resolved);
      // Only compare when nothing new landed between the scan and the balance read.
      if ((await solana.newestSignature(watched)) !== newest) { entry.reconciliation = "moving"; continue; }
      const reconciliation = await this.operations.recordReconciliation({ organizationId: target.organizationId, treasuryId, assetId: asset.id, chainBalanceBaseUnits: balance });
      entry.reconciliation = reconciliation.status;
      } catch (error) {
        // One unreadable asset (a token that is not a contract on this chain, an
        // RPC hiccup) must not stop the treasury's other assets from syncing.
        entry.error = error instanceof Error ? error.message.split("\n")[0]! : "Sync failed";
      }
    }
    return result;
  }

  private async confirm(intentId: string): Promise<void> {
    const context = await this.queue.getConfirmationContext(intentId);
    const adapter = this.adapterFor(context.chainFamily, context.network);
    const asset = resolvedAsset(context.asset);
    let receipt;
    try {
      receipt = await adapter.waitForTransaction(context.transactionHash, { to: context.to, asset, amountBaseUnits: BigInt(context.amountBaseUnits), from: context.from });
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

/**
 * Re-wraps every software signer's data key under the provider's active key.
 * Legacy envelopes sealed directly under a master key are upgraded to format 2.
 * Envelopes the provider cannot open are counted and left untouched, so one
 * bad row never blocks the rest. Safe to run repeatedly and concurrently; a
 * row is replaced only if it is unchanged since it was read.
 */
export async function rotateKeyEncryption(store: PostgresControlPlaneStore, provider: KeyEncryptionProvider, options: { batchSize?: number; organizationId?: string; onProgress?: (done: number) => void } = {}): Promise<{ rewrapped: number; failed: { signerId: string; reason: string }[] }> {
  let rewrapped = 0;
  const failed: { signerId: string; reason: string }[] = [];
  let afterId: string | undefined;
  for (;;) {
    const batch = await store.listSignersToRewrap(provider.activeVersion, { limit: options.batchSize ?? 100, ...(afterId ? { afterId } : {}), ...(options.organizationId ? { organizationId: options.organizationId } : {}) });
    if (batch.length === 0) break;
    for (const signer of batch) {
      afterId = signer.id;
      try {
        if (!signer.encryptedSecret || !signer.encryptionNonce || !signer.authTag) throw new Error("Envelope is incomplete");
        const sealed = await rewrapSecret({ ciphertext: signer.encryptedSecret, nonce: signer.encryptionNonce, authTag: signer.authTag, keyVersion: signer.keyVersion, dataKey: signer.dataKey, dataKeyVersion: signer.dataKeyVersion }, provider);
        if (await store.replaceSignerEnvelope(signer.id, { dataKey: signer.dataKey, encryptedSecret: signer.encryptedSecret }, sealed)) rewrapped += 1;
      } catch (error) {
        failed.push({ signerId: signer.id, reason: error instanceof Error ? error.message : String(error) });
      }
      options.onProgress?.(rewrapped);
    }
  }
  return { rewrapped, failed };
}

export function createWorker(databaseUrl: string, chainConfig?: WorkerChainConfig, hooks?: WorkerHooks, options?: WorkerOptions): { worker: DurableWorker; queue: PostgresJobQueue; close: () => Promise<void> } {
  const queue = createPostgresJobQueue(databaseUrl);
  return { worker: new DurableWorker(queue, chainConfig, undefined, hooks, options), queue, close: () => queue.close() };
}
