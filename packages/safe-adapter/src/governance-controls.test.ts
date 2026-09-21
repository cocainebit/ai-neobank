import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, keccak256, parseAbiParameters, toBytes, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compileSafeRejection, recoverSafeSigner, safeRejectionCancels, safeTransactionHash, safeTypedData, type CompiledSafeTransaction } from "./index.js";

const chainId = 31337;
const safe = "0x1111111111111111111111111111111111111111";
const zero = "0x0000000000000000000000000000000000000000";

/** The Safe's own hashing, written out again so the test does not just repeat the implementation. */
function digestOf(compiled: CompiledSafeTransaction, safeAddress: string) {
  const typeHash = keccak256(toBytes("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"));
  const domainTypeHash = keccak256(toBytes("EIP712Domain(uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256, address"), [domainTypeHash, BigInt(chainId), safeAddress as Address]));
  const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, address, uint256, bytes32, uint8, uint256, uint256, uint256, address, address, uint256"),
    [typeHash, compiled.to as Address, BigInt(compiled.value), keccak256(compiled.data as `0x${string}`), compiled.operation, BigInt(compiled.safeTxGas), BigInt(compiled.baseGas), BigInt(compiled.gasPrice), compiled.gasToken as Address, compiled.refundReceiver as Address, BigInt(compiled.nonce)]
  ));
  return keccak256(concat(["0x19", "0x01", domainSeparator, structHash]));
}

const transfer = (nonce: number): CompiledSafeTransaction => ({
  to: "0x2222222222222222222222222222222222222222", value: "1000000000000000000", data: "0x", operation: 0,
  safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero, nonce, safeTxHash: "0xdead"
});

describe("Safe rejection transaction", () => {
  it("is a zero value call from the Safe to itself at the payment's nonce", () => {
    const rejection = compileSafeRejection(chainId, safe, 7);
    expect(rejection).toMatchObject({ to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x", operation: 0, nonce: 7, gasToken: zero, refundReceiver: zero });
  });

  it("hashes exactly as the Safe hashes it", () => {
    const rejection = compileSafeRejection(chainId, safe, 7);
    expect(rejection.safeTxHash).toBe(digestOf(rejection, safe));
    expect(safeTransactionHash(chainId, safe, rejection)).toBe(rejection.safeTxHash);
  });

  it("commits to the chain, the Safe and the nonce, so a signature cannot be replayed elsewhere", () => {
    const hash = compileSafeRejection(chainId, safe, 7).safeTxHash;
    expect(compileSafeRejection(8453, safe, 7).safeTxHash).not.toBe(hash);
    expect(compileSafeRejection(chainId, "0x3333333333333333333333333333333333333333", 7).safeTxHash).not.toBe(hash);
    expect(compileSafeRejection(chainId, safe, 8).safeTxHash).not.toBe(hash);
    expect(compileSafeRejection(chainId, safe.toUpperCase().replace("0X", "0x"), 7).safeTxHash).toBe(hash);
  });

  it("refuses a nonce that is not a whole number at or above zero", () => {
    expect(() => compileSafeRejection(chainId, safe, -1)).toThrow(/nonce/);
    expect(() => compileSafeRejection(chainId, safe, 1.5)).toThrow(/nonce/);
  });

  it("cancels the payment only when it burns the same nonce and moves nothing", () => {
    const payment = transfer(7);
    expect(safeRejectionCancels(compileSafeRejection(chainId, safe, 7), payment, safe)).toBe(true);
    expect(safeRejectionCancels(compileSafeRejection(chainId, safe, 8), payment, safe)).toBe(false);
    expect(safeRejectionCancels({ ...compileSafeRejection(chainId, safe, 7), value: "1" }, payment, safe)).toBe(false);
    expect(safeRejectionCancels({ ...compileSafeRejection(chainId, safe, 7), data: "0xa9059cbb" }, payment, safe)).toBe(false);
    expect(safeRejectionCancels({ ...compileSafeRejection(chainId, safe, 7), operation: 1 }, payment, safe)).toBe(false);
    expect(safeRejectionCancels(compileSafeRejection(chainId, safe, 7), payment, "0x3333333333333333333333333333333333333333")).toBe(false);
  });

  it("recovers the owner that signed it, the same way an approval does", async () => {
    const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const rejection = compileSafeRejection(chainId, safe, 3);
    const signature = await owner.signTypedData(safeTypedData(chainId, safe, rejection));
    expect((await recoverSafeSigner(rejection.safeTxHash, signature)).toLowerCase()).toBe(owner.address.toLowerCase());
    // A signature over a different nonce is not a signature over this rejection.
    const other = await owner.signTypedData(safeTypedData(chainId, safe, compileSafeRejection(chainId, safe, 4)));
    expect((await recoverSafeSigner(rejection.safeTxHash, other)).toLowerCase()).not.toBe(owner.address.toLowerCase());
  });
});
