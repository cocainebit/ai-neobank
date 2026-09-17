import postgres, { type Sql, type TransactionSql } from "postgres";

type Db = Sql | TransactionSql;
import type { PaymentIntent, PolicyDefinition, PolicyDefinitionInput, PrincipalRole } from "@ai-neobank/domain";
import { nativeAssetIds, policyDefinitionSchema } from "@ai-neobank/domain";
export { createPostgresJobQueue, PostgresJobQueue, ExecutionRejected, Deferred, type JobRecord, type ExecutionContext, type ConfirmationContext, type SimulationEvidence, type Simulator, type AssetShape, type PublishContext, type Publisher, type ProposalObservation, type Observer } from "./jobs.js";

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  environment: "test" | "production";
  frozen: boolean;
  autonomousExecution: boolean;
  createdAt: string;
}

export interface PrincipalRecord {
  id: string;
  organizationId: string;
  type: "human" | "agent" | "service";
  displayName: string;
  role: PrincipalRole;
  status: "active" | "frozen" | "revoked";
}

export interface WalletRecord {
  id: string;
  organizationId: string;
  principalId: string;
  chainFamily: "evm" | "svm";
  address: string;
  verifiedAt: string | null;
}

export interface MemberRecord extends PrincipalRecord {
  wallets: WalletRecord[];
}

export interface MembershipRecord {
  walletId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  principalId: string;
  displayName: string;
  role: PrincipalRole;
  principalStatus: PrincipalRecord["status"];
  verifiedAt: string | null;
}

export interface SessionRecord {
  sessionId: string;
  organizationId: string;
  principalId: string;
  walletId: string | null;
  role: PrincipalRole;
  principalStatus: PrincipalRecord["status"];
  organizationFrozen: boolean;
  expiresAt: string;
}

export interface ChallengeRecord {
  nonce: string;
  chainFamily: "evm" | "svm";
  address: string;
  domain: string;
  message: string;
  expiresAt: string;
}

export interface AgentRecord {
  id: string;
  organizationId: string;
  principalId: string;
  displayName: string;
  purpose: string;
  status: "active" | "frozen" | "revoked";
  capabilityVersion: number;
  ownerPrincipalId: string | null;
}

export interface AgentCredentialRecord {
  id: string;
  organizationId: string;
  agentId: string;
  keyId: string;
  label: string | null;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AgentAuthRecord extends AgentCredentialRecord {
  secretHash: string;
  principalId: string;
  agentStatus: AgentRecord["status"];
  organizationFrozen: boolean;
}

export interface TreasuryRecord {
  id: string;
  organizationId: string;
  name: string;
  chainFamily: "evm" | "svm";
  network: string;
  address: string;
  governance: "safe" | "squads" | "direct";
  status: "pending_verification" | "active" | "degraded" | "frozen";
  executorSignerId: string | null;
  observedConfiguration: Record<string, unknown>;
  createdAt: string;
}

export interface SignerRecord {
  id: string;
  organizationId: string;
  agentId: string | null;
  chainFamily: "evm" | "svm";
  address: string;
  custody: "encrypted_software" | "external_wallet" | "kms";
  status: "active" | "frozen" | "revoked";
  createdAt: string;
}

export interface StoredSignerSecret extends SignerRecord {
  encryptedSecret: string | null;
  encryptionNonce: string | null;
  authTag: string | null;
  keyVersion: number | null;
}

export interface PolicyVersionRecord {
  id: string;
  policyId: string;
  organizationId: string;
  version: number;
  definition: PolicyDefinition;
  definitionHash: string;
  status: "active" | "retired";
  createdAt: string;
}

export interface PolicyRecord {
  id: string;
  organizationId: string;
  name: string;
  createdAt: string;
  latest: PolicyVersionRecord;
  bindings: { id: string; policyVersionId: string; agentId: string | null; treasuryAccountId: string | null }[];
}

export interface AssetRecord {
  id: string;
  network: string;
  chainFamily: "evm" | "svm";
  kind: "native" | "erc20" | "spl";
  address: string | null;
  symbol: string;
  decimals: number;
}

export interface IntentRecord extends PaymentIntent {
  status: string;
  version: number;
  createdAt: string;
  policyVersionId: string | null;
  policyDecision: Record<string, unknown> | null;
  failureReason: string | null;
}

export interface IntentEventRecord {
  sequence: number;
  eventType: string;
  actorPrincipalId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionRecord {
  id: string;
  status: string;
  transactionHash: string | null;
  blockCursor: string | null;
  feeBaseUnits: string | null;
  confirmations: number | null;
  error: string | null;
  observed: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ApprovalResult {
  intentId: string;
  intentStatus: string;
  requestStatus: string;
  approvals: number;
  requiredApprovals: number;
  idempotentReplay: boolean;
}

export interface ApprovalRequestRecord {
  intentId: string;
  requiredApprovals: number;
  approvals: number;
  compiledHash: string | null;
  simulationHash: string | null;
  status: string;
  expiresAt: string;
  externalRef: Record<string, unknown> | null;
  decisions: { principalId: string | null; signerAddress: string | null; decision: string; createdAt: string }[];
}

export interface LedgerEntryRecord {
  transactionId: string;
  intentId: string | null;
  externalReference: string | null;
  description: string;
  effectiveAt: string;
  treasuryAccountId: string | null;
  accountCode: string;
  assetId: string;
  direction: "debit" | "credit";
  amountBaseUnits: string;
}

export interface AuditEventRecord {
  id: string;
  actorPrincipalId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export class ApprovalError extends Error {
  constructor(readonly code: "not_found" | "not_eligible" | "stale_version" | "expired" | "evidence_mismatch" | "already_decided" | "invalid_state" | "frozen") {
    super(code);
  }
}

export interface CreateAgentInput {
  displayName: string;
  purpose: string;
  ownerPrincipalId?: string;
}

const organizationColumns = `id::text, name, slug, environment, frozen, autonomous_execution as "autonomousExecution", created_at::text as "createdAt"`;
const principalColumns = `id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status`;
const walletColumns = `id::text, organization_id::text as "organizationId", principal_id::text as "principalId", chain_family as "chainFamily", address, verified_at::text as "verifiedAt"`;
const treasuryColumns = `id::text, organization_id::text as "organizationId", name, chain_family as "chainFamily", network, address, governance, status, executor_signer_id::text as "executorSignerId", observed_configuration as "observedConfiguration", created_at::text as "createdAt"`;
const signerColumns = `id::text, organization_id::text as "organizationId", agent_id::text as "agentId", chain_family as "chainFamily", address, custody, status, created_at::text as "createdAt"`;
const agentColumns = `a.id::text, a.organization_id::text as "organizationId", a.principal_id::text as "principalId", p.display_name as "displayName", a.purpose, a.status, a.capability_version as "capabilityVersion", a.owner_principal_id::text as "ownerPrincipalId"`;
const credentialColumns = `id::text, organization_id::text as "organizationId", agent_id::text as "agentId", key_id as "keyId", label, status, created_at::text as "createdAt", last_used_at::text as "lastUsedAt"`;
const policyVersionColumns = `id::text, policy_id::text as "policyId", organization_id::text as "organizationId", version, definition, definition_hash as "definitionHash", status, created_at::text as "createdAt"`;
const assetColumns = `id, network, chain_family as "chainFamily", kind, address, symbol, decimals`;
const intentColumns = `id::text, idempotency_key as "idempotencyKey", organization_id::text as "organizationId",
  treasury_account_id::text as "treasuryAccountId", requester_principal_id::text as "requesterId",
  network, asset_id as "assetId", amount_base_units::text as "amountBaseUnits", destination,
  purpose, expires_at::text as "expiresAt", kind, status, version, created_at::text as "createdAt",
  policy_version_id::text as "policyVersionId", policy_decision as "policyDecision", failure_reason as "failureReason"`;

export class PostgresControlPlaneStore {
  constructor(readonly sql: Sql) {}

  async health() {
    const [row] = await this.sql<{ ok: number }[]>`select 1 as ok`;
    return row?.ok === 1;
  }

  // Organisations

  async createOrganization(input: { name: string; slug: string }): Promise<OrganizationRecord> {
    const rows = await this.sql.unsafe<OrganizationRecord[]>(`insert into organizations (name, slug) values ($1, $2) returning ${organizationColumns}`, [input.name, input.slug]);
    if (!rows[0]) throw new Error("Organization insert returned no row");
    return rows[0];
  }

  async getOrganization(id: string): Promise<OrganizationRecord | null> {
    const rows = await this.sql.unsafe<OrganizationRecord[]>(`select ${organizationColumns} from organizations where id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateOrganization(id: string, input: { name?: string; frozen?: boolean; autonomousExecution?: boolean }, actorPrincipalId: string): Promise<OrganizationRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<OrganizationRecord[]>`
        update organizations set
          name = coalesce(${input.name ?? null}, name),
          frozen = coalesce(${input.frozen ?? null}, frozen),
          autonomous_execution = coalesce(${input.autonomousExecution ?? null}, autonomous_execution),
          updated_at = now()
        where id = ${id}
        returning id::text, name, slug, environment, frozen, autonomous_execution as "autonomousExecution", created_at::text as "createdAt"
      `;
      if (!rows[0]) return null;
      await this.audit(tx, id, actorPrincipalId, "organization.updated", "organization", id, input);
      return rows[0];
    });
  }

  // Identity: wallets, challenges, sessions, members

  async findMemberships(chainFamily: "evm" | "svm", address: string): Promise<MembershipRecord[]> {
    return this.sql<MembershipRecord[]>`
      select w.id::text as "walletId", o.id::text as "organizationId", o.name as "organizationName", o.slug as "organizationSlug",
        p.id::text as "principalId", p.display_name as "displayName", p.role, p.status as "principalStatus", w.verified_at::text as "verifiedAt"
      from human_wallets w
      join principals p on p.id = w.principal_id
      join organizations o on o.id = w.organization_id
      where w.chain_family = ${chainFamily} and w.address = ${address}
      order by w.created_at
    `;
  }

  /** First sign-in from a wallet nobody has registered: it gets its own organisation as owner. */
  async bootstrapOwner(input: { chainFamily: "evm" | "svm"; address: string; displayName: string; organizationName: string; slug: string }): Promise<MembershipRecord> {
    return this.sql.begin(async (tx) => {
      const organizations = await tx<{ id: string; name: string; slug: string }[]>`
        insert into organizations (name, slug) values (${input.organizationName}, ${input.slug}) returning id::text, name, slug
      `;
      const organization = organizations[0];
      if (!organization) throw new Error("Organization insert returned no row");
      const principals = await tx<{ id: string }[]>`
        insert into principals (organization_id, type, display_name, role) values (${organization.id}, 'human', ${input.displayName}, 'owner') returning id::text
      `;
      const principal = principals[0];
      if (!principal) throw new Error("Principal insert returned no row");
      const wallets = await tx<{ id: string; verifiedAt: string }[]>`
        insert into human_wallets (organization_id, principal_id, chain_family, address, verified_at)
        values (${organization.id}, ${principal.id}, ${input.chainFamily}, ${input.address}, now())
        returning id::text, verified_at::text as "verifiedAt"
      `;
      const wallet = wallets[0];
      if (!wallet) throw new Error("Wallet insert returned no row");
      await this.audit(tx, organization.id, principal.id, "organization.bootstrapped", "organization", organization.id, { chainFamily: input.chainFamily, address: input.address });
      return { walletId: wallet.id, organizationId: organization.id, organizationName: organization.name, organizationSlug: organization.slug, principalId: principal.id, displayName: input.displayName, role: "owner", principalStatus: "active", verifiedAt: wallet.verifiedAt };
    });
  }

  async addMember(organizationId: string, input: { displayName: string; role: Exclude<PrincipalRole, "agent">; wallet: { chainFamily: "evm" | "svm"; address: string } }, actorPrincipalId: string): Promise<MemberRecord> {
    return this.sql.begin(async (tx) => {
      const principals = await tx<PrincipalRecord[]>`
        insert into principals (organization_id, type, display_name, role) values (${organizationId}, 'human', ${input.displayName}, ${input.role})
        returning id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
      `;
      const principal = principals[0];
      if (!principal) throw new Error("Principal insert returned no row");
      const wallets = await tx<WalletRecord[]>`
        insert into human_wallets (organization_id, principal_id, chain_family, address)
        values (${organizationId}, ${principal.id}, ${input.wallet.chainFamily}, ${input.wallet.address})
        returning id::text, organization_id::text as "organizationId", principal_id::text as "principalId", chain_family as "chainFamily", address, verified_at::text as "verifiedAt"
      `;
      await this.audit(tx, organizationId, actorPrincipalId, "member.added", "principal", principal.id, { role: input.role, wallet: input.wallet });
      return { ...principal, wallets: wallets };
    });
  }

  async listMembers(organizationId: string): Promise<MemberRecord[]> {
    const principals = await this.sql.unsafe<PrincipalRecord[]>(`select ${principalColumns} from principals where organization_id = $1 and type = 'human' order by created_at`, [organizationId]);
    const wallets = await this.sql.unsafe<WalletRecord[]>(`select ${walletColumns} from human_wallets where organization_id = $1 order by created_at`, [organizationId]);
    return principals.map((principal) => ({ ...principal, wallets: wallets.filter((wallet) => wallet.principalId === principal.id) }));
  }

  async setPrincipalStatus(organizationId: string, principalId: string, status: PrincipalRecord["status"], actorPrincipalId: string): Promise<PrincipalRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<PrincipalRecord[]>`
        update principals set status = ${status}, updated_at = now() where id = ${principalId} and organization_id = ${organizationId} and type = 'human'
        returning id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
      `;
      if (!rows[0]) return null;
      if (status !== "active") await tx`update sessions set revoked_at = now() where principal_id = ${principalId} and revoked_at is null`;
      await this.audit(tx, organizationId, actorPrincipalId, "member.status", "principal", principalId, { status });
      return rows[0];
    });
  }

  async createChallenge(input: ChallengeRecord): Promise<void> {
    await this.sql`
      insert into auth_challenges (nonce, chain_family, address, domain, message, expires_at)
      values (${input.nonce}, ${input.chainFamily}, ${input.address}, ${input.domain}, ${input.message}, ${input.expiresAt})
    `;
  }

  /** Marks the challenge used; returns null if unknown, expired, or already consumed. */
  async consumeChallenge(nonce: string): Promise<ChallengeRecord | null> {
    const rows = await this.sql<ChallengeRecord[]>`
      update auth_challenges set consumed_at = now()
      where nonce = ${nonce} and consumed_at is null and expires_at > now()
      returning nonce, chain_family as "chainFamily", address, domain, message, expires_at::text as "expiresAt"
    `;
    return rows[0] ?? null;
  }

  async createSession(input: { organizationId: string; principalId: string; walletId: string | null; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    return this.sql.begin(async (tx) => {
      if (input.walletId) await tx`update human_wallets set verified_at = coalesce(verified_at, now()) where id = ${input.walletId}`;
      const rows = await tx<{ id: string }[]>`
        insert into sessions (token_hash, organization_id, principal_id, wallet_id, expires_at)
        values (${input.tokenHash}, ${input.organizationId}, ${input.principalId}, ${input.walletId}, ${input.expiresAt})
        returning id::text
      `;
      if (!rows[0]) throw new Error("Session insert returned no row");
      await this.audit(tx, input.organizationId, input.principalId, "session.created", "session", rows[0].id, { walletId: input.walletId });
      return rows[0];
    });
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.sql<SessionRecord[]>`
      update sessions s set last_seen_at = now()
      from principals p, organizations o
      where s.token_hash = ${tokenHash} and s.revoked_at is null and s.expires_at > now()
        and p.id = s.principal_id and o.id = s.organization_id
      returning s.id::text as "sessionId", s.organization_id::text as "organizationId", s.principal_id::text as "principalId",
        s.wallet_id::text as "walletId", p.role, p.status as "principalStatus", o.frozen as "organizationFrozen", s.expires_at::text as "expiresAt"
    `;
    return rows[0] ?? null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.sql`update sessions set revoked_at = now() where token_hash = ${tokenHash} and revoked_at is null`;
  }

  // Agents and their credentials

  async createAgent(organizationId: string, input: CreateAgentInput, actorPrincipalId?: string): Promise<AgentRecord> {
    return this.sql.begin(async (tx) => {
      const principals = await tx<{ id: string }[]>`
        insert into principals (organization_id, type, display_name, role)
        values (${organizationId}, 'agent', ${input.displayName}, 'agent')
        returning id::text
      `;
      const principal = principals[0];
      if (!principal) throw new Error("Principal insert returned no row");
      const rows = await tx<{ id: string }[]>`
        insert into agents (organization_id, principal_id, owner_principal_id, purpose)
        values (${organizationId}, ${principal.id}, ${input.ownerPrincipalId ?? actorPrincipalId ?? null}, ${input.purpose})
        returning id::text
      `;
      const agent = rows[0];
      if (!agent) throw new Error("Agent insert returned no row");
      await this.audit(tx, organizationId, actorPrincipalId ?? input.ownerPrincipalId ?? null, "agent.created", "agent", agent.id, { displayName: input.displayName, purpose: input.purpose });
      const records = await tx.unsafe<AgentRecord[]>(`select ${agentColumns} from agents a join principals p on p.id = a.principal_id where a.id = $1`, [agent.id]);
      if (!records[0]) throw new Error("Agent read-back failed");
      return records[0];
    });
  }

  listAgents(organizationId: string): Promise<AgentRecord[]> {
    return this.sql.unsafe<AgentRecord[]>(`select ${agentColumns} from agents a join principals p on p.id = a.principal_id where a.organization_id = $1 order by a.created_at`, [organizationId]);
  }

  async getAgent(organizationId: string, agentId: string): Promise<AgentRecord | null> {
    const rows = await this.sql.unsafe<AgentRecord[]>(`select ${agentColumns} from agents a join principals p on p.id = a.principal_id where a.organization_id = $1 and a.id = $2`, [organizationId, agentId]);
    return rows[0] ?? null;
  }

  async setAgentStatus(organizationId: string, agentId: string, status: AgentRecord["status"], actorPrincipalId?: string): Promise<AgentRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; principalId: string }[]>`
        update agents set status = ${status}, capability_version = capability_version + 1, updated_at = now()
        where id = ${agentId} and organization_id = ${organizationId}
        returning id::text, principal_id::text as "principalId"
      `;
      if (!rows[0]) return null;
      await tx`update principals set status = ${status}, updated_at = now() where id = ${rows[0].principalId}`;
      if (status === "revoked") await tx`update agent_credentials set status = 'revoked', revoked_at = now() where agent_id = ${agentId} and status = 'active'`;
      await this.audit(tx, organizationId, actorPrincipalId ?? null, "agent.status", "agent", agentId, { status });
      const records = await tx.unsafe<AgentRecord[]>(`select ${agentColumns} from agents a join principals p on p.id = a.principal_id where a.id = $1`, [agentId]);
      return records[0] ?? null;
    });
  }

  async createAgentCredential(organizationId: string, agentId: string, input: { keyId: string; secretHash: string; label?: string; createdBy: string }): Promise<AgentCredentialRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<AgentCredentialRecord[]>(
        `insert into agent_credentials (organization_id, agent_id, key_id, secret_hash, label, created_by) values ($1, $2, $3, $4, $5, $6) returning ${credentialColumns}`,
        [organizationId, agentId, input.keyId, input.secretHash, input.label ?? null, input.createdBy]
      );
      if (!rows[0]) throw new Error("Credential insert returned no row");
      await this.audit(tx, organizationId, input.createdBy, "agent.credential.created", "agent_credential", rows[0].id, { agentId, keyId: input.keyId });
      return rows[0];
    });
  }

  listAgentCredentials(organizationId: string, agentId: string): Promise<AgentCredentialRecord[]> {
    return this.sql.unsafe<AgentCredentialRecord[]>(`select ${credentialColumns} from agent_credentials where organization_id = $1 and agent_id = $2 order by created_at`, [organizationId, agentId]);
  }

  async revokeAgentCredential(organizationId: string, agentId: string, keyId: string, actorPrincipalId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update agent_credentials set status = 'revoked', revoked_at = now()
        where organization_id = ${organizationId} and agent_id = ${agentId} and key_id = ${keyId} and status = 'active' returning id::text
      `;
      if (!rows[0]) return false;
      await this.audit(tx, organizationId, actorPrincipalId, "agent.credential.revoked", "agent_credential", rows[0].id, { keyId });
      return true;
    });
  }

  /** Looks up the credential for the API to compare the secret hash. Touches last_used_at only when the caller confirms a match. */
  async findAgentCredential(keyId: string): Promise<AgentAuthRecord | null> {
    const rows = await this.sql<AgentAuthRecord[]>`
      select c.id::text, c.organization_id::text as "organizationId", c.agent_id::text as "agentId", c.key_id as "keyId", c.label, c.status,
        c.created_at::text as "createdAt", c.last_used_at::text as "lastUsedAt", c.secret_hash as "secretHash",
        a.principal_id::text as "principalId", a.status as "agentStatus", o.frozen as "organizationFrozen"
      from agent_credentials c join agents a on a.id = c.agent_id join organizations o on o.id = c.organization_id
      where c.key_id = ${keyId}
    `;
    return rows[0] ?? null;
  }

  async touchAgentCredential(id: string): Promise<void> {
    await this.sql`update agent_credentials set last_used_at = now() where id = ${id}`;
  }

  // Treasuries

  async createTreasury(organizationId: string, input: { name: string; chainFamily: "evm" | "svm"; network: string; address: string; governance: TreasuryRecord["governance"]; executorSignerId?: string; observedConfiguration?: Record<string, unknown> }, actorPrincipalId?: string): Promise<TreasuryRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<TreasuryRecord[]>`
        insert into treasury_accounts (organization_id, name, chain_family, network, address, governance, status, executor_signer_id, observed_configuration)
        values (${organizationId}, ${input.name}, ${input.chainFamily}, ${input.network}, ${input.address}, ${input.governance}, 'active', ${input.executorSignerId ?? null}, ${tx.json((input.observedConfiguration ?? {}) as never)})
        returning id::text, organization_id::text as "organizationId", name, chain_family as "chainFamily", network, address, governance, status, executor_signer_id::text as "executorSignerId", observed_configuration as "observedConfiguration", created_at::text as "createdAt"
      `;
      if (!rows[0]) throw new Error("Treasury insert returned no row");
      await this.audit(tx, organizationId, actorPrincipalId ?? null, "treasury.created", "treasury", rows[0].id, { network: input.network, address: input.address, governance: input.governance, executorSignerId: input.executorSignerId ?? null, observedConfiguration: input.observedConfiguration ?? {} });
      return rows[0];
    });
  }

  async updateTreasuryObservation(organizationId: string, treasuryId: string, observedConfiguration: Record<string, unknown>): Promise<void> {
    await this.sql`update treasury_accounts set observed_configuration = ${this.sql.json(observedConfiguration as never)}, updated_at = now() where organization_id = ${organizationId} and id = ${treasuryId}`;
  }

  listTreasuries(organizationId: string): Promise<TreasuryRecord[]> {
    return this.sql.unsafe<TreasuryRecord[]>(`select ${treasuryColumns} from treasury_accounts where organization_id = $1 order by created_at`, [organizationId]);
  }

  async getTreasury(organizationId: string, treasuryId: string): Promise<TreasuryRecord | null> {
    const rows = await this.sql.unsafe<TreasuryRecord[]>(`select ${treasuryColumns} from treasury_accounts where organization_id = $1 and id = $2`, [organizationId, treasuryId]);
    return rows[0] ?? null;
  }

  /** Wallet addresses of the organisation's human principals, for mapping on-chain votes to people. */
  async walletsByAddress(organizationId: string, chainFamily: "evm" | "svm"): Promise<Map<string, { principalId: string; walletId: string }>> {
    const rows = await this.sql<{ address: string; principalId: string; walletId: string }[]>`
      select address, principal_id::text as "principalId", id::text as "walletId" from human_wallets where organization_id = ${organizationId} and chain_family = ${chainFamily}
    `;
    return new Map(rows.map((row) => [chainFamily === "evm" ? row.address.toLowerCase() : row.address, { principalId: row.principalId, walletId: row.walletId }]));
  }

  async setTreasuryStatus(organizationId: string, treasuryId: string, status: TreasuryRecord["status"], actorPrincipalId: string): Promise<TreasuryRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<TreasuryRecord[]>(`update treasury_accounts set status = $3, updated_at = now() where organization_id = $1 and id = $2 returning ${treasuryColumns}`, [organizationId, treasuryId, status]);
      if (!rows[0]) return null;
      await this.audit(tx, organizationId, actorPrincipalId, "treasury.status", "treasury", treasuryId, { status });
      return rows[0];
    });
  }

  // Signers

  async createSigner(organizationId: string, input: { agentId?: string; chainFamily: SignerRecord["chainFamily"]; address: string; encryptedSecret: string; encryptionNonce: string; authTag: string; keyVersion: number }, actorPrincipalId?: string): Promise<SignerRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<SignerRecord[]>(
        `insert into signers (organization_id, agent_id, chain_family, address, custody, encrypted_secret, encryption_nonce, auth_tag, key_version)
         values ($1, $2, $3, $4, 'encrypted_software', $5, $6, $7, $8) returning ${signerColumns}`,
        [organizationId, input.agentId ?? null, input.chainFamily, input.address, input.encryptedSecret, input.encryptionNonce, input.authTag, input.keyVersion]
      );
      if (!rows[0]) throw new Error("Signer insert returned no row");
      await this.audit(tx, organizationId, actorPrincipalId ?? null, "signer.created", "signer", rows[0].id, { chainFamily: input.chainFamily, address: input.address, keyVersion: input.keyVersion });
      return rows[0];
    });
  }

  listSigners(organizationId: string): Promise<SignerRecord[]> {
    return this.sql.unsafe<SignerRecord[]>(`select ${signerColumns} from signers where organization_id = $1 order by created_at`, [organizationId]);
  }

  async getSignerSecret(organizationId: string, signerId: string): Promise<StoredSignerSecret | null> {
    const rows = await this.sql.unsafe<StoredSignerSecret[]>(
      `select ${signerColumns}, encrypted_secret as "encryptedSecret", encryption_nonce as "encryptionNonce", auth_tag as "authTag", key_version as "keyVersion" from signers where organization_id = $1 and id = $2`,
      [organizationId, signerId]
    );
    return rows[0] ?? null;
  }

  async setSignerStatus(organizationId: string, signerId: string, status: SignerRecord["status"], actorPrincipalId: string): Promise<SignerRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<SignerRecord[]>(`update signers set status = $3 where organization_id = $1 and id = $2 returning ${signerColumns}`, [organizationId, signerId, status]);
      if (!rows[0]) return null;
      await this.audit(tx, organizationId, actorPrincipalId, "signer.status", "signer", signerId, { status });
      return rows[0];
    });
  }

  // Policies

  async createPolicy(organizationId: string, input: { name: string; definition: PolicyDefinitionInput; createdBy: string }): Promise<PolicyRecord> {
    const definition = policyDefinitionSchema.parse(input.definition);
    return this.sql.begin(async (tx) => {
      const policies = await tx<{ id: string }[]>`insert into policies (organization_id, name) values (${organizationId}, ${input.name}) returning id::text`;
      const policy = policies[0];
      if (!policy) throw new Error("Policy insert returned no row");
      await this.insertPolicyVersion(tx, organizationId, policy.id, 1, definition, input.createdBy);
      await this.audit(tx, organizationId, input.createdBy, "policy.created", "policy", policy.id, { name: input.name, definition });
      const records = await this.readPolicies(tx, organizationId, policy.id);
      if (!records[0]) throw new Error("Policy read-back failed");
      return records[0];
    });
  }

  async addPolicyVersion(organizationId: string, policyId: string, input: PolicyDefinitionInput, createdBy: string): Promise<PolicyRecord | null> {
    const definition = policyDefinitionSchema.parse(input);
    return this.sql.begin(async (tx) => {
      const latest = await tx<{ version: number }[]>`select coalesce(max(version), 0) as version from policy_versions where policy_id = ${policyId} and organization_id = ${organizationId} for update`;
      if (!latest[0] || latest[0].version === 0) return null;
      await tx`update policy_versions set status = 'retired' where policy_id = ${policyId} and status = 'active'`;
      const versionId = await this.insertPolicyVersion(tx, organizationId, policyId, latest[0].version + 1, definition, createdBy);
      // Bindings follow the policy, not a frozen version, so they move to the new version.
      await tx`update policy_bindings set policy_version_id = ${versionId} where organization_id = ${organizationId} and policy_version_id in (select id from policy_versions where policy_id = ${policyId})`;
      await this.audit(tx, organizationId, createdBy, "policy.version.created", "policy", policyId, { version: latest[0].version + 1, definition });
      const records = await this.readPolicies(tx, organizationId, policyId);
      return records[0] ?? null;
    });
  }

  private async insertPolicyVersion(tx: Db, organizationId: string, policyId: string, version: number, definition: PolicyDefinition, createdBy: string): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      insert into policy_versions (policy_id, organization_id, version, definition, definition_hash, created_by)
      values (${policyId}, ${organizationId}, ${version}, ${tx.json(definition as never)}, encode(digest(${JSON.stringify(definition)}, 'sha256'), 'hex'), ${createdBy})
      returning id::text
    `;
    if (!rows[0]) throw new Error("Policy version insert returned no row");
    return rows[0].id;
  }

  private async readPolicies(tx: Db, organizationId: string, policyId?: string): Promise<PolicyRecord[]> {
    const policies = await tx<{ id: string; organizationId: string; name: string; createdAt: string }[]>`
      select id::text, organization_id::text as "organizationId", name, created_at::text as "createdAt" from policies
      where organization_id = ${organizationId} and (${policyId ?? null}::uuid is null or id = ${policyId ?? null}) order by created_at
    `;
    const versions = await tx.unsafe<PolicyVersionRecord[]>(`select ${policyVersionColumns} from policy_versions where organization_id = $1 and status = 'active'`, [organizationId]);
    const bindings = await tx<{ id: string; policyVersionId: string; agentId: string | null; treasuryAccountId: string | null }[]>`
      select id::text, policy_version_id::text as "policyVersionId", agent_id::text as "agentId", treasury_account_id::text as "treasuryAccountId" from policy_bindings where organization_id = ${organizationId}
    `;
    return policies.flatMap((policy) => {
      const latest = versions.find((version) => version.policyId === policy.id);
      if (!latest) return [];
      return [{ ...policy, latest, bindings: bindings.filter((binding) => binding.policyVersionId === latest.id) }];
    });
  }

  listPolicies(organizationId: string): Promise<PolicyRecord[]> {
    return this.readPolicies(this.sql, organizationId);
  }

  async bindPolicy(organizationId: string, input: { policyId: string; agentId?: string; treasuryAccountId?: string }, actorPrincipalId: string): Promise<PolicyRecord | null> {
    if (!input.agentId === !input.treasuryAccountId) throw new Error("Bind to exactly one of agentId or treasuryAccountId");
    return this.sql.begin(async (tx) => {
      const versions = await tx<{ id: string }[]>`select id::text from policy_versions where organization_id = ${organizationId} and policy_id = ${input.policyId} and status = 'active'`;
      const version = versions[0];
      if (!version) return null;
      if (input.agentId) {
        await tx`delete from policy_bindings where organization_id = ${organizationId} and agent_id = ${input.agentId} and treasury_account_id is null`;
        await tx`insert into policy_bindings (organization_id, policy_version_id, agent_id) values (${organizationId}, ${version.id}, ${input.agentId})`;
      } else {
        await tx`delete from policy_bindings where organization_id = ${organizationId} and treasury_account_id = ${input.treasuryAccountId!} and agent_id is null`;
        await tx`insert into policy_bindings (organization_id, policy_version_id, treasury_account_id) values (${organizationId}, ${version.id}, ${input.treasuryAccountId!})`;
      }
      await this.audit(tx, organizationId, actorPrincipalId, "policy.bound", "policy", input.policyId, { agentId: input.agentId ?? null, treasuryAccountId: input.treasuryAccountId ?? null });
      const records = await this.readPolicies(tx, organizationId, input.policyId);
      return records[0] ?? null;
    });
  }

  // Assets

  async upsertAsset(input: AssetRecord): Promise<AssetRecord> {
    const rows = await this.sql.unsafe<AssetRecord[]>(
      `insert into assets (id, network, chain_family, kind, address, symbol, decimals) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set symbol = excluded.symbol, decimals = excluded.decimals returning ${assetColumns}`,
      [input.id, input.network, input.chainFamily, input.kind, input.address, input.symbol, input.decimals]
    );
    if (!rows[0]) throw new Error("Asset upsert returned no row");
    return rows[0];
  }

  /** Seeds the native coin for a network so intents can reference it before any token is registered. */
  ensureNativeAsset(network: string, chainFamily: "evm" | "svm"): Promise<AssetRecord> {
    const symbol = chainFamily === "evm" ? "ETH" : "SOL";
    const decimals = chainFamily === "evm" ? 18 : 9;
    return this.upsertAsset({ id: `${network}/${nativeAssetIds[chainFamily]}`, network, chainFamily, kind: "native", address: null, symbol, decimals });
  }

  listAssets(network?: string): Promise<AssetRecord[]> {
    return network
      ? this.sql.unsafe<AssetRecord[]>(`select ${assetColumns} from assets where network = $1 order by kind, symbol`, [network])
      : this.sql.unsafe<AssetRecord[]>(`select ${assetColumns} from assets order by network, kind, symbol`);
  }

  async getAsset(id: string): Promise<AssetRecord | null> {
    const rows = await this.sql.unsafe<AssetRecord[]>(`select ${assetColumns} from assets where id = $1`, [id]);
    return rows[0] ?? null;
  }

  // Intents and approvals

  async createIntent(intent: PaymentIntent, links: { beneficiaryId?: string } = {}): Promise<{ record: IntentRecord; created: boolean }> {
    return this.sql.begin(async (tx) => {
      const existing = await tx.unsafe<IntentRecord[]>(
        `select ${intentColumns} from intents where organization_id = $1 and requester_principal_id = $2 and idempotency_key = $3`,
        [intent.organizationId, intent.requesterId, intent.idempotencyKey]
      );
      if (existing[0]) return { record: existing[0], created: false };
      const rows = await tx.unsafe<IntentRecord[]>(
        `insert into intents (id, organization_id, treasury_account_id, requester_principal_id, idempotency_key, kind, network, asset_id, amount_base_units, destination, purpose, status, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'received', $12) returning ${intentColumns}`,
        [intent.id, intent.organizationId, intent.treasuryAccountId, intent.requesterId, intent.idempotencyKey, intent.kind, intent.network, intent.assetId, intent.amountBaseUnits, intent.destination, intent.purpose, intent.expiresAt]
      );
      const record = rows[0];
      if (!record) throw new Error("Intent insert returned no row");
      if (links.beneficiaryId) await tx`update intents set beneficiary_id = ${links.beneficiaryId} where id = ${intent.id}`;
      await tx`
        insert into intent_events (organization_id, intent_id, sequence, event_type, actor_principal_id, data)
        values (${intent.organizationId}, ${intent.id}, 1, 'intent.received', ${intent.requesterId}, ${tx.json({ status: "received" })})
      `;
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${intent.organizationId}, 'intent.evaluate', 'intent', ${intent.id}, ${tx.json({ intentId: intent.id })})
      `;
      return { record, created: true };
    });
  }

  listIntents(organizationId: string, filter: { status?: string; requesterId?: string; limit?: number } = {}): Promise<IntentRecord[]> {
    return this.sql.unsafe<IntentRecord[]>(
      `select ${intentColumns} from intents where organization_id = $1 and ($2::text is null or status = $2) and ($3::uuid is null or requester_principal_id = $3) order by created_at desc limit $4`,
      [organizationId, filter.status ?? null, filter.requesterId ?? null, filter.limit ?? 200]
    );
  }

  async getIntent(organizationId: string, intentId: string): Promise<{ intent: IntentRecord; events: IntentEventRecord[]; approval: ApprovalRequestRecord | null; execution: ExecutionRecord | null } | null> {
    const rows = await this.sql.unsafe<IntentRecord[]>(`select ${intentColumns} from intents where organization_id = $1 and id = $2`, [organizationId, intentId]);
    const intent = rows[0];
    if (!intent) return null;
    const events = await this.sql<IntentEventRecord[]>`
      select sequence, event_type as "eventType", actor_principal_id::text as "actorPrincipalId", data, created_at::text as "createdAt"
      from intent_events where intent_id = ${intentId} order by sequence
    `;
    const executions = await this.sql<ExecutionRecord[]>`
      select id::text, status, transaction_hash as "transactionHash", block_cursor as "blockCursor", fee_base_units::text as "feeBaseUnits",
        confirmations, error, observed, updated_at::text as "updatedAt"
      from executions where intent_id = ${intentId}
    `;
    return { intent, events, approval: await this.getApprovalRequest(organizationId, intentId), execution: executions[0] ?? null };
  }

  async getApprovalRequest(organizationId: string, intentId: string): Promise<ApprovalRequestRecord | null> {
    const rows = await this.sql<Omit<ApprovalRequestRecord, "decisions">[]>`
      select ar.intent_id::text as "intentId", ar.required_approvals as "requiredApprovals",
        count(a.id) filter (where a.decision = 'approved')::int as approvals,
        ar.compiled_hash as "compiledHash", ar.simulation_hash as "simulationHash",
        ar.status, ar.expires_at::text as "expiresAt", ar.external_ref as "externalRef"
      from approval_requests ar left join approvals a on a.intent_id = ar.intent_id
      where ar.organization_id = ${organizationId} and ar.intent_id = ${intentId}
      group by ar.id
    `;
    const request = rows[0];
    if (!request) return null;
    const decisions = await this.sql<{ principalId: string | null; signerAddress: string | null; decision: string; createdAt: string }[]>`
      select approver_principal_id::text as "principalId", signer_address as "signerAddress", decision, created_at::text as "createdAt" from approvals where intent_id = ${intentId} order by created_at
    `;
    return { ...request, decisions };
  }

  async decideIntent(organizationId: string, intentId: string, input: { principalId: string; decision: "approved" | "rejected"; expectedIntentVersion: number; compiledHash: string; simulationHash: string; signedPayload?: string; signerAddress?: string }): Promise<ApprovalResult> {
    return this.sql.begin(async (tx): Promise<ApprovalResult> => {
      const principals = await tx<PrincipalRecord[]>`
        select id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
        from principals where id = ${input.principalId} and organization_id = ${organizationId}
      `;
      const principal = principals[0];
      if (!principal) throw new ApprovalError("not_found");
      if (principal.type !== "human" || principal.status !== "active" || !["owner", "approver"].includes(principal.role)) throw new ApprovalError("not_eligible");
      const rows = await tx<{ status: string; version: number; expiresAt: string; requestStatus: string; requiredApprovals: number; compiledHash: string | null; simulationHash: string | null; organizationFrozen: boolean; treasuryStatus: string; requesterStatus: string }[]>`
        select i.status, i.version, i.expires_at::text as "expiresAt", ar.status as "requestStatus",
          ar.required_approvals as "requiredApprovals", ar.compiled_hash as "compiledHash", ar.simulation_hash as "simulationHash",
          o.frozen as "organizationFrozen", t.status as "treasuryStatus", rp.status as "requesterStatus"
        from intents i
        join approval_requests ar on ar.intent_id = i.id
        join organizations o on o.id = i.organization_id
        join treasury_accounts t on t.id = i.treasury_account_id
        join principals rp on rp.id = i.requester_principal_id
        where i.id = ${intentId} and i.organization_id = ${organizationId}
        for update of i, ar
      `;
      const state = rows[0];
      if (!state) throw new ApprovalError("not_found");
      const existing = await tx<{ decision: string }[]>`select decision from approvals where intent_id = ${intentId} and approver_principal_id = ${input.principalId}`;
      if (existing[0]) {
        if (existing[0].decision !== input.decision) throw new ApprovalError("already_decided");
        const countRows = await tx<{ count: number }[]>`select count(*)::int as count from approvals where intent_id = ${intentId} and decision = 'approved'`;
        return { intentId, intentStatus: state.status, requestStatus: state.requestStatus, approvals: countRows[0]?.count ?? 0, requiredApprovals: state.requiredApprovals, idempotentReplay: true };
      }
      if (state.status !== "approval_required" || state.requestStatus !== "pending") throw new ApprovalError("invalid_state");
      if (state.version !== input.expectedIntentVersion) throw new ApprovalError("stale_version");
      if (new Date(state.expiresAt) <= new Date()) {
        await tx`update approval_requests set status = 'expired', updated_at = now() where intent_id = ${intentId}`;
        await tx`update intents set status = 'expired', version = version + 1, updated_at = now() where id = ${intentId}`;
        throw new ApprovalError("expired");
      }
      if (input.decision === "approved" && (state.organizationFrozen || state.treasuryStatus === "frozen" || state.requesterStatus !== "active")) throw new ApprovalError("frozen");
      if (!state.compiledHash || !state.simulationHash || state.compiledHash !== input.compiledHash || state.simulationHash !== input.simulationHash) throw new ApprovalError("evidence_mismatch");
      await tx`
        insert into approvals (organization_id, intent_id, approver_principal_id, decision, signed_payload, signer_address)
        values (${organizationId}, ${intentId}, ${input.principalId}, ${input.decision}, ${input.signedPayload ?? null}, ${input.signerAddress ?? null})
      `;
      const counts = await tx<{ count: number }[]>`select count(*)::int as count from approvals where intent_id = ${intentId} and decision = 'approved'`;
      const approvals = counts[0]?.count ?? 0;
      const nextStatus = input.decision === "rejected" ? "rejected" : approvals >= state.requiredApprovals ? "approved" : "approval_required";
      const requestStatus = input.decision === "rejected" ? "rejected" : approvals >= state.requiredApprovals ? "approved" : "pending";
      if (nextStatus !== "approval_required") {
        await tx`update approval_requests set status = ${requestStatus}, updated_at = now() where intent_id = ${intentId}`;
        await tx`update intents set status = ${nextStatus}, version = version + 1, updated_at = now() where id = ${intentId}`;
      }
      const eventRows = await tx<{ sequence: number }[]>`select coalesce(max(sequence), 0) + 1 as sequence from intent_events where intent_id = ${intentId}`;
      await tx`
        insert into intent_events (organization_id, intent_id, sequence, event_type, actor_principal_id, data)
        values (${organizationId}, ${intentId}, ${eventRows[0]?.sequence ?? 1}, ${`intent.${input.decision}`}, ${input.principalId}, ${tx.json({ approvals, requiredApprovals: state.requiredApprovals, compiledHash: input.compiledHash, simulationHash: input.simulationHash, signed: Boolean(input.signedPayload) })})
      `;
      await this.audit(tx, organizationId, input.principalId, `intent.${input.decision}`, "intent", intentId, { decision: input.decision, expectedIntentVersion: input.expectedIntentVersion, approvals, requiredApprovals: state.requiredApprovals });
      if (nextStatus === "approved") await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${organizationId}, 'transaction.execute', 'intent', ${intentId}, ${tx.json({ intentId })})
      `;
      return { intentId, intentStatus: nextStatus, requestStatus, approvals, requiredApprovals: state.requiredApprovals, idempotentReplay: false };
    });
  }

  // Ledger and audit

  listLedgerEntries(organizationId: string, filter: { treasuryAccountId?: string; limit?: number } = {}): Promise<LedgerEntryRecord[]> {
    return this.sql<LedgerEntryRecord[]>`
      select lt.id::text as "transactionId", lt.intent_id::text as "intentId", lt.external_reference as "externalReference", lt.description,
        lt.effective_at::text as "effectiveAt", la.treasury_account_id::text as "treasuryAccountId", la.code as "accountCode", la.asset_id as "assetId",
        le.direction, le.amount_base_units::text as "amountBaseUnits"
      from ledger_entries le
      join ledger_transactions lt on lt.id = le.transaction_id
      join ledger_accounts la on la.id = le.account_id
      where lt.organization_id = ${organizationId} and (${filter.treasuryAccountId ?? null}::uuid is null or la.treasury_account_id = ${filter.treasuryAccountId ?? null})
      order by lt.effective_at desc, le.created_at limit ${filter.limit ?? 500}
    `;
  }

  /** Net position per treasury asset account from the ledger: what has been booked as spent, pending, and fees. */
  listLedgerBalances(organizationId: string): Promise<{ treasuryAccountId: string | null; accountCode: string; assetId: string; debits: string; credits: string }[]> {
    return this.sql<{ treasuryAccountId: string | null; accountCode: string; assetId: string; debits: string; credits: string }[]>`
      select la.treasury_account_id::text as "treasuryAccountId", la.code as "accountCode", la.asset_id as "assetId",
        coalesce(sum(le.amount_base_units) filter (where le.direction = 'debit'), 0)::text as debits,
        coalesce(sum(le.amount_base_units) filter (where le.direction = 'credit'), 0)::text as credits
      from ledger_accounts la left join ledger_entries le on le.account_id = la.id
      where la.organization_id = ${organizationId}
      group by la.treasury_account_id, la.code, la.asset_id
    `;
  }

  listAuditEvents(organizationId: string, limit = 200): Promise<AuditEventRecord[]> {
    return this.sql<AuditEventRecord[]>`
      select id::text, actor_principal_id::text as "actorPrincipalId", action, resource_type as "resourceType", resource_id as "resourceId", data, created_at::text as "createdAt"
      from audit_events where organization_id = ${organizationId} order by created_at desc limit ${limit}
    `;
  }

  private async audit(tx: Db, organizationId: string, actorPrincipalId: string | null, action: string, resourceType: string, resourceId: string, data: Record<string, unknown>): Promise<void> {
    await tx`
      insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
      values (${organizationId}, ${actorPrincipalId}, ${action}, ${resourceType}, ${resourceId}, encode(digest(${JSON.stringify(data)}, 'sha256'), 'hex'), ${tx.json(data as never)})
    `;
  }

  async close() { await this.sql.end(); }
}

export type ControlPlaneStore = PostgresControlPlaneStore;

export function createPostgresStore(databaseUrl: string): PostgresControlPlaneStore {
  return new PostgresControlPlaneStore(postgres(databaseUrl, { max: 10, idle_timeout: 20 }));
}

export { OperationsStore, OperationsError, type BeneficiaryRecord, type ScheduleRecord, type InvoiceRecord, type InvoiceLineItem, type InflowRecord, type ReconciliationRecord, type StatementRecord, type StatementLine } from "./operations.js";
export { postLedger, ledgerNet, type LedgerLine, type LedgerAccountCode } from "./ledger.js";
