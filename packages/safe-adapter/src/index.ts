import Safe, { buildSignatureBytes, EthSafeSignature } from "@safe-global/protocol-kit";
import { OperationType, type SafeTransaction, type SafeTransactionData } from "@safe-global/types-kit";
import { concatHex, createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, getAddress, hashTypedData, http, parseAbi, recoverAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

/** Protocol Kit wants a numeric salt; a random 128-bit value keeps predicted addresses unique. */
const randomSaltNonce = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

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
  /** Required for networks without canonical Safe deployments (local chains). */
  contracts?: SafeContractAddresses;
}

/** The exact Safe transaction the owners sign; stored with the approval request. */
export interface CompiledSafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
  safeTxHash: string;
}

export interface OwnerSignature {
  owner: string;
  /** 65-byte hex signature over the Safe transaction hash. */
  signature: string;
}

const execTransactionAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)"
]);

export const safeTxTypes = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" }
  ]
} as const;

/** EIP-712 payload for a wallet's signTypedData; its digest is the Safe transaction hash. */
export function safeTypedData(chainId: number, safeAddress: string, compiled: CompiledSafeTransaction) {
  return {
    domain: { chainId, verifyingContract: safeAddress as Address },
    types: safeTxTypes,
    primaryType: "SafeTx" as const,
    message: {
      to: compiled.to as Address,
      value: BigInt(compiled.value),
      data: compiled.data as Hex,
      operation: compiled.operation,
      safeTxGas: BigInt(compiled.safeTxGas),
      baseGas: BigInt(compiled.baseGas),
      gasPrice: BigInt(compiled.gasPrice),
      gasToken: compiled.gasToken as Address,
      refundReceiver: compiled.refundReceiver as Address,
      nonce: BigInt(compiled.nonce)
    }
  };
}

/** The same payload with decimal strings instead of BigInts, safe for JSON and accepted by eth_signTypedData_v4. */
export function safeTypedDataJson(chainId: number, safeAddress: string, compiled: CompiledSafeTransaction) {
  const typed = safeTypedData(chainId, safeAddress, compiled);
  return {
    ...typed,
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...typed.types },
    message: { ...typed.message, value: typed.message.value.toString(), safeTxGas: typed.message.safeTxGas.toString(), baseGas: typed.message.baseGas.toString(), gasPrice: typed.message.gasPrice.toString(), nonce: typed.message.nonce.toString() }
  };
}

export const safeMessageTypes = {
  SafeMessage: [{ name: "message", type: "bytes" }]
} as const;

/**
 * What a Safe owner signs to make the Safe itself vouch for an arbitrary hash.
 * The Safe's fallback handler answers ERC-1271 for `dataHash` by checking owner
 * signatures over this SafeMessage, so this is how a Safe authorises an EIP-3009
 * payment it can never sign itself.
 */
export function safeMessageTypedData(chainId: number, safeAddress: string, dataHash: string) {
  return {
    domain: { chainId, verifyingContract: getAddress(safeAddress) },
    types: safeMessageTypes,
    primaryType: "SafeMessage" as const,
    // The fallback handler hashes abi.encode(dataHash), which for a bytes32 is the hash itself.
    message: { message: dataHash as Hex }
  };
}

/** The same payload as JSON, for eth_signTypedData_v4 in a browser wallet. */
export function safeMessageTypedDataJson(chainId: number, safeAddress: string, dataHash: string) {
  const typed = safeMessageTypedData(chainId, safeAddress, dataHash);
  return { ...typed, types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...typed.types } };
}

/** The digest an owner's wallet actually signs, and the hash the Safe checks signatures against. */
export function safeMessageHash(chainId: number, safeAddress: string, dataHash: string): Hex {
  return hashTypedData(safeMessageTypedData(chainId, safeAddress, dataHash));
}

/** Recovers the owner that signed a Safe message digest. */
export async function recoverSafeMessageSigner(messageHash: string, signature: string): Promise<string> {
  return recoverAddress({ hash: messageHash as Hex, signature: signature as Hex });
}

/**
 * Owner signatures concatenated the way `checkSignatures` expects: ascending by
 * owner address, 65 bytes each, with v normalised to 27/28.
 */
export function encodeSafeOwnerSignatures(signatures: OwnerSignature[]): Hex {
  const ordered = [...signatures].sort((a, b) => (getAddress(a.owner).toLowerCase() < getAddress(b.owner).toLowerCase() ? -1 : 1));
  const blob = concatHex(ordered.map((entry) => {
    const raw = entry.signature.startsWith("0x") ? entry.signature.slice(2) : entry.signature;
    if (raw.length !== 130) throw new Error(`Owner signature for ${entry.owner} is not 65 bytes`);
    let v = Number.parseInt(raw.slice(128), 16);
    if (v < 27) v += 27;
    return `0x${raw.slice(0, 128)}${v.toString(16).padStart(2, "0")}` as Hex;
  }));
  // A one-of-one Safe would otherwise produce exactly 65 bytes, which verifiers
  // read as an EOA signature and try to ecrecover. The Safe reads only the first
  // `threshold` 65-byte slots, so a trailing byte is ignored on chain and keeps
  // the blob unmistakably a contract signature.
  return blob.length === 132 ? `${blob}00` as Hex : blob;
}

/** Recovers the owner that signed the Safe transaction hash with signTypedData. */
export async function recoverSafeSigner(safeTxHash: string, signature: string): Promise<string> {
  return recoverAddress({ hash: safeTxHash as Hex, signature: signature as Hex });
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
  private readonly networkConfig: Record<string, SafeContractAddresses> | undefined;
  constructor(private readonly options: SafeAdapterOptions) {
    this.networkConfig = options.contracts ? { [options.chainId.toString()]: options.contracts } : undefined;
  }

  private kitConfig(extra: Record<string, unknown>) {
    return { provider: this.options.rpcUrl, ...extra, ...(this.networkConfig ? { contractNetworks: this.networkConfig } : {}) };
  }

  private async predictedKit(owners: string[], threshold: number, saltNonce: string) {
    if (threshold < 1 || threshold > owners.length) throw new Error("Invalid Safe threshold");
    if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) throw new Error("Safe owners must be unique");
    return Safe.init(this.kitConfig({ predictedSafe: { safeAccountConfig: { owners, threshold }, safeDeploymentConfig: { saltNonce, safeVersion: "1.4.1" } } }) as never);
  }

  /**
   * The address these owners, this threshold and this salt produce, whether or
   * not the Safe exists yet. Building the deployment transaction is refused once
   * the Safe is deployed, so a caller checking a Safe that is already on chain
   * against the plan that predicted it asks for the address on its own.
   */
  async predictAddress(owners: string[], threshold: number, saltNonce: string): Promise<string> {
    return (await this.predictedKit(owners, threshold, saltNonce)).getAddress();
  }

  /** Predicts the Safe address and returns the deployment transaction for any funded wallet to send. */
  async prepareDeployment(owners: string[], threshold: number, saltNonce: string = randomSaltNonce()): Promise<{ address: string; to: string; data: string; value: string; saltNonce: string }> {
    const kit = await this.predictedKit(owners, threshold, saltNonce);
    const deployment = await kit.createSafeDeploymentTransaction();
    return { address: await kit.getAddress(), to: deployment.to, data: deployment.data, value: deployment.value, saltNonce };
  }

  /** Deploys with a locally held key; for tests and tooling only. */
  async deploy(deployerPrivateKey: Hex, owners: string[], threshold: number, saltNonce: string = randomSaltNonce()): Promise<{ address: string; transactionHash: string }> {
    const prepared = await this.prepareDeployment(owners, threshold, saltNonce);
    const chain = defineChain({ id: this.options.chainId, name: `safe-${this.options.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [this.options.rpcUrl] } } });
    const account = privateKeyToAccount(deployerPrivateKey);
    const wallet = createWalletClient({ account, chain, transport: http(this.options.rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(this.options.rpcUrl) });
    const transactionHash = await wallet.sendTransaction({ account, to: prepared.to as Address, data: prepared.data as Hex, value: BigInt(prepared.value) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("Safe deployment transaction reverted");
    return { address: prepared.address, transactionHash };
  }

  private connect(safeAddress: string) {
    return Safe.init(this.kitConfig({ safeAddress }) as never);
  }

  async observe(safeAddress: string): Promise<SafeAccountObservation> {
    const kit = await this.connect(safeAddress);
    const [owners, threshold, nonce, balance, modules, guard] = await Promise.all([
      kit.getOwners(), kit.getThreshold(), kit.getNonce(), kit.getBalance(), kit.getModules(), kit.getGuard()
    ]);
    return { address: safeAddress, owners, threshold, nonce, balance, modules, guard };
  }

  /** Builds the Safe transaction for a native or ERC-20 transfer at the Safe's current nonce and computes its hash. */
  async compileTransfer(safeAddress: string, asset: { kind: "native" } | { kind: "erc20"; address: string }, to: string, amountBaseUnits: bigint): Promise<CompiledSafeTransaction> {
    if (amountBaseUnits <= 0n) throw new Error("Transfer amount must be positive");
    const kit = await this.connect(safeAddress);
    const call = asset.kind === "native"
      ? { to, value: amountBaseUnits.toString(), data: "0x", operation: OperationType.Call }
      : { to: asset.address, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, amountBaseUnits] }), operation: OperationType.Call };
    const transaction = await kit.createTransaction({ transactions: [call] });
    const data = transaction.data;
    return { ...this.plain(data), safeTxHash: await kit.getTransactionHash(transaction) };
  }

  private plain(data: SafeTransactionData): Omit<CompiledSafeTransaction, "safeTxHash"> {
    return { to: data.to, value: data.value, data: data.data, operation: data.operation, safeTxGas: data.safeTxGas, baseGas: data.baseGas, gasPrice: data.gasPrice, gasToken: data.gasToken, refundReceiver: data.refundReceiver, nonce: data.nonce };
  }

  /** Calldata for execTransaction with owner signatures ordered as the Safe requires. Any funded account may send it. */
  encodeExecution(compiled: CompiledSafeTransaction, signatures: OwnerSignature[]): Hex {
    const ordered = [...signatures].sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));
    const bytes = buildSignatureBytes(ordered.map((entry) => new EthSafeSignature(entry.owner, entry.signature)));
    return encodeFunctionData({
      abi: execTransactionAbi,
      functionName: "execTransaction",
      args: [compiled.to as Address, BigInt(compiled.value), compiled.data as Hex, compiled.operation, BigInt(compiled.safeTxGas), BigInt(compiled.baseGas), BigInt(compiled.gasPrice), compiled.gasToken as Address, compiled.refundReceiver as Address, bytes as Hex]
    });
  }

  /** Test and tooling helper: signs the way a wallet's signTypedData would, with a locally held owner key. */
  async signTypedDataFor(safeAddress: string, compiled: CompiledSafeTransaction, ownerPrivateKey: Hex): Promise<OwnerSignature> {
    const account = privateKeyToAccount(ownerPrivateKey);
    const signature = await account.signTypedData(safeTypedData(this.options.chainId, safeAddress, compiled));
    return { owner: account.address, signature };
  }

  /** Kept for the standalone lifecycle test: Protocol Kit's own signature and execution path. */
  async buildNativeTransfer(safeAddress: string, signer: Hex, to: string, amountBaseUnits: bigint): Promise<{ transaction: SafeTransaction; safeTransactionHash: string }> {
    const kit = await Safe.init(this.kitConfig({ signer, safeAddress }) as never);
    const transaction = await kit.createTransaction({ transactions: [{ to, value: amountBaseUnits.toString(), data: "0x", operation: OperationType.Call }] });
    return { transaction, safeTransactionHash: await kit.getTransactionHash(transaction) };
  }

  async collectSignatures(safeAddress: string, transaction: SafeTransaction, safeTransactionHash: string, ownerPrivateKeys: Hex[]): Promise<SafeTransaction> {
    for (const ownerPrivateKey of ownerPrivateKeys) {
      const kit = await Safe.init(this.kitConfig({ signer: ownerPrivateKey, safeAddress }) as never);
      transaction.addSignature(await kit.signHash(safeTransactionHash));
    }
    return transaction;
  }

  async execute(safeAddress: string, executorPrivateKey: Hex, transaction: SafeTransaction): Promise<{ transactionHash: string }> {
    const kit = await Safe.init(this.kitConfig({ signer: executorPrivateKey, safeAddress }) as never);
    const result = await kit.executeTransaction(transaction);
    return { transactionHash: result.hash };
  }
}

const zeroAddress = "0x0000000000000000000000000000000000000000";

/** The digest the owners sign, and the hash the Safe checks their signatures against. */
export function safeTransactionHash(chainId: number, safeAddress: string, compiled: CompiledSafeTransaction): Hex {
  return hashTypedData(safeTypedData(chainId, safeAddress, compiled));
}

/**
 * A Safe's own way to cancel a queued transaction: a zero value call from the
 * Safe to itself at the same nonce. Executing it consumes that nonce, so the
 * payment it replaces can never be executed afterwards. Nothing else moves, and
 * the hash is derived from the fields alone, so it can be built and checked
 * without a node.
 */
export function compileSafeRejection(chainId: number, safeAddress: string, nonce: number): CompiledSafeTransaction {
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error("Safe nonce must be a non-negative integer");
  const address = getAddress(safeAddress);
  const fields = { to: address, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: zeroAddress, refundReceiver: zeroAddress, nonce, safeTxHash: "" };
  return { ...fields, safeTxHash: safeTransactionHash(chainId, address, fields) };
}

/**
 * Whether a compiled rejection cancels exactly this transaction. Same Safe, same
 * nonce, and nothing of its own to send: anything else would burn an unrelated
 * nonce or move funds.
 */
export function safeRejectionCancels(rejection: CompiledSafeTransaction, target: CompiledSafeTransaction, safeAddress: string): boolean {
  const address = getAddress(safeAddress).toLowerCase();
  return rejection.nonce === target.nonce
    && rejection.to.toLowerCase() === address
    && BigInt(rejection.value) === 0n
    && (rejection.data === "0x" || rejection.data === "")
    && rejection.operation === 0;
}
