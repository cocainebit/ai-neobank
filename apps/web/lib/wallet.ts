"use client";

import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface SolanaProvider {
  publicKey?: { toBase58(): string; toString(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string; toString(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  signTransaction<T>(transaction: T): Promise<T>;
}

declare global {
  interface Window {
    ethereum?: EvmProvider;
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
  }
}

const devEnabled = process.env.NEXT_PUBLIC_DEV_WALLET === "1";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

// Development wallets: keys in this browser only, enabled by NEXT_PUBLIC_DEV_WALLET=1, for local chains.

function storedKey(name: string, create: () => string): string {
  const key = `relay.devwallet.${name}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = create();
  window.localStorage.setItem(key, created);
  return created;
}

function devEvmProvider(): EvmProvider {
  const account = privateKeyToAccount(storedKey("evm", () => generatePrivateKey()) as Hex);
  const rpcUrl = process.env.NEXT_PUBLIC_DEV_EVM_RPC_URL ?? "http://127.0.0.1:8722";
  return {
    async request({ method, params = [] }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json().then((body: { result: string }) => body.result);
      if (method === "wallet_switchEthereumChain") throw new Error("The development wallet only uses the local chain");
      if (method === "personal_sign") return account.signMessage({ message: { raw: params[0] as Hex } });
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(String(params[1])) as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
        const { EIP712Domain: _domain, ...types } = typed.types;
        return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message } as never);
      }
      if (method === "eth_sendTransaction") {
        const call = params[0] as { to: Hex; data?: Hex; value?: Hex };
        const chainId = Number(await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json().then((body: { result: string }) => body.result));
        const client = createWalletClient({ account, transport: http(rpcUrl), chain: { id: chainId, name: "Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } });
        return client.sendTransaction({ account, to: call.to, ...(call.data ? { data: call.data } : {}), value: call.value ? BigInt(call.value) : 0n, chain: client.chain });
      }
      throw new Error(`Development wallet does not support ${method}`);
    }
  };
}

function devSolanaProvider(): SolanaProvider {
  const keypair = Keypair.fromSecretKey(fromBase64(storedKey("svm", () => base64(Keypair.generate().secretKey))));
  return {
    publicKey: keypair.publicKey,
    async connect() { return { publicKey: keypair.publicKey }; },
    async signMessage(message) { return { signature: ed25519.sign(message, keypair.secretKey.slice(0, 32)) }; },
    async signTransaction<T>(transaction: T): Promise<T> {
      (transaction as unknown as VersionedTransaction).sign([keypair]);
      return transaction;
    }
  };
}

export type WalletSource = "browser" | "development";

export function availableWallets(): { evm: WalletSource | null; solana: WalletSource | null } {
  if (typeof window === "undefined") return { evm: null, solana: null };
  return {
    evm: window.ethereum ? "browser" : devEnabled ? "development" : null,
    solana: window.phantom?.solana ?? window.solana ? "browser" : devEnabled ? "development" : null
  };
}

function evm(): EvmProvider {
  if (window.ethereum) return window.ethereum;
  if (devEnabled) return devEvmProvider();
  throw new Error("No Ethereum wallet found. Install MetaMask, Rabby, or another EIP-1193 wallet.");
}

function solana(): SolanaProvider {
  const provider = window.phantom?.solana ?? window.solana;
  if (provider) return provider;
  if (devEnabled) return devSolanaProvider();
  throw new Error("No Solana wallet found. Install Phantom, Backpack, or Solflare.");
}

export async function connectEvm(): Promise<string> {
  const accounts = await evm().request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts[0]) throw new Error("The wallet did not share an account");
  return accounts[0];
}

export async function signEvmMessage(address: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return await evm().request({ method: "personal_sign", params: [hex, address] }) as string;
}

export async function signEvmTypedData(address: string, typedData: unknown): Promise<string> {
  return await evm().request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typedData)] }) as string;
}

export async function sendEvmTransaction(address: string, transaction: { to: string; data: string; value: string }): Promise<string> {
  const value = `0x${BigInt(transaction.value || "0").toString(16)}`;
  return await evm().request({ method: "eth_sendTransaction", params: [{ from: address, to: transaction.to, data: transaction.data, value }] }) as string;
}

/** Asks the wallet to move to `chainId` when it is elsewhere; wallets that cannot switch leave the payer to do it. */
export async function ensureEvmChain(chainId: number): Promise<void> {
  const current = Number(await evm().request({ method: "eth_chainId" }));
  if (current === chainId) return;
  try {
    await evm().request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
  } catch {
    throw new Error(`Switch your wallet to chain ${chainId}. It is on chain ${current}.`);
  }
}

export async function connectSolana(): Promise<string> {
  const result = await solana().connect();
  return result.publicKey.toBase58 ? result.publicKey.toBase58() : result.publicKey.toString();
}

export async function signSolanaMessage(message: string): Promise<string> {
  const result = await solana().signMessage(new TextEncoder().encode(message), "utf8");
  const signature = result instanceof Uint8Array ? result : result.signature;
  return bs58.encode(signature);
}

/** Adds the connected wallet's signature to a serialized transaction, leaving any existing signatures in place. */
export async function signSolanaTransaction(transactionBase64: string): Promise<string> {
  const transaction = VersionedTransaction.deserialize(fromBase64(transactionBase64));
  const signed = await solana().signTransaction(transaction);
  return base64(signed.serialize());
}

export function isDevelopmentWallet(family: ChainFamilyName): boolean {
  const available = availableWallets();
  return (family === "evm" ? available.evm : available.solana) === "development";
}

type ChainFamilyName = "evm" | "svm";
