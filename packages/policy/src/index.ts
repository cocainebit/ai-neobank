import type { PaymentIntent, PolicyDecision, SpendingPolicy } from "@ai-neobank/domain";

export interface PolicyContext {
  spentTodayBaseUnits: string;
  now: Date;
}

const units = (value: string) => BigInt(value);

export function evaluatePaymentIntent(
  intent: PaymentIntent,
  policy: SpendingPolicy,
  context: PolicyContext
): PolicyDecision {
  const rejectionReasons: string[] = [];
  const amount = units(intent.amountBaseUnits);

  if (policy.frozen) rejectionReasons.push("Policy is frozen");
  if (new Date(intent.expiresAt) <= context.now) rejectionReasons.push("Intent has expired");
  if (!policy.allowedNetworks.includes(intent.network)) rejectionReasons.push("Network is not allowed");
  if (!policy.allowedAssets.includes(intent.assetId)) rejectionReasons.push("Asset is not allowed");
  if (amount > units(policy.maxPerTransactionBaseUnits)) rejectionReasons.push("Per-transaction limit exceeded");
  if (amount + units(context.spentTodayBaseUnits) > units(policy.maxDailyBaseUnits)) {
    rejectionReasons.push("Daily limit exceeded");
  }
  if (
    policy.allowedDestinations.length > 0 &&
    !policy.allowedDestinations.includes(intent.destination)
  ) {
    rejectionReasons.push("Destination is not allowed");
  }

  if (rejectionReasons.length > 0) return { outcome: "rejected", reasons: rejectionReasons };

  if (policy.humanApprovalRequired || amount > units(policy.autoApproveUpToBaseUnits)) {
    return { outcome: "approval_required", reasons: ["Human approval threshold reached"] };
  }

  return { outcome: "auto_authorized", reasons: ["Intent is within delegated authority"] };
}
