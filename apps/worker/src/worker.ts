import { createPostgresJobQueue, type JobRecord, type PostgresJobQueue } from "@ai-neobank/database";
import { EvmAdapter } from "@ai-neobank/evm-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { decryptSecret } from "@ai-neobank/signer";
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";

export interface WorkerChainConfig {
  signerMasterKey: Uint8Array;
  evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string };
  solana?: { network: `solana:${string}`; rpcUrl: string };
}

export class DurableWorker {
  constructor(private readonly queue: PostgresJobQueue, private readonly chainConfig?: WorkerChainConfig, private readonly workerId = crypto.randomUUID()) {}

  async runOnce(): Promise<boolean> {
    await this.queue.pumpOutbox();
    const job = await this.queue.claim(this.workerId);
    if (!job) return false;
    try {
      await this.handle(job);
      await this.queue.complete(job.id);
    } catch (error) {
      await this.queue.fail(job, error);
    }
    return true;
  }

  private async handle(job: JobRecord): Promise<void> {
    if (job.type === "intent.evaluate") {
      const intentId = job.payload.intentId;
      if (typeof intentId !== "string") throw new Error("intent.evaluate requires intentId");
      await this.queue.evaluateIntent(intentId);
      return;
    }
    if (job.type === "approval.expire") {
      const intentId = job.payload.intentId;
      if (typeof intentId !== "string") throw new Error("approval.expire requires intentId");
      await this.queue.expireApproval(intentId);
      return;
    }
    if (job.type === "transaction.execute") {
      const intentId = job.payload.intentId;
      if (typeof intentId !== "string") throw new Error("transaction.execute requires intentId");
      await this.execute(intentId);
      return;
    }
    if (job.type === "transaction.confirm") {
      const intentId = job.payload.intentId;
      if (typeof intentId !== "string") throw new Error("transaction.confirm requires intentId");
      await this.confirm(intentId);
      return;
    }
    throw new Error(`No handler registered for ${job.type}`);
  }

  private async execute(intentId: string): Promise<void> {
    if (!this.chainConfig) throw new Error("Chain execution is not configured");
    const context = await this.queue.getExecutionContext(intentId);
    const compiledHash = createHash("sha256").update([context.intentId, context.network, context.assetId, context.amountBaseUnits, context.to, "transfer"].join("|")).digest("hex");
    if (compiledHash !== context.approvalCompiledHash) throw new Error("Compiled payload no longer matches approved hash");
    const request = { from: context.from, to: context.to, amountBaseUnits: BigInt(context.amountBaseUnits), idempotencyKey: context.intentId };
    const secret = decryptSecret({ ciphertext: context.encryptedSecret, nonce: context.encryptionNonce, authTag: context.authTag, keyVersion: context.keyVersion }, this.chainConfig.signerMasterKey);
    const compiledPayload = { kind: "native_transfer", network: context.network, from: context.from, to: context.to, amountBaseUnits: context.amountBaseUnits };
    try {
      if (context.chainFamily === "evm") {
        const config = this.chainConfig.evm;
        if (!config || config.network !== context.network) throw new Error(`No EVM adapter configured for ${context.network}`);
        const adapter = new EvmAdapter(config);
        const simulation = await adapter.simulateNativeTransfer(request);
        if (!simulation.ok) throw new Error(`EVM simulation failed: ${simulation.error ?? "unknown"}`);
        const executionId = await this.queue.recordSimulation(context, simulation.feeBaseUnits, compiledPayload, compiledHash);
        const transaction = await adapter.sendNativeTransfer(request, `0x${Buffer.from(secret).toString("hex")}`);
        await this.queue.markSubmitted(intentId, executionId, transaction.hash);
      } else {
        const config = this.chainConfig.solana;
        if (!config || config.network !== context.network) throw new Error(`No Solana adapter configured for ${context.network}`);
        const adapter = new SolanaAdapter(config);
        const simulation = await adapter.simulateNativeTransfer(request);
        if (!simulation.ok) throw new Error(`Solana simulation failed: ${simulation.error ?? "unknown"}`);
        const executionId = await this.queue.recordSimulation(context, simulation.feeBaseUnits, compiledPayload, compiledHash);
        const transaction = await adapter.sendNativeTransfer(request, Keypair.fromSecretKey(secret));
        await this.queue.markSubmitted(intentId, executionId, transaction.hash);
      }
    } finally {
      secret.fill(0);
    }
  }

  private async confirm(intentId: string): Promise<void> {
    if (!this.chainConfig) throw new Error("Chain confirmation is not configured");
    const context = await this.queue.getConfirmationContext(intentId);
    const adapter = context.chainFamily === "evm"
      ? this.chainConfig.evm && new EvmAdapter(this.chainConfig.evm)
      : this.chainConfig.solana && new SolanaAdapter(this.chainConfig.solana);
    if (!adapter || adapter.network !== context.network) throw new Error(`No adapter configured for ${context.network}`);
    const receipt = await adapter.waitForTransaction(context.transactionHash);
    if (!receipt.finalized) throw new Error("Transaction did not finalize successfully");
    await this.queue.markFinalized(context, receipt);
  }
}

export function createWorker(databaseUrl: string, chainConfig?: WorkerChainConfig): { worker: DurableWorker; close: () => Promise<void> } {
  const queue = createPostgresJobQueue(databaseUrl);
  return { worker: new DurableWorker(queue, chainConfig), close: () => queue.close() };
}
