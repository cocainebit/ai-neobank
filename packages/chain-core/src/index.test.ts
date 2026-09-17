import { describe, expect, it } from "vitest";
import { assertPositiveTransfer } from "./index.js";

describe("chain adapter invariants", () => {
  it("rejects zero-value transfers", () => {
    expect(() => assertPositiveTransfer({
      from: "alice",
      to: "bob",
      amountBaseUnits: 0n,
      idempotencyKey: "request-001"
    })).toThrow("positive");
  });
});
