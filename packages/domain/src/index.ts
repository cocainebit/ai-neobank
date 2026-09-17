import { z } from "zod";

export const chainFamilySchema = z.enum(["evm", "svm"]);
export type ChainFamily = z.infer<typeof chainFamilySchema>;

export const treasuryAccountSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  name: z.string().min(1).max(80),
  chainFamily: chainFamilySchema,
  network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/, "Use a CAIP-2 network identifier"),
  address: z.string().min(20),
  governance: z.enum(["safe", "squads"]),
  frozen: z.boolean().default(false)
});
export type TreasuryAccount = z.infer<typeof treasuryAccountSchema>;

export const paymentIntentSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  organizationId: z.string().min(1),
  treasuryAccountId: z.string().min(1),
  requesterId: z.string().min(1),
  network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/),
  assetId: z.string().min(1),
  amountBaseUnits: z.string().regex(/^\d+$/),
  destination: z.string().min(1),
  purpose: z.string().min(3).max(280),
  expiresAt: z.string().datetime(),
  kind: z.enum(["transfer", "x402"])
});
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

export const spendingPolicySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  frozen: z.boolean(),
  maxPerTransactionBaseUnits: z.string().regex(/^\d+$/),
  maxDailyBaseUnits: z.string().regex(/^\d+$/),
  autoApproveUpToBaseUnits: z.string().regex(/^\d+$/),
  allowedNetworks: z.array(z.string()).min(1),
  allowedAssets: z.array(z.string()).min(1),
  allowedDestinations: z.array(z.string()).default([]),
  humanApprovalRequired: z.boolean().default(false)
});
export type SpendingPolicy = z.infer<typeof spendingPolicySchema>;

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
  "submitted",
  "finalized",
  "reconciled",
  "failed",
  "expired"
] as const;
export type IntentStatus = (typeof intentStatuses)[number];
