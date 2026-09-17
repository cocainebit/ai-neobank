import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { getAddress, isAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";

export type ChainFamily = "evm" | "svm";

/**
 * Canonical wallet address for storage and lookup: EIP-55 checksum for EVM,
 * base58 as given for Solana. Throws on anything that is not a valid address.
 */
export function canonicalAddress(chainFamily: ChainFamily, address: string): string {
  if (chainFamily === "evm") {
    if (!isAddress(address, { strict: false })) throw new Error("Invalid EVM address");
    return getAddress(address);
  }
  return new PublicKey(address).toBase58();
}

export interface ChallengeInput {
  chainFamily: ChainFamily;
  address: string;
  domain: string;
  uri: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  /** EVM: numeric chain ID. Solana: cluster label such as "devnet" or "localnet". */
  chainReference: string;
  statement?: string;
}

const defaultStatement = "Sign in to Relay. This request does not move funds or grant spending authority.";

/** Builds the exact text the wallet must sign: EIP-4361 for EVM, Sign-In With Solana for SVM. */
export function buildSignInMessage(input: ChallengeInput): string {
  const statement = input.statement ?? defaultStatement;
  if (input.chainFamily === "evm") {
    return createSiweMessage({
      address: canonicalAddress("evm", input.address) as Hex,
      chainId: Number(input.chainReference),
      domain: input.domain,
      nonce: input.nonce,
      uri: input.uri,
      version: "1",
      statement,
      issuedAt: input.issuedAt,
      expirationTime: input.expiresAt
    });
  }
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    canonicalAddress("svm", input.address),
    "",
    statement,
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainReference}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`
  ].join("\n");
}

export interface VerifyInput {
  chainFamily: ChainFamily;
  address: string;
  message: string;
  signature: string;
  /** Expected values; verification fails if the signed message disagrees. */
  domain: string;
  nonce: string;
  now?: Date;
}

export type VerifyResult = { ok: true; address: string } | { ok: false; reason: string };

function decodeSignature(signature: string): Uint8Array {
  try {
    return bs58.decode(signature);
  } catch {
    return Buffer.from(signature, "base64");
  }
}

/**
 * Verifies a sign-in signature and that the signed text carries the expected
 * domain, nonce, address, and validity window. EVM verification recovers the
 * EOA; ERC-1271 smart-account owners are not accepted here yet.
 */
export async function verifySignIn(input: VerifyInput): Promise<VerifyResult> {
  const now = input.now ?? new Date();
  if (input.chainFamily === "evm") {
    const parsed = parseSiweMessage(input.message);
    const expected = canonicalAddress("evm", input.address) as Hex;
    if (!validateSiweMessage({ message: parsed, address: expected, domain: input.domain, nonce: input.nonce, time: now })) {
      return { ok: false, reason: "Message fields do not match the challenge" };
    }
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: input.message, signature: input.signature as Hex });
    } catch {
      return { ok: false, reason: "Signature could not be recovered" };
    }
    if (recovered.toLowerCase() !== expected.toLowerCase()) return { ok: false, reason: "Signature does not belong to the address" };
    return { ok: true, address: expected };
  }

  const expected = canonicalAddress("svm", input.address);
  const fields = parseSolanaSignIn(input.message);
  if (!fields) return { ok: false, reason: "Message is not a Sign-In With Solana message" };
  if (fields.domain !== input.domain || fields.nonce !== input.nonce || fields.address !== expected) {
    return { ok: false, reason: "Message fields do not match the challenge" };
  }
  if (fields.expirationTime && new Date(fields.expirationTime) <= now) return { ok: false, reason: "Message has expired" };
  if (fields.issuedAt && new Date(fields.issuedAt) > new Date(now.getTime() + 60_000)) return { ok: false, reason: "Message is issued in the future" };
  const publicKey = new PublicKey(expected).toBytes();
  let valid = false;
  try {
    valid = ed25519.verify(decodeSignature(input.signature), new TextEncoder().encode(input.message), publicKey);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, address: expected } : { ok: false, reason: "Signature does not belong to the address" };
}

/** Verifies a plain message signature (personal_sign for EVM, ed25519 for Solana) without sign-in message parsing. */
export async function verifyWalletSignature(input: { chainFamily: ChainFamily; address: string; message: string; signature: string }): Promise<boolean> {
  try {
    if (input.chainFamily === "evm") {
      const recovered = await recoverMessageAddress({ message: input.message, signature: input.signature as Hex });
      return recovered.toLowerCase() === canonicalAddress("evm", input.address).toLowerCase();
    }
    return ed25519.verify(decodeSignature(input.signature), new TextEncoder().encode(input.message), new PublicKey(canonicalAddress("svm", input.address)).toBytes());
  } catch {
    return false;
  }
}

/** The exact text a human signs to approve or reject an intent; bound to version and evidence hashes. */
export function buildApprovalMessage(input: { domain: string; intentId: string; version: number; decision: "approved" | "rejected"; compiledHash: string; simulationHash: string }): string {
  return [
    `${input.domain} approval decision`,
    `Intent: ${input.intentId}`,
    `Version: ${input.version}`,
    `Decision: ${input.decision}`,
    `Compiled: ${input.compiledHash}`,
    `Simulation: ${input.simulationHash}`
  ].join("\n");
}

export interface SolanaSignInFields {
  domain: string;
  address: string;
  nonce: string;
  uri?: string;
  chainId?: string;
  issuedAt?: string;
  expirationTime?: string;
}

export function parseSolanaSignIn(message: string): SolanaSignInFields | null {
  const lines = message.split("\n");
  const header = /^(.+) wants you to sign in with your Solana account:$/.exec(lines[0] ?? "");
  const address = lines[1];
  if (!header?.[1] || !address) return null;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  const nonce = field("Nonce");
  if (!nonce) return null;
  const fields: SolanaSignInFields = { domain: header[1], address, nonce };
  const uri = field("URI"); if (uri) fields.uri = uri;
  const chainId = field("Chain ID"); if (chainId) fields.chainId = chainId;
  const issuedAt = field("Issued At"); if (issuedAt) fields.issuedAt = issuedAt;
  const expirationTime = field("Expiration Time"); if (expirationTime) fields.expirationTime = expirationTime;
  return fields;
}

/** Signs a Solana sign-in message with a raw ed25519 secret key; used by tests and dev tooling, never by the API. */
export function signSolanaMessage(message: string, secretKey: Uint8Array): string {
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), secretKey.slice(0, 32)));
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Opaque session token; only its hash is stored. */
export function generateSessionToken(): string {
  return `rl_sess_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface AgentKey {
  keyId: string;
  secret: string;
  /** The value handed to the agent runtime, shown once. */
  token: string;
}

const agentKeyPrefix = "rl_agent_";

export function generateAgentKey(): AgentKey {
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, secret, token: `${agentKeyPrefix}${keyId}_${secret}` };
}

export function isAgentToken(token: string): boolean {
  return token.startsWith(agentKeyPrefix);
}

export function parseAgentToken(token: string): { keyId: string; secret: string } | null {
  if (!isAgentToken(token)) return null;
  const [keyId, secret] = token.slice(agentKeyPrefix.length).split("_");
  if (!keyId || !secret) return null;
  return { keyId, secret };
}
