import { createPostgresJobQueue, Deferred, ExecutionRejected, type ExecutionContext, type JobRecord, type PostgresJobQueue, type SimulationEvidence } from "@ai-neobank/database";
import type { ChainAdapter, ResolvedAsset, SignedTransaction, TransferRequest } from "@ai-neobank/chain-core";
import { EvmAdapter } from "@ai-neobank/evm-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { decryptSecret } from "@ai-neobank/signer";
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";

export interface WorkerChainConfig {
  signerMasterKey: Uint8Array;
  evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string; confirmations?: number };
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
    switch (job.type) {
      case "intent.evaluate": return this.queue.evaluateIntent(this.intentIdOf(job), this.chainConfig ? (input) => this.simulate(input) : undefined);
      case "approval.expire": return this.queue.expireApproval(this.intentIdOf(job));
      case "transaction.execute": return this.execute(this.intentIdOf(job));
      case "transaction.confirm": return this.confirm(this.intentIdOf(job));
      default: throw new Error(`No handler registered for ${job.type}`);
    }
  }

  adapterFor(chainFamily: "evm" | "svm", network: string): ChainAdapter & { signTransfer(request: TransferRequest, key: never): Promise<SignedTransaction> } {
    if (!this.chainConfig) throw new Error("Chain execution is not configured");
    if (chainFamily === "evm") {
      const config = this.chainConfig.evm;
      if (!config || config.network !== network) throw new Error(`No EVM adapter configured for ${network}`);
      return new EvmAdapter(config) as never;
    }
    const config = this.chainConfig.solana;
    if (!config || config.network !== network) throw new Error(`No Solana adapter configured for ${network}`);
    return new SolanaAdapter(config) as never;
  }

  private async simulate(input: Parameters<NonNullable<Parameters<PostgresJobQueue["evaluateIntent"]>[1]>>[0]): Promise<SimulationEvidence> {
    const adapter = this.adapterFor(input.chainFamily, input.network);
    const asset = resolvedAsset(input.asset);
    const [simulation, balance] = await Promise.all([
      adapter.simulateTransfer({ from: input.from, to: input.to, asset, amountBaseUnits: BigInt(input.amountBaseUnits), idempotencyKey: input.intentId }),
      adapter.getBalance(input.from, asset).catch(() => null)
    ]);
    const evidence: SimulationEvidence = { ok: simulation.ok, feeBaseUnits: simulation.feeBaseUnits.toString(), sourceBalanceBaseUnits: balance?.toString() ?? "unknown" };
    if (simulation.error) evidence.error = simulation.error;
    if (simulation.ok && balance !== null && balance < BigInt(input.amountBaseUnits)) {
      evidence.ok = false;
      evidence.error = `Insufficient balance: ${balance} < ${input.amountBaseUnits}`;
    }
    return evidence;
  }

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
    const compiledHash = createHash("sha256").update([context.intentId, context.network, context.assetId, context.amountBaseUnits, context.to, "transfer"].join("|")).digest("hex");
    if (compiledHash !== context.approvalCompiledHash) { await this.queue.markFailed(intentId, "Compiled payload no longer matches the approved hash"); return; }
    const request: TransferRequest = { from: context.from, to: context.to, asset: resolvedAsset(context.asset), amountBaseUnits: BigInt(context.amountBaseUnits), idempotencyKey: context.intentId };

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

    const simulation = await adapter.simulateTransfer(request);
    if (!simulation.ok) { await this.queue.markFailed(intentId, `Simulation failed before signing: ${simulation.error ?? "unknown"}`); return; }
    const compiledPayload = { kind: `${context.asset.kind}_transfer`, network: context.network, from: context.from, to: context.to, assetId: context.assetId, amountBaseUnits: context.amountBaseUnits };
    const executionId = context.execution?.id ?? await this.queue.recordSimulation(context, simulation.feeBaseUnits, compiledPayload, compiledHash);

    const secret = decryptSecret({ ciphertext: context.encryptedSecret, nonce: context.encryptionNonce, authTag: context.authTag, keyVersion: context.keyVersion }, this.chainConfig.signerMasterKey);
    let signed: SignedTransaction;
    try {
      signed = context.chainFamily === "evm"
        ? await (adapter as unknown as EvmAdapter).signTransfer(request, `0x${Buffer.from(secret).toString("hex")}`)
        : await (adapter as unknown as SolanaAdapter).signTransfer(request, Keypair.fromSecretKey(secret));
    } finally {
      secret.fill(0);
    }
    await this.queue.markSigned(executionId, signed);
    if (this.hooks.beforeBroadcast) await this.hooks.beforeBroadcast(context, signed);
    await adapter.broadcast(signed);
    await this.queue.markSubmitted(intentId, executionId);
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
