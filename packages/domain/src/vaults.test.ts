import { describe, expect, it } from "vitest";
import { planVault, sameVaultAddressSet, squadsMembersFor, vaultPlanInputSchema, verifyVaultDeployment, type SquadsVaultMember, type VaultPlan, type VaultPlanInput, type VaultVerification } from "./vaults.js";

const safePlan: VaultPlanInput = {
  governance: "safe",
  network: "eip155:84532",
  owners: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
  threshold: 2,
  executor: "0x3333333333333333333333333333333333333333"
};

const squadsPlan: VaultPlanInput = {
  governance: "squads",
  network: "solana:devnet",
  owners: ["4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "8FE27ioQh3T7o22QsYVT5Re8NnHFqmFNbdqwiF3ywuZQ"],
  threshold: 2,
  executor: "CjHGSw2G8SHwYnQhQHAvAAfXhGdkSXLZGPKqKhzhPGjA"
};

describe("planVault", () => {
  it("accepts a Safe on an EVM network and a Squads vault on Solana", () => {
    expect(planVault(safePlan)).toEqual({ ok: true, plan: { ...safePlan, chainFamily: "evm" } });
    expect(planVault(squadsPlan)).toEqual({ ok: true, plan: { ...squadsPlan, chainFamily: "svm" } });
  });

  it("refuses a governance kind that does not belong to the network", () => {
    expect(planVault({ ...safePlan, network: "solana:devnet" })).toEqual({ ok: false, problems: ["network_does_not_match_governance"] });
    expect(planVault({ ...squadsPlan, network: "eip155:84532" })).toEqual({ ok: false, problems: ["network_does_not_match_governance"] });
  });

  it("refuses a threshold above the number of owners", () => {
    expect(planVault({ ...safePlan, threshold: 3 })).toEqual({ ok: false, problems: ["threshold_above_owner_count"] });
  });

  it("refuses an owner listed twice, whatever the checksum case", () => {
    const result = planVault({ ...safePlan, owners: [safePlan.owners[0]!, safePlan.owners[0]!.toUpperCase().replace("0X", "0x")], threshold: 1 });
    expect(result).toEqual({ ok: false, problems: ["duplicate_owner"] });
  });

  it("keeps the executor out of the owners, so the key that submits never votes", () => {
    const result = planVault({ ...safePlan, executor: safePlan.owners[1]!.toUpperCase().replace("0X", "0x") });
    expect(result).toEqual({ ok: false, problems: ["executor_must_not_be_an_owner"] });
  });

  it("refuses addresses that are not of the chain family", () => {
    expect(planVault({ ...safePlan, owners: ["0xnope", ...safePlan.owners] })).toEqual({ ok: false, problems: ["owner_address_invalid"] });
    expect(planVault({ ...squadsPlan, executor: "0x3333333333333333333333333333333333333333" })).toEqual({ ok: false, problems: ["executor_address_invalid"] });
  });

  it("reports every problem at once", () => {
    const result = planVault({ ...safePlan, network: "solana:devnet", threshold: 9 });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems).toEqual(["network_does_not_match_governance", "threshold_above_owner_count"]);
  });

  it("holds the wire schema to a CAIP-2 network and at least one owner", () => {
    expect(vaultPlanInputSchema.safeParse({ ...safePlan, network: "base-sepolia" }).success).toBe(false);
    expect(vaultPlanInputSchema.safeParse({ ...safePlan, owners: [] }).success).toBe(false);
    expect(vaultPlanInputSchema.safeParse({ ...safePlan, threshold: 1.5 }).success).toBe(false);
    expect(vaultPlanInputSchema.safeParse(safePlan).success).toBe(true);
  });
});

describe("squadsMembersFor", () => {
  it("gives the owners a vote and the executor none", () => {
    const plan = planVault(squadsPlan);
    expect(plan.ok).toBe(true);
    const members = squadsMembersFor(plan.ok ? plan.plan : { ...squadsPlan, chainFamily: "svm" });
    expect(members.filter((member) => member.role === "owner").map((member) => member.key)).toEqual(squadsPlan.owners);
    expect(members.filter((member) => member.role === "executor")).toEqual([{ key: squadsPlan.executor, role: "executor" }]);
  });
});

const safeVault: VaultPlan = { ...safePlan, chainFamily: "evm" };
const squadsVault: VaultPlan = { ...squadsPlan, chainFamily: "svm" };
const vaultPda = "GgQ5FfCCVPYBmnxkbMrdmp8hWpWbtqNJuWdmXQxYqTVi";
const refusalOf = (result: VaultVerification) => (result.ok ? null : result.refusal.code);

function squadsMembers(overrides: Partial<SquadsVaultMember> = {}): SquadsVaultMember[] {
  return [
    ...squadsVault.owners.map((key) => ({ key, canInitiate: true, canVote: true, canExecute: true })),
    { key: squadsVault.executor, canInitiate: true, canVote: false, canExecute: true, ...overrides }
  ];
}

describe("verifyVaultDeployment", () => {
  it("records a Safe that is exactly what was planned", () => {
    const result = verifyVaultDeployment({
      plan: safeVault,
      address: "0x9999999999999999999999999999999999999999",
      registeringWallets: [safeVault.owners[0]!.toLowerCase()],
      observed: { governance: "safe", owners: [...safeVault.owners].reverse(), threshold: 2 }
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a Safe whose owners or threshold are not the ones that were asked for", () => {
    const address = "0x9999999999999999999999999999999999999999";
    const registeringWallets = [safeVault.owners[0]!];
    expect(refusalOf(verifyVaultDeployment({
      plan: safeVault, address, registeringWallets,
      observed: { governance: "safe", owners: [safeVault.owners[0]!, "0x4444444444444444444444444444444444444444"], threshold: 2 }
    }))).toBe("owners_do_not_match_plan");
    expect(refusalOf(verifyVaultDeployment({
      plan: safeVault, address, registeringWallets,
      observed: { governance: "safe", owners: safeVault.owners, threshold: 1 }
    }))).toBe("threshold_does_not_match_plan");
  });

  it("refuses a Safe that made the executor an owner, and says so with 422", () => {
    const result = verifyVaultDeployment({
      plan: safeVault,
      address: "0x9999999999999999999999999999999999999999",
      registeringWallets: [safeVault.owners[0]!],
      observed: { governance: "safe", owners: [...safeVault.owners, safeVault.executor], threshold: 2 }
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal).toMatchObject({ code: "executor_must_not_be_an_owner", status: 422 });
  });

  it("refuses to record a Safe for someone who does not own it, with 403", () => {
    const result = verifyVaultDeployment({
      plan: safeVault,
      address: "0x9999999999999999999999999999999999999999",
      registeringWallets: ["0x4444444444444444444444444444444444444444"],
      observed: { governance: "safe", owners: safeVault.owners, threshold: 2 }
    });
    expect(result.ok ? null : result.refusal).toMatchObject({ code: "registering_wallet_is_not_an_owner", status: 403 });
  });

  it("records a Squads vault whose voters, threshold and executor permissions all match", () => {
    expect(verifyVaultDeployment({
      plan: squadsVault,
      address: vaultPda,
      registeringWallets: [squadsVault.owners[1]!],
      observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers() }
    })).toEqual({ ok: true });
  });

  it("refuses an address that is not vault 0 of the observed multisig", () => {
    expect(refusalOf(verifyVaultDeployment({
      plan: squadsVault,
      address: squadsVault.owners[0]!,
      registeringWallets: [squadsVault.owners[0]!],
      observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers() }
    }))).toBe("address_is_not_vault_zero_of_multisig");
  });

  it("refuses a Squads executor that cannot execute, or that can vote", () => {
    const base = { plan: squadsVault, address: vaultPda, registeringWallets: [squadsVault.owners[0]!] };
    expect(refusalOf(verifyVaultDeployment({
      ...base, observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers({ canExecute: false }) }
    }))).toBe("executor_needs_initiate_and_execute");
    expect(refusalOf(verifyVaultDeployment({
      ...base, observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers({ canVote: true }) }
    }))).toBe("executor_must_not_vote");
    expect(refusalOf(verifyVaultDeployment({
      ...base, observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers().filter((member) => member.key !== squadsVault.executor) }
    }))).toBe("executor_needs_initiate_and_execute");
  });

  it("counts only voting members as owners, so an extra voter is refused", () => {
    expect(refusalOf(verifyVaultDeployment({
      plan: squadsVault,
      address: vaultPda,
      registeringWallets: [squadsVault.owners[0]!],
      observed: {
        governance: "squads", vaultPda, threshold: 2,
        members: [...squadsMembers(), { key: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG", canInitiate: true, canVote: true, canExecute: true }]
      }
    }))).toBe("owners_do_not_match_plan");
  });

  it("refuses when the account on chain is not the governance kind that was planned", () => {
    expect(refusalOf(verifyVaultDeployment({
      plan: safeVault,
      address: vaultPda,
      registeringWallets: [safeVault.owners[0]!],
      observed: { governance: "squads", vaultPda, threshold: 2, members: squadsMembers() }
    }))).toBe("observation_does_not_match_governance");
  });
});

describe("sameVaultAddressSet", () => {
  it("ignores order and EVM checksum case, and compares Solana keys exactly", () => {
    expect(sameVaultAddressSet("evm", safePlan.owners, [safePlan.owners[1]!.toLowerCase(), safePlan.owners[0]!])).toBe(true);
    expect(sameVaultAddressSet("evm", safePlan.owners, [safePlan.owners[0]!])).toBe(false);
    expect(sameVaultAddressSet("svm", squadsPlan.owners, [...squadsPlan.owners].reverse())).toBe(true);
    expect(sameVaultAddressSet("svm", squadsPlan.owners, [squadsPlan.owners[0]!, squadsPlan.owners[1]!.toLowerCase()])).toBe(false);
  });
});
