import Safe from "@safe-global/protocol-kit";
import { OperationType, type SafeTransaction } from "@safe-global/types-kit";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";

interface Artifact { abi: readonly unknown[]; bytecode: Hex }
const require = createRequire(import.meta.url);
const artifact = (path: string) => require(`@safe-global/safe-contracts/build/artifacts/contracts/${path}`) as Artifact;

export interface SafeContractAddresses {
  safeSingletonAddress: string;
  safeProxyFactoryAddress: string;
  multiSendAddress: string;
  multiSendCallOnlyAddress: string;
  fallbackHandlerAddress: string;
}

export interface SafeAccountObservation {
  address: string;
  owners: string[];
  threshold: number;
  nonce: number;
  balance: bigint;
  modules: string[];
  guard: string;
}

export interface SafeAdapterOptions {
  rpcUrl: string;
  chainId: number;
  contracts: SafeContractAddresses;
}

function contractNetworks(chainId: number, contracts: SafeContractAddresses) {
  return { [chainId.toString()]: contracts };
}

export async function deploySafeProtocolFixture(rpcUrl: string, chainId: number, deployerKey: Hex): Promise<SafeContractAddresses> {
  const chain = defineChain({ id: chainId, name: `safe-local-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(deployerKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const deploy = async (path: string): Promise<string> => {
    const value = artifact(path);
    const hash = await wallet.deployContract({ account, abi: value.abi as never, bytecode: value.bytecode });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress || receipt.status !== "success") throw new Error(`Failed to deploy ${path}`);
    return receipt.contractAddress;
  };
  return {
    safeSingletonAddress: await deploy("Safe.sol/Safe.json"),
    safeProxyFactoryAddress: await deploy("proxies/SafeProxyFactory.sol/SafeProxyFactory.json"),
    multiSendAddress: await deploy("libraries/MultiSend.sol/MultiSend.json"),
    multiSendCallOnlyAddress: await deploy("libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json"),
    fallbackHandlerAddress: await deploy("handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json")
  };
}

export class SafeGovernanceAdapter {
  private readonly networkConfig;
  constructor(private readonly options: SafeAdapterOptions) {
    this.networkConfig = contractNetworks(options.chainId, options.contracts);
  }

  async deploy(ownerPrivateKey: Hex, owners: string[], threshold: number, saltNonce: string = crypto.randomUUID()): Promise<{ address: string; transactionHash: string }> {
    if (threshold < 1 || threshold > owners.length) throw new Error("Invalid Safe threshold");
    if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) throw new Error("Safe owners must be unique");
    const kit = await Safe.init({
      provider: this.options.rpcUrl,
      signer: ownerPrivateKey,
      predictedSafe: { safeAccountConfig: { owners, threshold }, safeDeploymentConfig: { saltNonce, safeVersion: "1.4.1" } },
      contractNetworks: this.networkConfig
    });
    const address = await kit.getAddress();
    const deployment = await kit.createSafeDeploymentTransaction();
    const chain = defineChain({ id: this.options.chainId, name: `safe-${this.options.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [this.options.rpcUrl] } } });
    const account = privateKeyToAccount(ownerPrivateKey);
    const wallet = createWalletClient({ account, chain, transport: http(this.options.rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(this.options.rpcUrl) });
    const transactionHash = await wallet.sendTransaction({ account, to: deployment.to as Address, data: deployment.data as Hex, value: BigInt(deployment.value) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("Safe deployment transaction reverted");
    return { address, transactionHash };
  }

  private connect(safeAddress: string, signer?: Hex) {
    const config = signer
      ? { provider: this.options.rpcUrl, signer, safeAddress, contractNetworks: this.networkConfig }
      : { provider: this.options.rpcUrl, safeAddress, contractNetworks: this.networkConfig };
    return Safe.init(config);
  }

  async observe(safeAddress: string): Promise<SafeAccountObservation> {
    const kit = await this.connect(safeAddress);
    const [owners, threshold, nonce, balance, modules, guard] = await Promise.all([
      kit.getOwners(), kit.getThreshold(), kit.getNonce(), kit.getBalance(), kit.getModules(), kit.getGuard()
    ]);
    return { address: safeAddress, owners, threshold, nonce, balance, modules, guard };
  }

  async buildNativeTransfer(safeAddress: string, signer: Hex, to: string, amountBaseUnits: bigint): Promise<{ transaction: SafeTransaction; safeTransactionHash: string }> {
    if (amountBaseUnits <= 0n) throw new Error("Transfer amount must be positive");
    const kit = await this.connect(safeAddress, signer);
    const transaction = await kit.createTransaction({ transactions: [{ to, value: amountBaseUnits.toString(), data: "0x", operation: OperationType.Call }] });
    return { transaction, safeTransactionHash: await kit.getTransactionHash(transaction) };
  }

  async collectSignatures(safeAddress: string, transaction: SafeTransaction, safeTransactionHash: string, ownerPrivateKeys: Hex[]): Promise<SafeTransaction> {
    for (const ownerPrivateKey of ownerPrivateKeys) {
      const kit = await this.connect(safeAddress, ownerPrivateKey);
      transaction.addSignature(await kit.signHash(safeTransactionHash));
    }
    return transaction;
  }

  async execute(safeAddress: string, executorPrivateKey: Hex, transaction: SafeTransaction): Promise<{ transactionHash: string }> {
    const kit = await this.connect(safeAddress, executorPrivateKey);
    const result = await kit.executeTransaction(transaction);
    return { transactionHash: result.hash };
  }
}
