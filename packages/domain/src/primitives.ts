import { z } from "zod";

/**
 * The handful of schemas the rest of the domain builds on.
 *
 * They live here rather than in index.ts because index.ts re-exports the
 * modules beside it, and a re-exported module is evaluated before index's own
 * body runs. A module that imports a value from index therefore reads it before
 * it exists: under Node that is a ReferenceError at boot, and the test runner's
 * loader hides it. Anything a re-exported module needs as a value belongs in
 * this file, which imports nothing of ours and so cannot take part in a cycle.
 */

export const chainFamilySchema = z.enum(["evm", "svm"]);
export type ChainFamily = z.infer<typeof chainFamilySchema>;

export const networkSchema = z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/, "Use a CAIP-2 network identifier");

/** Every state a payment intent can be in, in the order it moves through them. */
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

/** Who a principal can be to an organisation. An agent is a principal too. */
export const principalRoles = ["owner", "approver", "operator", "auditor", "developer", "agent"] as const;
export type PrincipalRole = (typeof principalRoles)[number];
