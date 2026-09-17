import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
  type Hex,
  type LocalAccount,
  type Signature
} from "viem";
import { toAccount } from "viem/accounts";

/**
 * Wraps and unwraps the per-signer data keys. The version names which key
 * encryption key sealed a data key, so rotation can re-wrap without touching
 * the signer secret itself.
 */
export interface KeyEncryptionProvider {
  readonly activeVersion: string;
  /** True when the key-encryption key lives outside this process (KMS/HSM). Production requires it. */
  readonly holdsKeysOutsideProcess: boolean;
  wrap(dataKey: Uint8Array): Promise<string>;
  unwrap(wrapped: string, version: string): Promise<Uint8Array>;
  /** Raw key for a legacy (format 1) envelope, when this provider holds it. */
  legacyKey?(version: string): Uint8Array | null;
}

/** Envelope with a wrapped data key (format 2). */
export interface SealedSecret {
  ciphertext: string;
  nonce: string;
  authTag: string;
  dataKey: string;
  dataKeyVersion: string;
}

const encryptionContext = { purpose: "relay-signer-data-key" } as const;

function aesSeal(plaintext: Uint8Array, key: Uint8Array): { ciphertext: string; nonce: string; authTag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

function aesOpen(sealed: { ciphertext: string; nonce: string; authTag: string }, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
}

/**
 * Versioned 32-byte keys held by the process, for development and for
 * migrating legacy envelopes. Version "1" is also the key legacy format 1
 * envelopes were sealed with directly.
 */
export class LocalKeyring implements KeyEncryptionProvider {
  readonly holdsKeysOutsideProcess = false;
  private readonly keys: Map<string, Uint8Array>;
  constructor(keys: Record<string, Uint8Array>, readonly activeVersion: string) {
    this.keys = new Map(Object.entries(keys));
    for (const [version, key] of this.keys) if (key.length !== 32) throw new Error(`Keyring key ${version} must be 32 bytes`);
    if (!this.keys.has(activeVersion)) throw new Error(`Active key version ${activeVersion} is not in the keyring`);
  }

  async wrap(dataKey: Uint8Array): Promise<string> {
    return JSON.stringify(aesSeal(dataKey, this.keys.get(this.activeVersion)!));
  }

  async unwrap(wrapped: string, version: string): Promise<Uint8Array> {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Key version ${version} is not available`);
    return aesOpen(JSON.parse(wrapped) as { ciphertext: string; nonce: string; authTag: string }, key);
  }

  legacyKey(version: string): Uint8Array | null {
    return this.keys.get(version) ?? null;
  }
}

/** "v2:hex,v3:hex" or a single 64-hex key (version "1"). */
export function parseKeyring(value: string, active?: string): LocalKeyring {
  const entries = value.split(",").map((part) => part.trim()).filter(Boolean);
  const keys: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const [version, material] = entry.includes(":") ? entry.split(":", 2) as [string, string] : ["1", entry];
    const key = /^[0-9a-f]{64}$/i.test(material) ? Buffer.from(material, "hex") : Buffer.from(material, "base64");
    if (key.length !== 32) throw new Error(`Key ${version} must decode to 32 bytes`);
    keys[version] = key;
  }
  const versions = Object.keys(keys);
  if (versions.length === 0) throw new Error("Keyring is empty");
  return new LocalKeyring(keys, active ?? versions[versions.length - 1]!);
}

export async function sealSecret(secret: Uint8Array, provider: KeyEncryptionProvider): Promise<SealedSecret> {
  const dataKey = randomBytes(32);
  try {
    const sealed = aesSeal(secret, dataKey);
    return { ...sealed, dataKey: await provider.wrap(dataKey), dataKeyVersion: provider.activeVersion };
  } finally {
    dataKey.fill(0);
  }
}

/** Opens a format 2 envelope, or a legacy format 1 envelope sealed directly under keyring version `keyVersion`. */
export async function openSecret(envelope: { ciphertext: string; nonce: string; authTag: string; dataKey?: string | null; dataKeyVersion?: string | null; keyVersion?: number | null }, provider: KeyEncryptionProvider): Promise<Uint8Array> {
  if (envelope.dataKey && envelope.dataKeyVersion) {
    const dataKey = await provider.unwrap(envelope.dataKey, envelope.dataKeyVersion);
    try { return aesOpen(envelope, dataKey); } finally { dataKey.fill(0); }
  }
  const legacy = provider.legacyKey?.(String(envelope.keyVersion ?? 1));
  if (!legacy) throw new Error("Legacy envelope needs the original master key in the keyring");
  return aesOpen(envelope, legacy);
}

/** Moves an envelope under the provider's active key. The signer secret's own ciphertext is unchanged for format 2. */
export async function rewrapSecret(envelope: Parameters<typeof openSecret>[0], provider: KeyEncryptionProvider): Promise<SealedSecret> {
  if (envelope.dataKey && envelope.dataKeyVersion) {
    const dataKey = await provider.unwrap(envelope.dataKey, envelope.dataKeyVersion);
    try {
      return { ciphertext: envelope.ciphertext, nonce: envelope.nonce, authTag: envelope.authTag, dataKey: await provider.wrap(dataKey), dataKeyVersion: provider.activeVersion };
    } finally {
      dataKey.fill(0);
    }
  }
  const secret = await openSecret(envelope, provider);
  try { return await sealSecret(secret, provider); } finally { secret.fill(0); }
}

/**
 * Wraps with one provider and unwraps with whichever provider holds the data
 * key's version. Lets a deployment move from a local keyring to KMS while
 * older envelopes stay readable until rotation re-wraps them.
 */
export class ChainedKeyProvider implements KeyEncryptionProvider {
  constructor(private readonly active: KeyEncryptionProvider, private readonly fallbacks: LocalKeyring[] = []) {}

  get activeVersion(): string {
    return this.active.activeVersion;
  }

  get holdsKeysOutsideProcess(): boolean {
    return this.active.holdsKeysOutsideProcess;
  }

  wrap(dataKey: Uint8Array): Promise<string> {
    return this.active.wrap(dataKey);
  }

  unwrap(wrapped: string, version: string): Promise<Uint8Array> {
    const local = this.fallbacks.find((keyring) => keyring.legacyKey(version));
    return local ? local.unwrap(wrapped, version) : this.active.unwrap(wrapped, version);
  }

  legacyKey(version: string): Uint8Array | null {
    for (const keyring of this.fallbacks) {
      const key = keyring.legacyKey(version);
      if (key) return key;
    }
    return this.active.legacyKey?.(version) ?? null;
  }
}

// KMS

/** The subset of a cloud KMS Relay uses. `awsKmsClient` adapts the AWS SDK to it. */
export interface KmsClient {
  encrypt(keyId: string, plaintext: Uint8Array, context: Record<string, string>): Promise<Uint8Array>;
  decrypt(keyId: string, ciphertext: Uint8Array, context: Record<string, string>): Promise<Uint8Array>;
  /** DER-encoded SubjectPublicKeyInfo. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature over a 32-byte digest (ECC_SECG_P256K1). */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

/** Data keys wrapped by a KMS symmetric key; the version is the key ARN or id. */
export class KmsKeyProvider implements KeyEncryptionProvider {
  readonly holdsKeysOutsideProcess = true;
  constructor(private readonly kms: KmsClient, readonly activeVersion: string) {}

  async wrap(dataKey: Uint8Array): Promise<string> {
    return Buffer.from(await this.kms.encrypt(this.activeVersion, dataKey, encryptionContext)).toString("base64");
  }

  async unwrap(wrapped: string, version: string): Promise<Uint8Array> {
    return this.kms.decrypt(version, Buffer.from(wrapped, "base64"), encryptionContext);
  }
}

interface AwsKmsSdk {
  send(command: unknown): Promise<unknown>;
}

interface AwsCommandConstructors {
  EncryptCommand: new (input: unknown) => unknown;
  DecryptCommand: new (input: unknown) => unknown;
  GetPublicKeyCommand: new (input: unknown) => unknown;
  SignCommand: new (input: unknown) => unknown;
}

/**
 * Adapts `@aws-sdk/client-kms` to KmsClient. The SDK is passed in, so the
 * dependency is only loaded by deployments that use AWS.
 */
export function awsKmsClient(client: AwsKmsSdk, commands: AwsCommandConstructors): KmsClient {
  return {
    async encrypt(keyId, plaintext, context) {
      const output = await client.send(new commands.EncryptCommand({ KeyId: keyId, Plaintext: plaintext, EncryptionContext: context, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" })) as { CiphertextBlob?: Uint8Array };
      if (!output.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
      return output.CiphertextBlob;
    },
    async decrypt(keyId, ciphertext, context) {
      const output = await client.send(new commands.DecryptCommand({ KeyId: keyId, CiphertextBlob: ciphertext, EncryptionContext: context, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" })) as { Plaintext?: Uint8Array; KeyId?: string };
      if (!output.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
      return output.Plaintext;
    },
    async getPublicKey(keyId) {
      const output = await client.send(new commands.GetPublicKeyCommand({ KeyId: keyId })) as { PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
      if (!output.PublicKey) throw new Error("KMS GetPublicKey returned no key");
      if (output.KeySpec && output.KeySpec !== "ECC_SECG_P256K1") throw new Error(`KMS key spec ${output.KeySpec} cannot sign EVM transactions`);
      if (output.KeyUsage && output.KeyUsage !== "SIGN_VERIFY") throw new Error("KMS key is not a signing key");
      return output.PublicKey;
    },
    async signDigest(keyId, digest) {
      const output = await client.send(new commands.SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" })) as { Signature?: Uint8Array };
      if (!output.Signature) throw new Error("KMS Sign returned no signature");
      return output.Signature;
    }
  };
}

/** The uncompressed secp256k1 point at the end of a DER SubjectPublicKeyInfo. */
export function secp256k1PointFromSpki(spki: Uint8Array): Uint8Array {
  const point = spki.slice(spki.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("Public key is not an uncompressed secp256k1 point");
  secp256k1.ProjectivePoint.fromHex(point).assertValidity();
  return point;
}

export function evmAddressFromSpki(spki: Uint8Array): Hex {
  const point = secp256k1PointFromSpki(spki);
  return getAddress(`0x${keccak256(point.slice(1)).slice(-40)}`) as Hex;
}

/** DER ECDSA signature to r, s with s normalised to the lower half, as Ethereum requires. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;
  const expect = (value: number) => { if (der[offset] !== value) throw new Error("Malformed DER signature"); offset += 1; };
  const length = () => {
    let value = der[offset++]!;
    if (value & 0x80) {
      const bytes = value & 0x7f;
      value = 0;
      for (let index = 0; index < bytes; index += 1) value = (value << 8) | der[offset++]!;
    }
    return value;
  };
  expect(0x30);
  length();
  expect(0x02);
  const rLength = length();
  const r = BigInt(`0x${Buffer.from(der.slice(offset, offset + rLength)).toString("hex") || "0"}`);
  offset += rLength;
  expect(0x02);
  const sLength = length();
  let s = BigInt(`0x${Buffer.from(der.slice(offset, offset + sLength)).toString("hex") || "0"}`);
  const n = secp256k1.CURVE.n;
  if (s > n / 2n) s = n - s;
  return { r, s };
}

/** Signs a digest in KMS and recovers the parity bit against the known address. */
async function kmsSign(kms: KmsClient, keyId: string, address: Hex, digest: Hex): Promise<Signature> {
  const { r, s } = parseDerSignature(await kms.signDigest(keyId, Buffer.from(digest.slice(2), "hex")));
  for (const yParity of [0, 1] as const) {
    const signature = { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }), yParity };
    const recovered = await recoverAddress({ hash: digest, signature: serializeSignature(signature) });
    if (recovered.toLowerCase() === address.toLowerCase()) return { ...signature, v: BigInt(27 + yParity) };
  }
  throw new Error("KMS signature does not recover to the key's address");
}

/**
 * A viem account whose private key never leaves KMS. Everything the adapters
 * sign (transactions, Safe typed data, messages) goes through KMS Sign.
 */
export async function kmsEvmAccount(kms: KmsClient, keyId: string): Promise<LocalAccount> {
  const address = evmAddressFromSpki(await kms.getPublicKey(keyId));
  return toAccount({
    address,
    async signMessage({ message }) {
      return serializeSignature(await kmsSign(kms, keyId, address, hashMessage(message)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const signature = await kmsSign(kms, keyId, address, keccak256(await serializer(transaction)));
      return serializer(transaction, signature);
    },
    async signTypedData(typedData) {
      return serializeSignature(await kmsSign(kms, keyId, address, hashTypedData(typedData as Parameters<typeof hashTypedData>[0])));
    }
  });
}
