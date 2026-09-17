export type ChainFamily = "evm" | "svm";
export type Role = "owner" | "approver" | "operator" | "auditor" | "developer" | "agent";

export interface Organization { id: string; name: string; slug: string; environment: string; frozen: boolean; autonomousExecution: boolean; createdAt: string }
export interface Wallet { id: string; principalId: string; chainFamily: ChainFamily; address: string; verifiedAt: string | null }
export interface Member { id: string; displayName: string; role: Role; status: "active" | "frozen" | "revoked"; wallets: Wallet[] }
export interface Session {
  kind: "human";
  organization: Organization;
  principal: { id: string; role: Role; displayName: string; status: string } | null;
  wallet: Wallet | null;
  memberships: { organizationId: string; organizationName: string; role: Role }[];
}

export interface Treasury {
  id: string; name: string; chainFamily: ChainFamily; network: string; address: string;
  governance: "direct" | "safe" | "squads"; status: string; executorSignerId: string | null;
  observedConfiguration: { owners?: string[]; threshold?: number; multisigPda?: string; members?: { key: string; canVote: boolean; canExecute: boolean; canInitiate: boolean }[] };
  createdAt: string;
}
export interface Balance { assetId: string; symbol: string; decimals: number; kind: string; balanceBaseUnits: string | null }
export interface Asset { id: string; network: string; chainFamily: ChainFamily; kind: "native" | "erc20" | "spl"; address: string | null; symbol: string; decimals: number }
export interface Signer { id: string; agentId: string | null; chainFamily: ChainFamily; address: string; custody: "encrypted_software" | "kms" | "external_wallet"; status: string; createdAt: string }

export interface Agent { id: string; principalId: string; displayName: string; purpose: string; status: "active" | "frozen" | "revoked"; capabilityVersion: number; ownerPrincipalId: string | null }
export interface Credential { id: string; keyId: string; label: string | null; status: "active" | "revoked"; createdAt: string; lastUsedAt: string | null }

export interface PolicyDefinition {
  frozen: boolean; maxPerTransactionBaseUnits: string; maxDailyBaseUnits: string; autoApproveUpToBaseUnits: string;
  allowedNetworks: string[]; allowedAssets: string[]; allowedDestinations: string[]; allowedKinds: ("transfer" | "x402")[];
  humanApprovalRequired: boolean; minApprovals: number; requireBeneficiary: boolean;
}
export interface Policy { id: string; name: string; createdAt: string; latest: { id: string; version: number; definition: PolicyDefinition; createdAt: string }; bindings: { id: string; agentId: string | null; treasuryAccountId: string | null }[] }

export interface Intent {
  id: string; idempotencyKey: string; treasuryAccountId: string; requesterId: string; network: string; assetId: string; amountBaseUnits: string;
  destination: string; purpose: string; expiresAt: string; kind: "transfer" | "x402"; status: string; version: number; createdAt: string;
  policyDecision: { outcome?: string; reasons?: string[]; simulation?: { feeBaseUnits?: string; sourceBalanceBaseUnits?: string }; x402?: { url: string; requirements: { amount: string; payTo: string } } } | null;
  failureReason: string | null;
}
export interface IntentEvent { sequence: number; eventType: string; actorPrincipalId: string | null; data: Record<string, unknown>; createdAt: string }
export interface Execution { id: string; status: string; transactionHash: string | null; feeBaseUnits: string | null; confirmations: number | null; error: string | null; observed: { reconciliation?: string } | null; updatedAt: string }
export interface ApprovalRequest { requiredApprovals: number; approvals: number; compiledHash: string | null; simulationHash: string | null; status: string; expiresAt: string; externalRef: Record<string, unknown> | null; decisions: { principalId: string | null; signerAddress: string | null; decision: string; createdAt: string }[] }
export interface IntentDetail { intent: Intent; events: IntentEvent[]; approval: ApprovalRequest | null; execution: Execution | null }

export interface Beneficiary { id: string; name: string; chainFamily: ChainFamily; network: string; address: string; email: string | null; status: "pending" | "active" | "archived"; approvedAt: string | null; createdAt: string }
export interface Schedule { id: string; treasuryAccountId: string; beneficiaryId: string; assetId: string; amountBaseUnits: string; purpose: string; intervalUnit: "day" | "week" | "month"; intervalCount: number; startAt: string; endAt: string | null; maxOccurrences: number | null; nextRunAt: string; occurrencesCreated: number; status: string }
export interface Invoice { id: string; number: string; treasuryAccountId: string; assetId: string; network: string; customerName: string; customerEmail: string | null; memo: string | null; lineItems: { description: string; quantity: number; unitAmountBaseUnits: string }[]; subtotalBaseUnits: string; amountDueBaseUnits: string; amountPaidBaseUnits: string; reference: string | null; publicToken: string; status: "draft" | "open" | "paid" | "void"; issuedAt: string | null; dueAt: string | null; paidAt: string | null; createdAt: string }
export interface Inflow { id: string; treasuryAccountId: string; network: string; assetId: string; transactionHash: string; amountBaseUnits: string; fromAddress: string | null; invoiceId: string | null; method: "transfer" | "x402"; observedAt: string }
export interface Reconciliation { treasuryAccountId: string; assetId: string; chainBalanceBaseUnits: string; ledgerBalanceBaseUnits: string; differenceBaseUnits: string; status: "matched" | "break" | "in_flight"; createdAt: string }
export interface Statement { treasuryAccountId: string; assetId: string; symbol: string; decimals: number; from: string; to: string; openingBalanceBaseUnits: string; inflowsBaseUnits: string; outflowsBaseUnits: string; feesBaseUnits: string; closingBalanceBaseUnits: string; lines: { effectiveAt: string; description: string; reference: string | null; intentId: string | null; category: string; amountBaseUnits: string; runningBalanceBaseUnits: string }[]; latestReconciliation: Reconciliation | null }
export interface AuditEvent { id: string; actorPrincipalId: string | null; action: string; resourceType: string; resourceId: string; data: Record<string, unknown>; createdAt: string }
export interface Rotation { id: string; treasuryAccountId: string; fromSignerId: string; toSignerId: string; status: string; externalRef: Record<string, unknown> | null; failureReason: string | null; createdAt: string }
export interface Networks { evm: { network: string; chainId: number; local: boolean } | null; solana: { network: string; local: boolean } | null; environment: string }
export interface Health { status: string; environment: string; database: string; integrations: Record<string, string> }
