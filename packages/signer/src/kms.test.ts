import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, type TransactionSerialized } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { generateSigner, encryptSecret } from "./index.js";
import { KmsKeyProvider, LocalKeyring, awsKmsClient, evmAddressFromSpki, kmsEvmAccount, openSecret, parseDerSignature, parseKeyring, rewrapSecret, sealSecret } from "./kms.js";
import { SoftKms, softKmsCommands } from "./testing.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);

describe("envelope encryption and rotation", () => {
  it("seals under the active key, opens after rotation, and re-wraps without touching the secret ciphertext", async () => {
    const signer = generateSigner("svm");
    const v1 = new LocalKeyring({ v1: key(1) }, "v1");
    const sealed = await sealSecret(signer.secret, v1);
    expect(sealed.dataKeyVersion).toBe("v1");
    expect(Buffer.from(await openSecret(sealed, v1))).toEqual(Buffer.from(signer.secret));

    const both = new LocalKeyring({ v1: key(1), v2: key(2) }, "v2");
    expect(Buffer.from(await openSecret(sealed, both))).toEqual(Buffer.from(signer.secret));
    const rewrapped = await rewrapSecret(sealed, both);
    expect(rewrapped.dataKeyVersion).toBe("v2");
    expect(rewrapped.ciphertext).toBe(sealed.ciphertext);
    const v2Only = new LocalKeyring({ v2: key(2) }, "v2");
    expect(Buffer.from(await openSecret(rewrapped, v2Only))).toEqual(Buffer.from(signer.secret));
    await expect(openSecret(sealed, v2Only)).rejects.toThrow();
  });

  it("migrates a legacy format 1 envelope sealed directly under the master key", async () => {
    const signer = generateSigner("evm");
    const legacy = encryptSecret(signer.secret, key(9));
    const keyring = parseKeyring(`1:${Buffer.from(key(9)).toString("hex")},kms-next:${Buffer.from(key(3)).toString("hex")}`, "kms-next");
    expect(Buffer.from(await openSecret({ ...legacy, keyVersion: 1 }, keyring))).toEqual(Buffer.from(signer.secret));
    const upgraded = await rewrapSecret({ ...legacy, keyVersion: 1 }, keyring);
    expect(upgraded.dataKeyVersion).toBe("kms-next");
    expect(Buffer.from(await openSecret(upgraded, new LocalKeyring({ "kms-next": key(3) }, "kms-next")))).toEqual(Buffer.from(signer.secret));
  });

  it("wraps data keys with KMS Encrypt/Decrypt bound to an encryption context, and rotates across KMS keys", async () => {
    const kms = new SoftKms();
    const client = awsKmsClient(kms, softKmsCommands);
    const first = kms.createSymmetricKey();
    const second = kms.createSymmetricKey();
    const signer = generateSigner("evm");
    const sealed = await sealSecret(signer.secret, new KmsKeyProvider(client, first));
    expect(sealed.dataKeyVersion).toBe(first);
    const encryptCall = kms.calls.find((call) => call.command === "EncryptCommand")!;
    expect(encryptCall.input).toMatchObject({ KeyId: first, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", EncryptionContext: { purpose: "relay-signer-data-key" } });
    const rotated = await rewrapSecret(sealed, new KmsKeyProvider(client, second));
    expect(rotated.dataKeyVersion).toBe(second);
    kms.disable(first);
    expect(Buffer.from(await openSecret(rotated, new KmsKeyProvider(client, second)))).toEqual(Buffer.from(signer.secret));
    await expect(openSecret(sealed, new KmsKeyProvider(client, second))).rejects.toThrow();
  });
});

describe("KMS-held EVM keys", () => {
  it("derives the address from the SPKI public key and signs transactions, messages, and typed data that recover to it", async () => {
    const kms = new SoftKms();
    const client = awsKmsClient(kms, softKmsCommands);
    const keyId = kms.createSigningKey();
    const account = await kmsEvmAccount(client, keyId);
    expect(account.address).toBe(evmAddressFromSpki(await client.getPublicKey(keyId)));
    for (let round = 0; round < 12; round += 1) {
      const raw = await account.signTransaction({ chainId: 31337, type: "eip1559", nonce: round, to: privateKeyToAccount(generatePrivateKey()).address, value: 1n, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });
      expect((await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase()).toBe(account.address.toLowerCase());
      expect(parseTransaction(raw).s!.length).toBeLessThanOrEqual(66);
    }
    const message = "Relay approval decision";
    expect(await recoverMessageAddress({ message, signature: await account.signMessage({ message }) })).toBe(account.address);
    const typed = { domain: { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" as const }, types: { SafeTx: [{ name: "nonce", type: "uint256" }] }, primaryType: "SafeTx" as const, message: { nonce: 7n } };
    expect(await recoverTypedDataAddress({ ...typed, signature: await account.signTypedData(typed) })).toBe(account.address);
    void hashTypedData;
    const signCalls = kms.calls.filter((call) => call.command === "SignCommand");
    expect(signCalls.every((call) => call.input.MessageType === "DIGEST" && call.input.SigningAlgorithm === "ECDSA_SHA_256")).toBe(true);
  });

  it("normalises high-s signatures and rejects malformed DER", () => {
    const n = secp256k1.CURVE.n;
    const high = n - 5n;
    const encode = (value: bigint) => { let hex = value.toString(16); if (hex.length % 2) hex = `0${hex}`; let bytes = Buffer.from(hex, "hex"); if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]); return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]); };
    const body = Buffer.concat([encode(123n), encode(high)]);
    expect(parseDerSignature(Buffer.concat([Buffer.from([0x30, body.length]), body]))).toEqual({ r: 123n, s: 5n });
    expect(() => parseDerSignature(Buffer.from([0x31, 0x00]))).toThrow();
  });
});

describe("real AWS SDK command objects", () => {
  it("builds the commands SoftKms answers, so the adapter matches the SDK's shapes", async () => {
    const sdk = await import("@aws-sdk/client-kms");
    const kms = new SoftKms();
    const client = awsKmsClient(kms as unknown as { send(command: unknown): Promise<unknown> }, sdk as unknown as Parameters<typeof awsKmsClient>[1]);
    const dataKeyId = kms.createSymmetricKey();
    const signingKeyId = kms.createSigningKey();
    const secret = generateSigner("evm").secret;
    const sealed = await sealSecret(secret, new KmsKeyProvider(client, dataKeyId));
    expect(Buffer.from(await openSecret(sealed, new KmsKeyProvider(client, dataKeyId)))).toEqual(Buffer.from(secret));
    const account = await kmsEvmAccount(client, signingKeyId);
    const message = "sdk shapes";
    expect(await recoverMessageAddress({ message, signature: await account.signMessage({ message }) })).toBe(account.address);
    expect(kms.calls.map((call) => call.command)).toEqual(expect.arrayContaining(["EncryptCommand", "DecryptCommand", "GetPublicKeyCommand", "SignCommand"]));
  });
});
