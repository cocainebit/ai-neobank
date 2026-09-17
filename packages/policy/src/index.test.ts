import { describe, expect, it } from "vitest";
import type { PaymentIntent, SpendingPolicy } from "@ai-neobank/domain";
import { evaluatePaymentIntent } from "./index.js";

const intent: PaymentIntent = {
  id: "983551f8-40f1-4c17-884a-55dfa22dc810",
  idempotencyKey: "request-001",
  organizationId: "org_1",
  treasuryAccountId: "treasury_1",
  requesterId: "agent_research",
  network: "eip155:84532",
  assetId: "eip155:84532/erc20:0x0000000000000000000000000000000000000001",
  amountBaseUnits: "25000000",
  destination: "0x0000000000000000000000000000000000000002",
  purpose: "Purchase a market-data report",
  expiresAt: "2027-01-01T00:00:00.000Z",
  kind: "x402"
};

const policy: SpendingPolicy = {
  id: "policy_1",
  version: 1,
  frozen: false,
  maxPerTransactionBaseUnits: "100000000",
  maxDailyBaseUnits: "500000000",
  autoApproveUpToBaseUnits: "50000000",
  allowedNetworks: ["eip155:84532", "solana:devnet"],
  allowedAssets: [intent.assetId],
  allowedDestinations: [],
  humanApprovalRequired: false
};

describe("evaluatePaymentIntent", () => {
  it("auto-authorizes an intent within delegated authority", () => {
    expect(evaluatePaymentIntent(intent, policy, {
      spentTodayBaseUnits: "0",
      now: new Date("2026-09-16T00:00:00.000Z")
    }).outcome).toBe("auto_authorized");
  });

  it("requires approval above the autonomous threshold", () => {
    const decision = evaluatePaymentIntent(
      { ...intent, amountBaseUnits: "75000000" },
      policy,
      { spentTodayBaseUnits: "0", now: new Date("2026-09-16T00:00:00.000Z") }
    );
    expect(decision.outcome).toBe("approval_required");
  });

  it("rejects a frozen policy even when limits permit payment", () => {
    const decision = evaluatePaymentIntent(intent, { ...policy, frozen: true }, {
      spentTodayBaseUnits: "0",
      now: new Date("2026-09-16T00:00:00.000Z")
    });
    expect(decision).toEqual({ outcome: "rejected", reasons: ["Policy is frozen"] });
  });
});
