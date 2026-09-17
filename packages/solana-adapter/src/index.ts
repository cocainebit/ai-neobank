import type {
  AdapterHealth,
  ChainAdapter,
  NativeTransferRequest,
  SubmittedTransaction,
  TransactionReceipt,
  TransferSimulation
} from "@ai-neobank/chain-core";
import { assertPositiveTransfer } from "@ai-neobank/chain-core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";

export interface SolanaAdapterOptions {
  rpcUrl: string;
  network: `solana:${string}`;
  commitment?: "confirmed" | "finalized";
}

export class SolanaAdapter implements ChainAdapter {
  readonly family = "svm" as const;
  readonly network: `solana:${string}`;
  private readonly connection: Connection;
  private readonly commitment: "confirmed" | "finalized";

  constructor(options: SolanaAdapterOptions) {
    this.network = options.network;
    this.commitment = options.commitment ?? "confirmed";
    this.connection = new Connection(options.rpcUrl, this.commitment);
  }

  async health(): Promise<AdapterHealth> {
    const blockHeight = await this.connection.getBlockHeight(this.commitment);
    return { ok: true, family: this.family, network: this.network, blockHeight: BigInt(blockHeight) };
  }

  async getNativeBalance(address: string): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(address), this.commitment));
  }

  async simulateNativeTransfer(request: NativeTransferRequest): Promise<TransferSimulation> {
    assertPositiveTransfer(request);
    try {
      const transaction = new Transaction().add(SystemProgram.transfer({
        fromPubkey: new PublicKey(request.from),
        toPubkey: new PublicKey(request.to),
        lamports: request.amountBaseUnits
      }));
      const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new PublicKey(request.from);
      const fee = await this.connection.getFeeForMessage(transaction.compileMessage(), this.commitment);
      return { ok: fee.value !== null, feeBaseUnits: BigInt(fee.value ?? 0) };
    } catch (error) {
      return { ok: false, feeBaseUnits: 0n, error: error instanceof Error ? error.message : "Unknown simulation error" };
    }
  }

  async sendNativeTransfer(request: NativeTransferRequest, signer: Keypair): Promise<SubmittedTransaction> {
    assertPositiveTransfer(request);
    if (signer.publicKey.toBase58() !== request.from) throw new Error("Signer does not match transfer source");
    const transaction = new Transaction().add(SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(request.to),
      lamports: request.amountBaseUnits
    }));
    const hash = await sendAndConfirmTransaction(this.connection, transaction, [signer], {
      commitment: this.commitment
    });
    return { hash, network: this.network };
  }

  async waitForTransaction(hash: string): Promise<TransactionReceipt> {
    const transaction = await this.connection.getTransaction(hash, {
      commitment: this.commitment,
      maxSupportedTransactionVersion: 0
    });
    if (!transaction) throw new Error("Transaction was not found at requested commitment");
    return {
      hash,
      finalized: transaction.meta?.err === null,
      blockHeight: BigInt(transaction.slot),
      feeBaseUnits: BigInt(transaction.meta?.fee ?? 0)
    };
  }
}
