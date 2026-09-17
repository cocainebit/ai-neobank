/**
 * An in-process stand-in for a cloud KMS, for tests only. It answers the same
 * AWS SDK commands Relay sends (Encrypt, Decrypt, GetPublicKey, Sign) with the
 * same output shapes: DER SubjectPublicKeyInfo, DER ECDSA signatures, opaque
 * ciphertext blobs bound to an encryption context.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

// DER prefix of a secp256k1 SubjectPublicKeyInfo, followed by the 65-byte point.
const spkiPrefix = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

function derInteger(value: Uint8Array): Buffer {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes = bytes.subarray(1);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

export class SoftKms {
  private readonly symmetric = new Map<string, Buffer>();
  private readonly signing = new Map<string, Uint8Array>();
  readonly calls: { command: string; input: Record<string, unknown> }[] = [];

  createSymmetricKey(keyId = `arn:aws:kms:local:000000000000:key/${crypto.randomUUID()}`): string {
    this.symmetric.set(keyId, randomBytes(32));
    return keyId;
  }

  createSigningKey(keyId = `arn:aws:kms:local:000000000000:key/${crypto.randomUUID()}`): string {
    this.signing.set(keyId, secp256k1.utils.randomPrivateKey());
    return keyId;
  }

  disable(keyId: string): void {
    this.symmetric.delete(keyId);
    this.signing.delete(keyId);
  }

  /** Mirrors `KMSClient.send` for the four commands Relay uses. */
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ command: name, input });
    const keyId = String(input.KeyId);
    if (name === "EncryptCommand") {
      const key = this.symmetric.get(keyId);
      if (!key) throw Object.assign(new Error("NotFoundException"), { name: "NotFoundException" });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext ?? {})));
      const body = Buffer.concat([cipher.update(input.Plaintext as Uint8Array), cipher.final()]);
      return { CiphertextBlob: new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), body])), KeyId: keyId };
    }
    if (name === "DecryptCommand") {
      const key = this.symmetric.get(keyId);
      if (!key) throw Object.assign(new Error("NotFoundException"), { name: "NotFoundException" });
      const blob = Buffer.from(input.CiphertextBlob as Uint8Array);
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(input.EncryptionContext ?? {})));
      decipher.setAuthTag(blob.subarray(12, 28));
      try {
        return { Plaintext: new Uint8Array(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])), KeyId: keyId };
      } catch {
        throw Object.assign(new Error("InvalidCiphertextException"), { name: "InvalidCiphertextException" });
      }
    }
    if (name === "GetPublicKeyCommand") {
      const key = this.signing.get(keyId);
      if (!key) throw Object.assign(new Error("NotFoundException"), { name: "NotFoundException" });
      return { PublicKey: new Uint8Array(Buffer.concat([spkiPrefix, Buffer.from(secp256k1.getPublicKey(key, false))])), KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY", KeyId: keyId };
    }
    if (name === "SignCommand") {
      const key = this.signing.get(keyId);
      if (!key) throw Object.assign(new Error("NotFoundException"), { name: "NotFoundException" });
      if (input.MessageType !== "DIGEST" || input.SigningAlgorithm !== "ECDSA_SHA_256") throw new Error("Unsupported signing request");
      // KMS does not normalise s; half the signatures come back high-s.
      const signature = secp256k1.sign(input.Message as Uint8Array, key, { lowS: false });
      const r = Buffer.from(signature.r.toString(16).padStart(64, "0"), "hex");
      const s = Buffer.from(signature.s.toString(16).padStart(64, "0"), "hex");
      const body = Buffer.concat([derInteger(r), derInteger(s)]);
      return { Signature: new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body])), KeyId: keyId, SigningAlgorithm: "ECDSA_SHA_256" };
    }
    throw new Error(`SoftKms does not implement ${name}`);
  }
}

/** Command classes with the AWS SDK's names, so SoftKms can be driven through `awsKmsClient` without the SDK installed. */
export const softKmsCommands = {
  EncryptCommand: class EncryptCommand { constructor(readonly input: unknown) {} },
  DecryptCommand: class DecryptCommand { constructor(readonly input: unknown) {} },
  GetPublicKeyCommand: class GetPublicKeyCommand { constructor(readonly input: unknown) {} },
  SignCommand: class SignCommand { constructor(readonly input: unknown) {} }
};
