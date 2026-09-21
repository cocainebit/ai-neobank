import { z } from "zod";
import { networkSchema, type ChainFamily } from "./index.js";

/**
 * Vault creation rules, shared and pure. A vault is a treasury whose keys the
 * organisation's people hold: a Safe on an EVM chain or a Squads multisig on
 * Solana. Relay never owns one, so everything here describes what the owner's
 * wallet is asked to deploy and what the deployed account must look like before
 * Relay will record it.
 *
 * Nothing in this module reads a chain or a database.
 */

export const vaultGovernances = ["safe", "squads"] as const;
export type VaultGovernance = (typeof vaultGovernances)[number];
export const vaultGovernanceSchema = z.enum(vaultGovernances);

/** Safe exists on EVM, Squads on Solana. Neither crosses to the other family. */
export const vaultChainFamilies: Record<VaultGovernance, ChainFamily> = { safe: "evm", squads: "svm" };

/** CAIP-2 prefix each family's networks carry. */
export const vaultNetworkPrefixes: Record<ChainFamily, string> = { evm: "eip155:", svm: "solana:" };

const addressShapes: Record<ChainFamily, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  svm: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
};

/** Shape only. A well-formed address still has to exist on the chain. */
export function isVaultAddress(chainFamily: ChainFamily, address: string): boolean {
  return addressShapes[chainFamily].test(address);
}

/** EVM addresses differ only by checksum case; Solana addresses are compared exactly. */
export function vaultAddressKey(chainFamily: ChainFamily, address: string): string {
  return chainFamily === "evm" ? address.toLowerCase() : address;
}

export function sameVaultAddress(chainFamily: ChainFamily, left: string, right: string): boolean {
  return vaultAddressKey(chainFamily, left) === vaultAddressKey(chainFamily, right);
}

/** Two address lists holding the same members, order and checksum case aside. */
export function sameVaultAddressSet(chainFamily: ChainFamily, left: string[], right: string[]): boolean {
  const wanted = new Set(left.map((value) => vaultAddressKey(chainFamily, value)));
  const found = new Set(right.map((value) => vaultAddressKey(chainFamily, value)));
  return wanted.size === found.size && [...wanted].every((value) => found.has(value));
}

export const vaultPlanInputSchema = z.object({
  governance: vaultGovernanceSchema,
  network: networkSchema,
  /** The people who vote. Every owner is a wallet the organisation controls. */
  owners: z.array(z.string().min(20)).min(1).max(20),
  threshold: z.number().int().min(1).max(20),
  /** The organisation's executor signer. It submits approved transactions and never votes. */
  executor: z.string().min(20)
});
export type VaultPlanInput = z.infer<typeof vaultPlanInputSchema>;

export interface VaultPlan {
  governance: VaultGovernance;
  chainFamily: ChainFamily;
  network: string;
  owners: string[];
  threshold: number;
  executor: string;
}

export const vaultPlanProblems = [
  "network_does_not_match_governance",
  "owner_address_invalid",
  "duplicate_owner",
  "executor_address_invalid",
  "executor_must_not_be_an_owner",
  "threshold_above_owner_count"
] as const;
export type VaultPlanProblem = (typeof vaultPlanProblems)[number];

export type VaultPlanResult = { ok: true; plan: VaultPlan } | { ok: false; problems: VaultPlanProblem[] };

/**
 * Validates a vault the console is about to have a wallet deploy. Every problem
 * is reported, not just the first, so the form can mark each field.
 */
export function planVault(input: VaultPlanInput): VaultPlanResult {
  const chainFamily = vaultChainFamilies[input.governance];
  const problems: VaultPlanProblem[] = [];
  if (!input.network.startsWith(vaultNetworkPrefixes[chainFamily])) problems.push("network_does_not_match_governance");
  if (!input.owners.every((owner) => isVaultAddress(chainFamily, owner))) problems.push("owner_address_invalid");
  if (new Set(input.owners.map((owner) => vaultAddressKey(chainFamily, owner))).size !== input.owners.length) problems.push("duplicate_owner");
  if (!isVaultAddress(chainFamily, input.executor)) problems.push("executor_address_invalid");
  else if (input.owners.some((owner) => sameVaultAddress(chainFamily, owner, input.executor))) problems.push("executor_must_not_be_an_owner");
  if (input.threshold > input.owners.length) problems.push("threshold_above_owner_count");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, plan: { governance: input.governance, chainFamily, network: input.network, owners: input.owners, threshold: input.threshold, executor: input.executor } };
}

/** Squads members Relay asks for: the owners vote, the executor only initiates and executes. */
export function squadsMembersFor(plan: VaultPlan): { key: string; role: "owner" | "executor" }[] {
  return [...plan.owners.map((key) => ({ key, role: "owner" as const })), { key: plan.executor, role: "executor" as const }];
}

export interface SquadsVaultMember {
  key: string;
  canInitiate: boolean;
  canVote: boolean;
  canExecute: boolean;
}

/** What the chain says the deployed account is, read back through an adapter. */
export type VaultObservation =
  | { governance: "safe"; owners: string[]; threshold: number }
  | { governance: "squads"; vaultPda: string; threshold: number; members: SquadsVaultMember[] };

export const vaultRefusals = [
  "observation_does_not_match_governance",
  "owners_do_not_match_plan",
  "threshold_does_not_match_plan",
  "executor_must_not_be_an_owner",
  "executor_needs_initiate_and_execute",
  "executor_must_not_vote",
  "registering_wallet_is_not_an_owner",
  "registering_wallet_is_not_a_voting_member",
  "address_is_not_vault_zero_of_multisig"
] as const;
export type VaultRefusalCode = (typeof vaultRefusals)[number];

export interface VaultRefusal {
  code: VaultRefusalCode;
  message: string;
  /** 403 when the person registering has no claim to the vault, 422 when the vault is not what was asked for. */
  status: 403 | 422;
}

export type VaultVerification = { ok: true } | { ok: false; refusal: VaultRefusal };

const refuse = (code: VaultRefusalCode, message: string, status: 403 | 422 = 422): VaultVerification => ({ ok: false, refusal: { code, message, status } });

export interface VaultVerificationInput {
  plan: VaultPlan;
  /** The treasury address being registered: the Safe itself, or vault 0 of the multisig. */
  address: string;
  /** Wallets of the person registering, on the vault's chain family. */
  registeringWallets: string[];
  observed: VaultObservation;
}

/**
 * The verify-before-record rule. The plan is what the client says it asked for
 * and the observation is what the chain says exists; a treasury may only be
 * recorded when they agree, the person registering is one of the vault's own
 * voters, and the executor can submit without ever voting.
 *
 * Nothing here trusts the client: every identity is checked against the
 * observation, never against the request.
 */
export function verifyVaultDeployment(input: VaultVerificationInput): VaultVerification {
  const { plan, observed, registeringWallets } = input;
  if (observed.governance !== plan.governance) return refuse("observation_does_not_match_governance", "The account on chain is not the kind of vault that was planned.");
  const family = plan.chainFamily;
  // The executor is checked first: a key that both submits and approves is the
  // one failure that must be named plainly, and it also shifts the owner set.
  if (observed.governance === "safe") {
    if (observed.owners.some((owner) => sameVaultAddress(family, owner, plan.executor))) return refuse("executor_must_not_be_an_owner", "The Relay executor is an owner of this Safe. It submits approved transactions and must never be able to approve one.");
    if (!sameVaultAddressSet(family, plan.owners, observed.owners)) return refuse("owners_do_not_match_plan", "The Safe on chain has different owners from the ones that were asked for.");
    if (observed.threshold !== plan.threshold) return refuse("threshold_does_not_match_plan", `The Safe on chain needs ${observed.threshold} of its owners to sign, not ${plan.threshold}.`);
    if (!registeringWallets.some((wallet) => observed.owners.some((owner) => sameVaultAddress(family, owner, wallet)))) {
      return refuse("registering_wallet_is_not_an_owner", "Your wallet is not an owner of this Safe.", 403);
    }
    return { ok: true };
  }
  if (!sameVaultAddress(family, observed.vaultPda, input.address)) return refuse("address_is_not_vault_zero_of_multisig", "That address is not vault 0 of this multisig.");
  const executor = observed.members.find((member) => sameVaultAddress(family, member.key, plan.executor));
  if (!executor || !executor.canInitiate || !executor.canExecute) return refuse("executor_needs_initiate_and_execute", "The Relay executor needs Initiate and Execute on this multisig, or it cannot submit an approved payment.");
  if (executor.canVote) return refuse("executor_must_not_vote", "The Relay executor can vote on this multisig. It submits approved transactions and must never be able to approve one.");
  const voters = observed.members.filter((member) => member.canVote).map((member) => member.key);
  if (!sameVaultAddressSet(family, plan.owners, voters)) return refuse("owners_do_not_match_plan", "The multisig on chain has different voting members from the owners that were asked for.");
  if (observed.threshold !== plan.threshold) return refuse("threshold_does_not_match_plan", `The multisig on chain needs ${observed.threshold} votes, not ${plan.threshold}.`);
  if (!registeringWallets.some((wallet) => voters.some((voter) => sameVaultAddress(family, voter, wallet)))) {
    return refuse("registering_wallet_is_not_a_voting_member", "Your wallet is not a voting member of this multisig.", 403);
  }
  return { ok: true };
}
