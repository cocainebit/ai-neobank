import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSigner } from "./index.js";

describe("signer vault primitives", () => {
  it.each(["evm", "svm"] as const)("generates and encrypts a %s signer", (family) => {
    const signer = generateSigner(family);
    const key = new Uint8Array(32).fill(7);
    const encrypted = encryptSecret(signer.secret, key);
    expect(signer.address.length).toBeGreaterThan(20);
    expect(Buffer.from(decryptSecret(encrypted, key))).toEqual(Buffer.from(signer.secret));
    expect(encrypted.ciphertext).not.toContain(Buffer.from(signer.secret).toString("base64"));
  });
});
