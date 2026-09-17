import { z } from "zod";

export const chainFamilySchema = z.enum(["evm", "svm"]);
export type ChainFamily = z.infer<typeof chainFamilySchema>;

export const networkSchema = z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/, "Use a CAIP-2 network identifier");

export const treasuryAccountSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  name: z.string().min(1).max(80),
  chainFamily: chainFamilySchema,
  network: networkSchema,
  address: z.string().min(20),
  governance: z.enum(["safe", "squads", "direct"]),
  frozen: z.boolean().default(false)
});
export type TreasuryAccount = z.infer<typeof treasuryAccountSchema>;

export const intentKinds = ["transfer", "x402"] as const;

export const paymentIntentSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  organizationId: z.string().min(1),
  treasuryAccountId: z.string().min(1),
  requesterId: z.string().min(1),
  network: networkSchema,
  assetId: z.string().min(1),
  amountBaseUnits: z.string().regex(/^\d+$/),
  destination: z.string().min(1),
  purpose: z.string().min(3).max(280),
  expiresAt: z.string().datetime(),
  kind: z.enum(intentKinds)
});
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

/**
 * A spending policy. Amounts are base units of the asset being spent; the
 * per-transaction and daily caps apply per asset, so a policy that allows several
 * assets caps each one separately.
 */
export const spendingPolicySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  frozen: z.boolean().default(false),
  maxPerTransactionBaseUnits: z.string().regex(/^\d+$/),
  maxDailyBaseUnits: z.string().regex(/^\d+$/),
  autoApproveUpToBaseUnits: z.string().regex(/^\d+$/).default("0"),
  allowedNetworks: z.array(networkSchema).min(1),
  allowedAssets: z.array(z.string().min(1)).min(1),
  allowedDestinations: z.array(z.string()).default([]),
  allowedKinds: z.array(z.enum(intentKinds)).min(1).default(["transfer"]),
  humanApprovalRequired: z.boolean().default(true),
  minApprovals: z.number().int().min(1).max(20).default(1),
  /** Transfers may only go to owner-approved beneficiaries. Does not apply to x402, whose destination is a URL. */
  requireBeneficiary: z.boolean().default(false)
});
export type SpendingPolicy = z.infer<typeof spendingPolicySchema>;

/** The editable part of a policy, as stored in policy_versions.definition. */
export const policyDefinitionSchema = spendingPolicySchema.omit({ id: true, version: true });
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
/** A definition as callers write it: omitted fields take the schema defaults. */
export type PolicyDefinitionInput = z.input<typeof policyDefinitionSchema>;

export type PolicyDecision =
  | { outcome: "rejected"; reasons: string[] }
  | { outcome: "approval_required"; reasons: string[] }
  | { outcome: "auto_authorized"; reasons: string[] };

export const intentStatuses = [
  "received",
  "policy_evaluated",
  "rejected",
  "approval_required",
  "auto_authorized",
  "approved",
  "executing",
  "submitted",
  "finalized",
  "reconciled",
  "failed",
  "expired"
] as const;
export type IntentStatus = (typeof intentStatuses)[number];

export const principalRoles = ["owner", "approver", "operator", "auditor", "developer", "agent"] as const;
export type PrincipalRole = (typeof principalRoles)[number];

/** Native coin asset identifiers, SLIP-44 style, keyed by chain family. */
export const nativeAssetIds: Record<ChainFamily, string> = { evm: "slip44:60", svm: "slip44:501" };

/** CAIP-19-style asset identifier for a token on a network. */
export function tokenAssetId(network: string, kind: "erc20" | "spl", address: string): string {
  return `${network}/${kind}:${address}`;
}
