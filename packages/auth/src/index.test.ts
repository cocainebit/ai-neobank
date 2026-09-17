import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import {
  buildSignInMessage,
  canonicalAddress,
  generateAgentKey,
  generateNonce,
  hashToken,
  parseAgentToken,
  signSolanaMessage,
  verifySignIn
} from "./index.js";

const window = () => ({ issuedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) });

describe("wallet sign-in", () => {
  it("verifies an EVM EOA signature over the exact challenge", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = generateNonce();
    const message = buildSignInMessage({ chainFamily: "evm", address: account.address.toLowerCase(), domain: "relay.test", uri: "https://relay.test", nonce, chainReference: "31337", ...window() });
    const signature = await account.signMessage({ message });
    const result = await verifySignIn({ chainFamily: "evm", address: account.address, message, signature, domain: "relay.test", nonce });
    expect(result).toEqual({ ok: true, address: account.address });
    const wrongNonce = await verifySignIn({ chainFamily: "evm", address: account.address, message, signature, domain: "relay.test", nonce: generateNonce() });
    expect(wrongNonce.ok).toBe(false);
    const other = privateKeyToAccount(generatePrivateKey());
    const wrongSigner = await verifySignIn({ chainFamily: "evm", address: other.address, message, signature, domain: "relay.test", nonce });
    expect(wrongSigner.ok).toBe(false);
  });

  it("verifies a Solana ed25519 signature over the exact challenge", async () => {
    const keypair = Keypair.generate();
    const nonce = generateNonce();
    const message = buildSignInMessage({ chainFamily: "svm", address: keypair.publicKey.toBase58(), domain: "relay.test", uri: "https://relay.test", nonce, chainReference: "localnet", ...window() });
    const signature = signSolanaMessage(message, keypair.secretKey);
    expect(await verifySignIn({ chainFamily: "svm", address: keypair.publicKey.toBase58(), message, signature, domain: "relay.test", nonce })).toEqual({ ok: true, address: keypair.publicKey.toBase58() });
    const tampered = message.replace("Relay", "Relay and move funds");
    expect((await verifySignIn({ chainFamily: "svm", address: keypair.publicKey.toBase58(), message: tampered, signature, domain: "relay.test", nonce })).ok).toBe(false);
    const imposter = Keypair.generate();
    expect((await verifySignIn({ chainFamily: "svm", address: imposter.publicKey.toBase58(), message, signature, domain: "relay.test", nonce })).ok).toBe(false);
  });

  it("rejects an expired message", async () => {
    const keypair = Keypair.generate();
    const nonce = generateNonce();
    const message = buildSignInMessage({ chainFamily: "svm", address: keypair.publicKey.toBase58(), domain: "relay.test", uri: "https://relay.test", nonce, chainReference: "localnet", issuedAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 10 * 60_000) });
    const signature = signSolanaMessage(message, keypair.secretKey);
    expect((await verifySignIn({ chainFamily: "svm", address: keypair.publicKey.toBase58(), message, signature, domain: "relay.test", nonce })).ok).toBe(false);
  });

  it("canonicalises addresses", () => {
    expect(canonicalAddress("evm", "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359")).toBe("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
    expect(() => canonicalAddress("evm", "0x1234")).toThrow();
    expect(() => canonicalAddress("svm", "not-base58!")).toThrow();
  });
});

describe("agent keys and tokens", () => {
  it("round-trips an agent key and hashes deterministically", () => {
    const key = generateAgentKey();
    expect(parseAgentToken(key.token)).toEqual({ keyId: key.keyId, secret: key.secret });
    expect(parseAgentToken("rl_sess_abc")).toBeNull();
    // Secrets are base64url and can contain underscores; the whole secret must survive parsing.
    expect(parseAgentToken("rl_agent_0a1b2c_ab_cd_ef")).toEqual({ keyId: "0a1b2c", secret: "ab_cd_ef" });
    for (let index = 0; index < 200; index += 1) {
      const generated = generateAgentKey();
      expect(parseAgentToken(generated.token)).toEqual({ keyId: generated.keyId, secret: generated.secret });
    }
    expect(hashToken(key.secret)).toBe(hashToken(key.secret));
    expect(hashToken(key.secret)).not.toBe(hashToken(generateAgentKey().secret));
  });
});
