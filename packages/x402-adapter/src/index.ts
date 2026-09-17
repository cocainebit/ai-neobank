import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme as ExactSvmClientScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createPublicClient, http, parseAbiItem, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Canonical CAIP-2 identifiers the x402 ecosystem uses for Solana clusters. */
export const solanaCaip2 = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
} as const;

/**
 * Maps Relay's network label to the identifier used on the x402 wire. The x402
 * SVM SDK accepts only the three public cluster ids, so a local validator is
 * labelled as devnet on the wire while every RPC call still goes to the local
 * cluster; the genesis hash is checked so the label never masks a real cluster.
 */
export async function solanaWireNetwork(network: string, rpcUrl: string): Promise<string> {
  const cluster = network.split(":")[1] ?? "";
  if (cluster in solanaCaip2) return solanaCaip2[cluster as keyof typeof solanaCaip2];
  if (cluster === "mainnet-beta") return solanaCaip2.mainnet;
  const genesis = await new Connection(rpcUrl).getGenesisHash();
  const known = Object.values(solanaCaip2).map((id) => id.split(":")[1]);
  if (known.includes(genesis.slice(0, 32))) throw new Error(`Network ${network} points at a public cluster (${genesis}); label it by its real cluster name`);
  return solanaCaip2.devnet;
}

export interface X402Networks {
  evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string };
  solana?: { network: `solana:${string}`; wireNetwork: string; rpcUrl: string };
}

export interface X402Request {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface X402Quote {
  url: string;
  method: string;
  x402Version: number;
  /** The one `accepts` entry Relay will pay. */
  requirements: PaymentRequirements;
  resource: PaymentRequired["resource"];
  paymentRequired: PaymentRequired;
}

export interface X402PaymentResult {
  status: number;
  settle: SettleResponse | null;
  /** Error carried by a repeated 402, when the seller refused the payment. */
  refusal: string | null;
  bodyHash: string;
  bodyPreview: string;
  contentType: string | null;
}

export class X402QuoteError extends Error {
  constructor(message: string, readonly code: "not_payable" | "no_acceptable_option" | "exceeds_max" | "unsupported_version") { super(message); this.name = "X402QuoteError"; }
}

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const authorizationStateAbi = parseAbiItem("function authorizationState(address authorizer, bytes32 nonce) view returns (bool)");

/**
 * Relay's x402 client. Relay's policy engine is the spend control, so the SDK's
 * own caps are disabled; the quote is captured before approval and the signed
 * payload is persisted before the paid request so a retry re-sends the same
 * authorization instead of creating a second one.
 */
export class X402PaymentClient {
  private readonly http = new x402HTTPClient(new x402Client());

  constructor(private readonly networks: X402Networks) {}

  wireNetwork(chainFamily: "evm" | "svm", network: string): string {
    if (chainFamily === "evm") return network;
    if (this.networks.solana?.network === network) return this.networks.solana.wireNetwork;
    return network;
  }

  /** Fetches the resource unpaid and returns the 402 option Relay can pay, or throws a coded error. */
  async quote(request: X402Request, want: { chainFamily: "evm" | "svm"; network: string; assetAddress: string; maxAmountBaseUnits: bigint }): Promise<X402Quote> {
    const method = (request.method ?? "GET").toUpperCase();
    const response = await fetch(request.url, { method, headers: { accept: "application/json", ...(request.headers ?? {}) }, ...(request.body && method !== "GET" ? { body: request.body } : {}) });
    await response.arrayBuffer().catch(() => undefined);
    if (response.status !== 402) throw new X402QuoteError(`Resource responded ${response.status}, not 402`, "not_payable");
    const header = response.headers.get("payment-required");
    if (!header) throw new X402QuoteError("402 without a PAYMENT-REQUIRED header (x402 v1 responses are not supported)", "unsupported_version");
    const paymentRequired = decodePaymentRequiredHeader(header);
    if (paymentRequired.x402Version !== 2) throw new X402QuoteError(`x402 version ${paymentRequired.x402Version} is not supported`, "unsupported_version");
    const wire = this.wireNetwork(want.chainFamily, want.network);
    const candidates = paymentRequired.accepts
      .filter((option) => option.scheme === "exact" && option.network === wire && option.asset.toLowerCase() === want.assetAddress.toLowerCase())
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
    const requirements = candidates[0];
    if (!requirements) throw new X402QuoteError(`No exact-scheme option on ${wire} for asset ${want.assetAddress}; offered: ${paymentRequired.accepts.map((option) => `${option.scheme}/${option.network}/${option.asset}`).join(", ") || "none"}`, "no_acceptable_option");
    if (BigInt(requirements.amount) > want.maxAmountBaseUnits) throw new X402QuoteError(`Resource asks ${requirements.amount} but the intent allows at most ${want.maxAmountBaseUnits}`, "exceeds_max");
    return { url: request.url, method, x402Version: paymentRequired.x402Version, requirements, resource: paymentRequired.resource, paymentRequired };
  }

  /** Deterministic hash of what the approver is authorising: the exact requirements and resource. */
  static quoteHash(quote: Pick<X402Quote, "url" | "method" | "requirements" | "resource">): string {
    const canonical = JSON.stringify({ url: quote.url, method: quote.method, requirements: quote.requirements, resource: quote.resource }, Object.keys({ url: 0, method: 0, requirements: 0, resource: 0, scheme: 0, network: 0, asset: 0, amount: 0, payTo: 0, maxTimeoutSeconds: 0, extra: 0, description: 0, mimeType: 0, serviceName: 0, tags: 0, iconUrl: 0, name: 0, version: 0, feePayer: 0, assetTransferMethod: 0, paymentFlow: 0, decimals: 0 }).sort());
    return createHash("sha256").update(`x402|${canonical}`).digest("hex");
  }

  /** Signs the payment for the quoted option. Nothing is sent. */
  async createPayload(quote: X402Quote, key: { evmPrivateKey?: Hex; evmAccount?: LocalAccount; solanaSecretKey?: Uint8Array }): Promise<PaymentPayload> {
    const client = new x402Client(() => quote.requirements).setSpendControls(false);
    if (quote.requirements.network.startsWith("eip155:")) {
      if (!key.evmPrivateKey && !key.evmAccount) throw new Error("EVM key required for an EVM x402 payment");
      const account = key.evmAccount ?? privateKeyToAccount(key.evmPrivateKey!);
      const options = this.networks.evm ? { rpcUrl: this.networks.evm.rpcUrl } : undefined;
      client.register(quote.requirements.network, new ExactEvmClientScheme({ address: account.address as Hex, signTypedData: async (message) => (await account.signTypedData(message as never)) as Hex }, options));
    } else {
      if (!key.solanaSecretKey) throw new Error("Solana key required for a Solana x402 payment");
      const signer = await createKeyPairSignerFromBytes(key.solanaSecretKey);
      const options = this.networks.solana ? { rpcUrl: this.networks.solana.rpcUrl } : undefined;
      client.register(quote.requirements.network, new ExactSvmClientScheme(signer, options));
    }
    return new x402HTTPClient(client).createPaymentPayload(quote.paymentRequired);
  }

  /** Stable identifier for a payload: the EIP-3009 nonce or the signed Solana transaction bytes. */
  static payloadId(payload: PaymentPayload): string {
    const inner = payload.payload as { authorization?: { nonce?: string }; transaction?: string };
    if (inner.authorization?.nonce) return `eip3009:${inner.authorization.nonce}`;
    return `svm:${createHash("sha256").update(String(inner.transaction ?? JSON.stringify(payload.payload))).digest("hex")}`;
  }

  /** Sends the paid request. Re-sending the same payload after a crash cannot pay twice: the nonce or transaction is single-use. */
  async pay(quote: X402Quote, payload: PaymentPayload, request: Omit<X402Request, "url" | "method"> = {}): Promise<X402PaymentResult> {
    const headers: Record<string, string> = { accept: "application/json", ...(request.headers ?? {}), "payment-signature": encodePaymentSignatureHeader(payload) };
    const response = await fetch(quote.url, { method: quote.method, headers, ...(request.body && quote.method !== "GET" ? { body: request.body } : {}) });
    const text = await response.text();
    const settleHeader = response.headers.get("payment-response");
    let refusal: string | null = null;
    if (response.status === 402) {
      const required = response.headers.get("payment-required");
      refusal = required ? (decodePaymentRequiredHeader(required).error ?? "payment refused") : "payment refused";
    }
    return {
      status: response.status,
      settle: settleHeader ? decodePaymentResponseHeader(settleHeader) : null,
      refusal,
      bodyHash: createHash("sha256").update(text).digest("hex"),
      bodyPreview: text.slice(0, 2000),
      contentType: response.headers.get("content-type")
    };
  }

  /** EVM recovery: has this authorization nonce been consumed on chain? */
  async evmAuthorizationUsed(token: string, authorizer: string, nonce: string): Promise<boolean> {
    if (!this.networks.evm) throw new Error("EVM network not configured");
    const client = createPublicClient({ transport: http(this.networks.evm.rpcUrl) });
    return client.readContract({ address: token as Address, abi: [authorizationStateAbi], functionName: "authorizationState", args: [authorizer as Address, nonce as Hex] });
  }

  /** EVM recovery: the latest token transfer from payer to payee, scanning back from the head. */
  async findEvmSettlement(token: string, from: string, to: string, lookbackBlocks = 5_000n): Promise<{ transactionHash: string; amount: bigint } | null> {
    if (!this.networks.evm) throw new Error("EVM network not configured");
    const client = createPublicClient({ transport: http(this.networks.evm.rpcUrl) });
    const head = await client.getBlockNumber();
    const logs = await client.getLogs({ address: token as Address, event: transferEvent, args: { from: from as Address, to: to as Address }, fromBlock: head > lookbackBlocks ? head - lookbackBlocks : 0n, toBlock: head });
    const latest = logs[logs.length - 1];
    return latest ? { transactionHash: latest.transactionHash, amount: latest.args.value ?? 0n } : null;
  }

  /** Solana recovery: the latest transaction that moved this mint from payer to payee, from the payee's token account history. */
  async findSolanaSettlement(mint: string, from: string, to: string, limit = 50): Promise<{ transactionHash: string; amount: bigint } | null> {
    if (!this.networks.solana) throw new Error("Solana network not configured");
    const connection = new Connection(this.networks.solana.rpcUrl, "confirmed");
    const destinationAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(to), true);
    const signatures = await connection.getSignaturesForAddress(destinationAta, { limit }, "confirmed");
    for (const entry of signatures) {
      if (entry.err) continue;
      const transaction = await connection.getTransaction(entry.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const pre = transaction?.meta?.preTokenBalances ?? [];
      const post = transaction?.meta?.postTokenBalances ?? [];
      const balance = (owner: string, list: typeof pre) => BigInt(list.find((item) => item.owner === owner && item.mint === mint)?.uiTokenAmount.amount ?? "0");
      const received = balance(to, post) - balance(to, pre);
      const sent = balance(from, pre) - balance(from, post);
      if (received > 0n && sent === received) return { transactionHash: entry.signature, amount: received };
    }
    return null;
  }
}

export type { PaymentPayload, PaymentRequirements, SettleResponse };
