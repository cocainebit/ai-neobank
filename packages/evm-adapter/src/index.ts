import type {
  AdapterHealth,
  BroadcastStatus,
  ChainAdapter,
  ObservedInflow,
  ResolvedAsset,
  SignedTransaction,
  SubmittedTransaction,
  TransactionReceipt,
  TransferRequest,
  TransferSimulation
} from "@ai-neobank/chain-core";
import { assertPositiveTransfer } from "@ai-neobank/chain-core";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbiItem,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerialized
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface EvmAdapterOptions {
  rpcUrl: string;
  chainId: number;
  network: `eip155:${number}`;
  /** Blocks on top of the inclusion block before a transaction counts as final. Anvil: 1. Base Sepolia: 3 or more. */
  confirmations?: number;
}

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export class EvmAdapter implements ChainAdapter {
  readonly family = "evm" as const;
  readonly network: `eip155:${number}`;
  readonly confirmations: number;
  private readonly chain;
  private readonly transport;
  private readonly publicClient;

  constructor(private readonly options: EvmAdapterOptions) {
    if (options.network !== `eip155:${options.chainId}`) {
      throw new Error("CAIP-2 network does not match EVM chain ID");
    }
    this.network = options.network;
    this.confirmations = options.confirmations ?? 1;
    this.chain = defineChain({
      id: options.chainId,
      name: options.network,
      nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } }
    });
    this.transport = http(options.rpcUrl);
    this.publicClient = createPublicClient({ chain: this.chain, transport: this.transport });
  }

  async health(): Promise<AdapterHealth> {
    const [chainId, blockHeight] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.getBlockNumber()
    ]);
    return { ok: chainId === this.options.chainId, family: this.family, network: this.network, blockHeight };
  }

  getNativeBalance(address: string): Promise<bigint> {
    return this.publicClient.getBalance({ address: address as Address });
  }

  async getBalance(address: string, asset: ResolvedAsset): Promise<bigint> {
    if (asset.kind === "native") return this.getNativeBalance(address);
    if (asset.kind !== "erc20") throw new Error(`Asset kind ${asset.kind} is not an EVM asset`);
    return this.publicClient.readContract({ address: asset.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] });
  }

  /** Reads ERC-20 decimals from the contract so the registry can be checked against chain truth. */
  async readTokenDecimals(tokenAddress: string): Promise<number> {
    return this.publicClient.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: "decimals" });
  }

  private call(request: TransferRequest): { to: Address; value: bigint; data?: Hex } {
    if (request.asset.kind === "native") return { to: request.to as Address, value: request.amountBaseUnits };
    if (request.asset.kind !== "erc20") throw new Error(`Asset kind ${request.asset.kind} is not an EVM asset`);
    return {
      to: request.asset.address as Address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.to as Address, request.amountBaseUnits] })
    };
  }

  async simulateTransfer(request: TransferRequest): Promise<TransferSimulation> {
    assertPositiveTransfer(request);
    try {
      const call = this.call(request);
      if (request.asset.kind === "erc20") {
        // Reverts here surface a real reason (insufficient balance) instead of a gas estimate failure.
        await this.publicClient.simulateContract({
          address: request.asset.address as Address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [request.to as Address, request.amountBaseUnits],
          account: request.from as Address
        });
      }
      const [gas, fees] = await Promise.all([
        this.publicClient.estimateGas({ account: request.from as Address, ...call }),
        this.publicClient.estimateFeesPerGas()
      ]);
      return { ok: true, feeBaseUnits: gas * fees.maxFeePerGas };
    } catch (error) {
      return { ok: false, feeBaseUnits: 0n, error: error instanceof Error ? error.message : "Unknown simulation error" };
    }
  }

  /** Signs without sending. The returned hash is the keccak of the signed bytes, so it is known before broadcast. */
  async signTransfer(request: TransferRequest, signer: Hex | LocalAccount): Promise<SignedTransaction> {
    assertPositiveTransfer(request);
    return this.signCall({ from: request.from, ...this.call(request) }, signer);
  }

  /** Signs an arbitrary call from the key's account, for example a Safe execTransaction. */
  async signCall(call: { from: string; to: string; value?: bigint; data?: Hex }, signer: Hex | LocalAccount): Promise<SignedTransaction> {
    // A raw key for development signers, or an account whose key lives elsewhere (KMS).
    const account = typeof signer === "string" ? privateKeyToAccount(signer) : signer;
    if (account.address.toLowerCase() !== call.from.toLowerCase()) {
      throw new Error("Signer does not match call sender");
    }
    const prepared = await this.publicClient.prepareTransactionRequest({ account, chain: this.chain, to: call.to as Address, value: call.value ?? 0n, ...(call.data ? { data: call.data } : {}) });
    const raw = await account.signTransaction(prepared as Parameters<typeof account.signTransaction>[0]);
    return { hash: keccak256(raw), raw, nonce: String(prepared.nonce), validUntil: "" };
  }

  /** Simulates an arbitrary call and returns the fee estimate in wei. */
  async simulateCall(call: { from: string; to: string; value?: bigint; data?: Hex }): Promise<TransferSimulation> {
    try {
      const [gas, fees] = await Promise.all([
        this.publicClient.estimateGas({ account: call.from as Address, to: call.to as Address, value: call.value ?? 0n, ...(call.data ? { data: call.data } : {}) }),
        this.publicClient.estimateFeesPerGas()
      ]);
      return { ok: true, feeBaseUnits: gas * fees.maxFeePerGas };
    } catch (error) {
      return { ok: false, feeBaseUnits: 0n, error: error instanceof Error ? error.message : "Unknown simulation error" };
    }
  }

  /** The EIP-712 name and version an EIP-3009 token signs under (USDC on Base: "USD Coin", "2"). */
  async readEip712Domain(token: string): Promise<{ name: string; version: string }> {
    const address = token as Address;
    const name = await this.publicClient.readContract({ address, abi: [parseAbiItem("function name() view returns (string)")], functionName: "name" });
    const version = await this.publicClient.readContract({ address, abi: [parseAbiItem("function version() view returns (string)")], functionName: "version" }).catch(() => "1");
    return { name, version };
  }

  /** Highest block considered final under this adapter's confirmation rule. */
  async safeHead(): Promise<bigint> {
    const head = await this.publicClient.getBlockNumber();
    const safe = head - BigInt(this.confirmations) + 1n;
    return safe < 0n ? 0n : safe;
  }

  /** Balance of an asset at a block. */
  async getBalanceAt(address: string, asset: ResolvedAsset, blockNumber: bigint): Promise<bigint> {
    if (asset.kind === "native") return this.balanceAt(address, blockNumber);
    if (asset.kind !== "erc20") throw new Error(`Asset kind ${asset.kind} is not an EVM asset`);
    return this.publicClient.readContract({ address: asset.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address as Address], blockNumber });
  }

  /** ERC-20 transfers into `to` within an inclusive block range. */
  async scanTokenInflows(token: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<ObservedInflow[]> {
    if (fromBlock > toBlock) return [];
    const logs = await this.publicClient.getLogs({ address: token as Address, event: transferEvent, args: { to: to as Address }, fromBlock, toBlock });
    return logs
      .filter((log) => (log.args.value ?? 0n) > 0n && !log.removed)
      .map((log) => ({ transactionHash: log.transactionHash, eventKey: `log:${log.logIndex}`, amountBaseUnits: log.args.value ?? 0n, from: log.args.from ?? null, blockCursor: String(log.blockNumber) }));
  }

  /**
   * Native value sent directly to `to` by top-level transactions in the range.
   * Value moved by contracts (internal transfers) is not visible here and shows
   * up as a reconciliation difference instead.
   */
  async scanNativeInflows(to: string, fromBlock: bigint, toBlock: bigint): Promise<ObservedInflow[]> {
    const found: ObservedInflow[] = [];
    const target = to.toLowerCase();
    for (let number = fromBlock; number <= toBlock; number += 1n) {
      const block = await this.publicClient.getBlock({ blockNumber: number, includeTransactions: true });
      for (const transaction of block.transactions) {
        if (transaction.to?.toLowerCase() !== target || transaction.value === 0n) continue;
        const receipt = await this.publicClient.getTransactionReceipt({ hash: transaction.hash });
        if (receipt.status !== "success") continue;
        found.push({ transactionHash: transaction.hash, eventKey: "native", amountBaseUnits: transaction.value, from: transaction.from, blockCursor: String(number) });
      }
    }
    return found;
  }

  /** Native balance at a specific block; used to prove internal transfers made by a contract such as a Safe. */
  balanceAt(address: string, blockNumber: bigint): Promise<bigint> {
    return this.publicClient.getBalance({ address: address as Address, blockNumber });
  }

  async broadcast(signed: SignedTransaction): Promise<SubmittedTransaction> {
    const hash = await this.publicClient.sendRawTransaction({ serializedTransaction: signed.raw as TransactionSerialized });
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error("Broadcast hash differs from signed hash");
    return { hash, network: this.network };
  }

  async broadcastStatus(signed: SignedTransaction): Promise<BroadcastStatus> {
    const seen = await this.publicClient.getTransaction({ hash: signed.hash as Hex }).catch(() => null);
    if (seen) return { state: "seen" };
    const sender = await recoverTransactionAddress({ serializedTransaction: signed.raw as TransactionSerialized });
    const nextNonce = await this.publicClient.getTransactionCount({ address: sender, blockTag: "latest" });
    if (nextNonce > Number(signed.nonce)) return { state: "unseen_dead", reason: `Nonce ${signed.nonce} was consumed by another transaction` };
    return { state: "unseen_resendable" };
  }

  async waitForTransaction(hash: string, expected?: { to: string; asset: ResolvedAsset; amountBaseUnits: bigint; from?: string }): Promise<TransactionReceipt> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
    if (!receipt) {
      const pendingTransaction = await this.publicClient.getTransaction({ hash: hash as Hex }).catch(() => null);
      if (!pendingTransaction) throw new Error("Transaction is not known to the node");
      return { hash, finalized: false, pending: true, failed: false, blockHeight: 0n, confirmations: 0, feeBaseUnits: 0n };
    }
    const head = await this.publicClient.getBlockNumber();
    const confirmations = Number(head - receipt.blockNumber + 1n);
    const failed = receipt.status !== "success";
    const finalized = !failed && confirmations >= this.confirmations;
    const result: TransactionReceipt = {
      hash,
      finalized,
      pending: !failed && !finalized,
      failed,
      blockHeight: receipt.blockNumber,
      confirmations,
      feeBaseUnits: receipt.gasUsed * receipt.effectiveGasPrice
    };
    if (expected && !failed) {
      if (expected.asset.kind === "native") {
        const transaction = await this.publicClient.getTransaction({ hash: hash as Hex });
        if (transaction.to?.toLowerCase() === expected.to.toLowerCase()) {
          result.destinationDeltaBaseUnits = transaction.value;
        } else {
          // Value moved inside a contract call (Safe execTransaction): prove it from the balance change across the block.
          const [before, after] = await Promise.all([
            this.balanceAt(expected.to, receipt.blockNumber - 1n),
            this.balanceAt(expected.to, receipt.blockNumber)
          ]);
          result.destinationDeltaBaseUnits = after - before;
        }
      } else if (expected.asset.kind === "erc20") {
        const token = expected.asset.address.toLowerCase();
        let delta = 0n;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== token) continue;
          try {
            const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
            if (decoded.args.to.toLowerCase() === expected.to.toLowerCase()) delta += decoded.args.value;
          } catch { /* not a Transfer log */ }
        }
        result.destinationDeltaBaseUnits = delta;
      }
    }
    return result;
  }
}
