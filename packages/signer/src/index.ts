import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";

export type SignerFamily = "evm" | "svm";

export interface GeneratedSigner {
  family: SignerFamily;
  address: string;
  secret: Uint8Array;
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export function parseMasterKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("SIGNER_MASTER_KEY must decode to exactly 32 bytes");
  return key;
}

export function generateSigner(family: SignerFamily): GeneratedSigner {
  if (family === "evm") {
    const privateKey = generatePrivateKey();
    return { family, address: privateKeyToAccount(privateKey).address, secret: Buffer.from(privateKey.slice(2), "hex") };
  }
  const signer = Keypair.generate();
  return { family, address: signer.publicKey.toBase58(), secret: signer.secretKey };
}

export function encryptSecret(secret: Uint8Array, masterKey: Uint8Array, keyVersion = 1): EncryptedSecret {
  if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion
  };
}

export function decryptSecret(envelope: EncryptedSecret, masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
}

export function exportDevelopmentSecret(signer: GeneratedSigner): string {
  return signer.family === "evm"
    ? `0x${Buffer.from(signer.secret).toString("hex")}`
    : Buffer.from(signer.secret).toString("base64");
}
