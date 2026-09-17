import type {
  AdapterHealth,
  BroadcastStatus,
  ChainAdapter,
  ResolvedAsset,
  SignedTransaction,
  SubmittedTransaction,
  TransactionReceipt,
  TransferRequest,
  TransferSimulation
} from "@ai-neobank/chain-core";
import { assertPositiveTransfer } from "@ai-neobank/chain-core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint
} from "@solana/spl-token";
import bs58 from "bs58";

export interface SolanaAdapterOptions {
  rpcUrl: string;
  network: `solana:${string}`;
  /** Commitment for reads and preflight. */
  commitment?: "confirmed" | "finalized";
  /** Commitment at which a transaction counts as final. Defaults to finalized. */
  finality?: "confirmed" | "finalized";
}

const commitmentRank: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

export class SolanaAdapter implements ChainAdapter {
  readonly family = "svm" as const;
  readonly network: `solana:${string}`;
  readonly finality: "confirmed" | "finalized";
  private readonly connection: Connection;
  private readonly commitment: "confirmed" | "finalized";

  constructor(options: SolanaAdapterOptions) {
    this.network = options.network;
    this.commitment = options.commitment ?? "confirmed";
    this.finality = options.finality ?? "finalized";
    this.connection = new Connection(options.rpcUrl, this.commitment);
  }

  async health(): Promise<AdapterHealth> {
    const blockHeight = await this.connection.getBlockHeight(this.commitment);
    return { ok: true, family: this.family, network: this.network, blockHeight: BigInt(blockHeight) };
  }

  async getNativeBalance(address: string): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(address), this.commitment));
  }

  async getBalance(address: string, asset: ResolvedAsset): Promise<bigint> {
    if (asset.kind === "native") return this.getNativeBalance(address);
    if (asset.kind !== "spl") throw new Error(`Asset kind ${asset.kind} is not a Solana asset`);
    const ata = getAssociatedTokenAddressSync(new PublicKey(asset.mint), new PublicKey(address), true);
    const info = await this.connection.getAccountInfo(ata, this.commitment);
    if (!info) return 0n;
    const balance = await this.connection.getTokenAccountBalance(ata, this.commitment);
    return BigInt(balance.value.amount);
  }

  /** Reads mint decimals from chain so the registry can be checked against chain truth. */
  async readMintDecimals(mint: string): Promise<number> {
    return (await getMint(this.connection, new PublicKey(mint), this.commitment)).decimals;
  }

  private async build(request: TransferRequest): Promise<Transaction> {
    const from = new PublicKey(request.from);
    const to = new PublicKey(request.to);
    const transaction = new Transaction();
    if (request.asset.kind === "native") {
      transaction.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: request.amountBaseUnits }));
    } else if (request.asset.kind === "spl") {
      const mint = new PublicKey(request.asset.mint);
      const source = getAssociatedTokenAddressSync(mint, from, true);
      const destination = getAssociatedTokenAddressSync(mint, to, true);
      if (!(await this.connection.getAccountInfo(destination, this.commitment))) {
        transaction.add(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint));
      }
      transaction.add(createTransferCheckedInstruction(source, mint, destination, from, request.amountBaseUnits, request.asset.decimals));
    } else {
      throw new Error(`Asset kind ${request.asset.kind} is not a Solana asset`);
    }
    transaction.feePayer = from;
    return transaction;
  }

  async simulateTransfer(request: TransferRequest): Promise<TransferSimulation> {
    assertPositiveTransfer(request);
    try {
      const transaction = await this.build(request);
      const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
      transaction.recentBlockhash = blockhash;
      const message = transaction.compileMessage();
      const [fee, simulation] = await Promise.all([
        this.connection.getFeeForMessage(message, this.commitment),
        this.connection.simulateTransaction(transaction)
      ]);
      if (simulation.value.err) {
        return { ok: false, feeBaseUnits: BigInt(fee.value ?? 0), error: `Simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).slice(-3).join(" | ")}` };
      }
      return { ok: fee.value !== null, feeBaseUnits: BigInt(fee.value ?? 0) };
    } catch (error) {
      return { ok: false, feeBaseUnits: 0n, error: error instanceof Error ? error.message : "Unknown simulation error" };
    }
  }

  /** Signs without sending. The signature (transaction id) is known before broadcast. */
  async signTransfer(request: TransferRequest, signer: Keypair): Promise<SignedTransaction> {
    assertPositiveTransfer(request);
    if (signer.publicKey.toBase58() !== request.from) throw new Error("Signer does not match transfer source");
    const transaction = await this.build(request);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("finalized");
    transaction.recentBlockhash = blockhash;
    transaction.sign(signer);
    if (!transaction.signature) throw new Error("Transaction was not signed");
    return {
      hash: bs58.encode(transaction.signature),
      raw: transaction.serialize().toString("base64"),
      nonce: blockhash,
      validUntil: String(lastValidBlockHeight)
    };
  }

  async broadcast(signed: SignedTransaction): Promise<SubmittedTransaction> {
    const hash = await this.connection.sendRawTransaction(Buffer.from(signed.raw, "base64"), { preflightCommitment: this.commitment, maxRetries: 3 });
    if (hash !== signed.hash) throw new Error("Broadcast signature differs from signed signature");
    return { hash, network: this.network };
  }

  async broadcastStatus(signed: SignedTransaction): Promise<BroadcastStatus> {
    const statuses = await this.connection.getSignatureStatuses([signed.hash], { searchTransactionHistory: true });
    if (statuses.value[0]) return { state: "seen" };
    const valid = await this.connection.isBlockhashValid(signed.nonce, { commitment: this.commitment });
    if (valid.value) return { state: "unseen_resendable" };
    return { state: "unseen_dead", reason: "Blockhash expired before the transaction landed" };
  }

  async waitForTransaction(hash: string, expected?: { to: string; asset: ResolvedAsset; amountBaseUnits: bigint }): Promise<TransactionReceipt> {
    const statuses = await this.connection.getSignatureStatuses([hash], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (!status) throw new Error("Transaction is not known to the cluster");
    const failed = status.err !== null;
    const reached = commitmentRank[status.confirmationStatus ?? "processed"] ?? 0;
    const finalized = !failed && reached >= commitmentRank[this.finality]!;
    const result: TransactionReceipt = {
      hash,
      finalized,
      pending: !failed && !finalized,
      failed,
      blockHeight: BigInt(status.slot),
      confirmations: status.confirmations ?? (status.confirmationStatus === "finalized" ? 32 : 0),
      feeBaseUnits: 0n
    };
    if (!finalized && !failed) return result;
    const transaction = await this.connection.getTransaction(hash, { commitment: failed ? "confirmed" : this.finality, maxSupportedTransactionVersion: 0 });
    if (!transaction) return result;
    result.feeBaseUnits = BigInt(transaction.meta?.fee ?? 0);
    if (expected && transaction.meta && !failed) {
      const keys = transaction.transaction.message.getAccountKeys().staticAccountKeys.map((key) => key.toBase58());
      if (expected.asset.kind === "native") {
        const index = keys.indexOf(expected.to);
        if (index >= 0) result.destinationDeltaBaseUnits = BigInt(transaction.meta.postBalances[index] ?? 0) - BigInt(transaction.meta.preBalances[index] ?? 0);
      } else if (expected.asset.kind === "spl") {
        const find = (balances: typeof transaction.meta.postTokenBalances) =>
          balances?.find((balance) => balance.owner === expected.to && balance.mint === (expected.asset as { mint: string }).mint)?.uiTokenAmount.amount ?? "0";
        result.destinationDeltaBaseUnits = BigInt(find(transaction.meta.postTokenBalances)) - BigInt(find(transaction.meta.preTokenBalances));
      }
    }
    return result;
  }
}

export { Keypair };
