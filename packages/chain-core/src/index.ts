export type ChainFamily = "evm" | "svm";

export interface AdapterHealth {
  ok: boolean;
  family: ChainFamily;
  network: string;
  blockHeight: bigint;
}

export interface NativeTransferRequest {
  from: string;
  to: string;
  amountBaseUnits: bigint;
  idempotencyKey: string;
}

export interface TransferSimulation {
  ok: boolean;
  feeBaseUnits: bigint;
  error?: string;
}

export interface SubmittedTransaction {
  hash: string;
  network: string;
}

export interface TransactionReceipt {
  hash: string;
  finalized: boolean;
  blockHeight: bigint;
  feeBaseUnits: bigint;
}

export interface ChainAdapter {
  readonly family: ChainFamily;
  readonly network: string;
  health(): Promise<AdapterHealth>;
  getNativeBalance(address: string): Promise<bigint>;
  simulateNativeTransfer(request: NativeTransferRequest): Promise<TransferSimulation>;
  waitForTransaction(hash: string): Promise<TransactionReceipt>;
}

export function assertPositiveTransfer(request: NativeTransferRequest): void {
  if (request.amountBaseUnits <= 0n) throw new Error("Transfer amount must be positive");
  if (request.from === request.to) throw new Error("Source and destination must differ");
  if (request.idempotencyKey.length < 8) throw new Error("Idempotency key is too short");
}
