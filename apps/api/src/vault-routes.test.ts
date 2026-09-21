import { describe, expect, it } from "vitest";
import { verifyVaultDeployment, type VaultPlan } from "@ai-neobank/domain";
import { planFromRequest, prepareVaultSchema, recordVaultSchema, vaultStatusSchema } from "./vault-routes.js";

const safeRequest = {
  governance: "safe" as const,
  network: "eip155:84532",
  owners: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "0x2222222222222222222222222222222222222222"],
  threshold: 2,
  executor: "0x3333333333333333333333333333333333333333"
};

const squadsRequest = {
  governance: "squads" as const,
  network: "solana:devnet",
  owners: ["4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "8FE27ioQh3T7o22QsYVT5Re8NnHFqmFNbdqwiF3ywuZQ"],
  threshold: 2,
  executor: "CjHGSw2G8SHwYnQhQHAvAAfXhGdkSXLZGPKqKhzhPGjA"
};

const planOf = (result: ReturnType<typeof planFromRequest>): VaultPlan => {
  if (!result.ok) throw new Error(`Expected a plan, got ${result.problems.join(", ")}`);
  return result.plan;
};

describe("planFromRequest", () => {
  it("checksums EVM owners, so the same wallets in any case are one plan", () => {
    const plan = planOf(planFromRequest(safeRequest));
    expect(plan.chainFamily).toBe("evm");
    expect(plan.owners[0]).not.toBe(safeRequest.owners[0]);
    expect(plan.owners[0]!.toLowerCase()).toBe(safeRequest.owners[0]);
    expect(planOf(planFromRequest({ ...safeRequest, owners: plan.owners }))).toEqual(plan);
  });

  it("keeps Solana keys exactly as they are", () => {
    expect(planOf(planFromRequest(squadsRequest))).toEqual({ ...squadsRequest, chainFamily: "svm" });
  });

  it("reports an address that is not an address at all", () => {
    expect(planFromRequest({ ...safeRequest, owners: ["not-an-address", ...safeRequest.owners] })).toEqual({ ok: false, problems: ["owner_address_invalid"] });
    expect(planFromRequest({ ...safeRequest, executor: "0xnope" })).toEqual({ ok: false, problems: ["executor_address_invalid"] });
  });

  it("refuses a wallet from the wrong chain family", () => {
    expect(planFromRequest({ ...squadsRequest, owners: [...squadsRequest.owners, safeRequest.executor] }).ok).toBe(false);
  });

  it("applies the shared rules: the executor is never an owner", () => {
    const result = planFromRequest({ ...safeRequest, executor: safeRequest.owners[1]! });
    expect(result).toEqual({ ok: false, problems: ["executor_must_not_be_an_owner"] });
  });
});

describe("verify before record", () => {
  it("records only when the chain shows the vault that was planned", () => {
    const plan = planOf(planFromRequest(safeRequest));
    const address = "0x9999999999999999999999999999999999999999";
    const registeringWallets = [safeRequest.owners[0]!];
    expect(verifyVaultDeployment({ plan, address, registeringWallets, observed: { governance: "safe", owners: plan.owners, threshold: 2 } })).toEqual({ ok: true });
    const swapped = verifyVaultDeployment({
      plan, address, registeringWallets,
      observed: { governance: "safe", owners: [plan.owners[0]!, "0x4444444444444444444444444444444444444444"], threshold: 2 }
    });
    expect(swapped.ok ? null : swapped.refusal.code).toBe("owners_do_not_match_plan");
  });

  it("gives a refusal the route can answer with directly", () => {
    const plan = planOf(planFromRequest(safeRequest));
    const result = verifyVaultDeployment({
      plan, address: "0x9999999999999999999999999999999999999999", registeringWallets: ["0x4444444444444444444444444444444444444444"],
      observed: { governance: "safe", owners: plan.owners, threshold: 2 }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.status).toBe(403);
      expect(result.refusal.message.length).toBeGreaterThan(0);
    }
  });
});

describe("wire schemas", () => {
  it("prepare needs a CAIP-2 network, at least one owner and a whole threshold", () => {
    const base = { governance: "safe", network: "eip155:84532", owners: safeRequest.owners, threshold: 2, executorSignerId: "0f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" };
    expect(prepareVaultSchema.safeParse(base).success).toBe(true);
    expect(prepareVaultSchema.safeParse({ ...base, network: "base-sepolia" }).success).toBe(false);
    expect(prepareVaultSchema.safeParse({ ...base, owners: [] }).success).toBe(false);
    expect(prepareVaultSchema.safeParse({ ...base, threshold: 0 }).success).toBe(false);
    expect(prepareVaultSchema.safeParse({ ...base, executorSignerId: "executor-1" }).success).toBe(false);
  });

  it("recording a Squads vault needs its multisig, and a salt belongs to a Safe", () => {
    const base = {
      name: "Operations", network: "solana:devnet", address: squadsRequest.owners[0]!, owners: squadsRequest.owners, threshold: 2,
      executorSignerId: "0f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    };
    expect(recordVaultSchema.safeParse({ ...base, governance: "squads" }).success).toBe(false);
    expect(recordVaultSchema.safeParse({ ...base, governance: "squads", multisigPda: "GgQ5FfCCVPYBmnxkbMrdmp8hWpWbtqNJuWdmXQxYqTVi" }).success).toBe(true);
    expect(recordVaultSchema.safeParse({ ...base, governance: "squads", multisigPda: "GgQ5FfCCVPYBmnxkbMrdmp8hWpWbtqNJuWdmXQxYqTVi", saltNonce: "12" }).success).toBe(false);
    expect(recordVaultSchema.safeParse({ ...base, governance: "safe", network: "eip155:84532", address: safeRequest.owners[0]!, owners: safeRequest.owners, saltNonce: "12" }).success).toBe(true);
    expect(recordVaultSchema.safeParse({ ...base, governance: "safe", network: "eip155:84532", address: safeRequest.owners[0]!, owners: safeRequest.owners, saltNonce: "0x12" }).success).toBe(false);
  });

  it("reading a Squads vault back needs its multisig too", () => {
    expect(vaultStatusSchema.safeParse({ governance: "squads", network: "solana:devnet", address: squadsRequest.owners[0]! }).success).toBe(false);
    expect(vaultStatusSchema.safeParse({ governance: "safe", network: "eip155:84532", address: safeRequest.owners[0]! }).success).toBe(true);
  });
});
