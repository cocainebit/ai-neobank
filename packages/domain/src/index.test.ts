import { describe, expect, it } from "vitest";
import { paymentIntentSchema, treasuryAccountSchema } from "./index.js";

describe("multichain domain schemas", () => {
  it("accepts CAIP-2 identifiers for EVM and Solana treasuries", () => {
    const common = {
      organizationId: "org_1",
      name: "Operations",
      address: "0x0000000000000000000000000000000000000001",
      frozen: false
    };

    expect(treasuryAccountSchema.parse({
      ...common,
      id: "evm_1",
      chainFamily: "evm",
      network: "eip155:84532",
      governance: "safe"
    }).network).toBe("eip155:84532");

    expect(treasuryAccountSchema.parse({
      ...common,
      id: "svm_1",
      chainFamily: "svm",
      network: "solana:devnet",
      governance: "squads"
    }).network).toBe("solana:devnet");
  });

  it("rejects decimal amounts at the domain boundary", () => {
    const result = paymentIntentSchema.safeParse({
      id: "983551f8-40f1-4c17-884a-55dfa22dc810",
      idempotencyKey: "request-001",
      organizationId: "org_1",
      treasuryAccountId: "treasury_1",
      requesterId: "agent_1",
      network: "eip155:84532",
      assetId: "native",
      amountBaseUnits: "1.5",
      destination: "0x0000000000000000000000000000000000000002",
      purpose: "Test payment",
      expiresAt: "2027-01-01T00:00:00.000Z",
      kind: "transfer"
    });
    expect(result.success).toBe(false);
  });
});
