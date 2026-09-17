export type ChainFamily = "evm" | "svm";

export interface AdapterHealth {
  ok: boolean;
  family: ChainFamily;
  network: string;
  blockHeight: bigint;
}

/** What the compiler resolved the intent's asset to. */
export type ResolvedAsset =
  | { kind: "native"; decimals: number }
  | { kind: "erc20"; address: string; decimals: number }
  | { kind: "spl"; mint: string; decimals: number };

export interface TransferRequest {
  from: string;
  to: string;
  asset: ResolvedAsset;
  amountBaseUnits: bigint;
  idempotencyKey: string;
}

/** Kept for callers that only move the native coin. */
export interface NativeTransferRequest {
  from: string;
  to: string;
  amountBaseUnits: bigint;
  idempotencyKey: string;
}

export interface TransferSimulation {
  ok: boolean;
  /** Fee in the network's native base units (wei / lamports). */
  feeBaseUnits: bigint;
  error?: string;
}

/**
 * A fully signed transaction that has not been broadcast. The hash is known
 * before sending, so it can be persisted first and recovered after a crash.
 */
export interface SignedTransaction {
  hash: string;
  /** Raw signed bytes: 0x-hex for EVM, base64 for Solana. */
  raw: string;
  /** EVM account nonce; Solana recent blockhash. */
  nonce: string;
  /** Solana last valid block height; empty for EVM. */
  validUntil: string;
}

export interface SubmittedTransaction {
  hash: string;
  network: string;
}

export interface TransactionReceipt {
  hash: string;
  /** True only once the adapter's finality rule is met (confirmation depth or finalized commitment). */
  finalized: boolean;
  /** True when the transaction is on chain but not yet final; callers should retry later. */
  pending: boolean;
  /** True when the transaction executed but reverted or errored. */
  failed: boolean;
  blockHeight: bigint;
  confirmations: number;
  feeBaseUnits: bigint;
  /** Amount the destination observably received for the transfer, in the transferred asset's base units, when derivable. */
  destinationDeltaBaseUnits?: bigint;
  /** Native base units that left `expected.from` in this transaction (fees, rent, and native value), when derivable. */
  sourceNativeSpentBaseUnits?: bigint;
}

/** One observed receipt into a watched address. */
export interface ObservedInflow {
  transactionHash: string;
  /** Distinguishes several receipts in one transaction (log index, or "native"). */
  eventKey: string;
  amountBaseUnits: bigint;
  from: string | null;
  blockCursor: string;
  /** Solana: every account key in the transaction, for Solana Pay reference matching. */
  accountKeys?: string[];
}

/** Outcome of asking the chain about a signed transaction that may never have been sent. */
export type BroadcastStatus =
  | { state: "seen" }
  | { state: "unseen_resendable" }
  | { state: "unseen_dead"; reason: string };

export interface ChainAdapter {
  readonly family: ChainFamily;
  readonly network: string;
  health(): Promise<AdapterHealth>;
  getNativeBalance(address: string): Promise<bigint>;
  getBalance(address: string, asset: ResolvedAsset): Promise<bigint>;
  simulateTransfer(request: TransferRequest): Promise<TransferSimulation>;
  broadcast(signed: SignedTransaction): Promise<SubmittedTransaction>;
  /** Resolves whether a signed-but-possibly-unsent transaction landed, can still be resent, or can never land. */
  broadcastStatus(signed: SignedTransaction): Promise<BroadcastStatus>;
  waitForTransaction(hash: string, expected?: { to: string; asset: ResolvedAsset; amountBaseUnits: bigint; from?: string }): Promise<TransactionReceipt>;
}

export function assertPositiveTransfer(request: { from: string; to: string; amountBaseUnits: bigint; idempotencyKey: string }): void {
  if (request.amountBaseUnits <= 0n) throw new Error("Transfer amount must be positive");
  if (request.from === request.to) throw new Error("Source and destination must differ");
  if (request.idempotencyKey.length < 8) throw new Error("Idempotency key is too short");
}
