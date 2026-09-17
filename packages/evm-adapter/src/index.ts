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
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface EvmAdapterOptions {
  rpcUrl: string;
  chainId: number;
  network: `eip155:${number}`;
}

export class EvmAdapter implements ChainAdapter {
  readonly family = "evm" as const;
  readonly network: `eip155:${number}`;
  private readonly chain;
  private readonly transport;
  private readonly publicClient;

  constructor(private readonly options: EvmAdapterOptions) {
    if (options.network !== `eip155:${options.chainId}`) {
      throw new Error("CAIP-2 network does not match EVM chain ID");
    }
    this.network = options.network;
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

  async simulateNativeTransfer(request: NativeTransferRequest): Promise<TransferSimulation> {
    assertPositiveTransfer(request);
    try {
      const feeBaseUnits = await this.publicClient.estimateGas({
        account: request.from as Address,
        to: request.to as Address,
        value: request.amountBaseUnits
      });
      return { ok: true, feeBaseUnits };
    } catch (error) {
      return { ok: false, feeBaseUnits: 0n, error: error instanceof Error ? error.message : "Unknown simulation error" };
    }
  }

  async sendNativeTransfer(request: NativeTransferRequest, privateKey: Hex): Promise<SubmittedTransaction> {
    assertPositiveTransfer(request);
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== request.from.toLowerCase()) {
      throw new Error("Signer does not match transfer source");
    }
    const wallet = createWalletClient({ account, chain: this.chain, transport: this.transport });
    const hash = await wallet.sendTransaction({ account, to: request.to as Address, value: request.amountBaseUnits });
    return { hash, network: this.network };
  }

  async waitForTransaction(hash: string): Promise<TransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: hash as Hex });
    return {
      hash,
      finalized: receipt.status === "success",
      blockHeight: receipt.blockNumber,
      feeBaseUnits: receipt.gasUsed * receipt.effectiveGasPrice
    };
  }
}
