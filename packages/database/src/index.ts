import postgres, { type Sql } from "postgres";
import type { PaymentIntent } from "@ai-neobank/domain";
export { createPostgresJobQueue, PostgresJobQueue, type JobRecord } from "./jobs.js";

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  environment: "test" | "production";
  frozen: boolean;
  createdAt: string;
}

export interface AgentRecord {
  id: string;
  organizationId: string;
  principalId: string;
  displayName: string;
  purpose: string;
  status: "active" | "frozen" | "revoked";
  capabilityVersion: number;
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

export interface IntentRecord extends PaymentIntent {
  status: string;
  version: number;
  createdAt: string;
}

export interface PrincipalRecord {
  id: string;
  organizationId: string;
  type: "human" | "agent" | "service";
  displayName: string;
  role: "owner" | "approver" | "operator" | "auditor" | "developer" | "agent";
  status: "active" | "frozen" | "revoked";
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
}

export class ApprovalError extends Error {
  constructor(readonly code: "not_found" | "not_eligible" | "stale_version" | "expired" | "evidence_mismatch" | "already_decided" | "invalid_state") {
    super(code);
  }
}

export interface CreateAgentInput {
  displayName: string;
  purpose: string;
  ownerPrincipalId?: string;
}

export interface ControlPlaneStore {
  health(): Promise<boolean>;
  createOrganization(input: { name: string; slug: string }): Promise<OrganizationRecord>;
  listOrganizations(): Promise<OrganizationRecord[]>;
  createHumanPrincipal(organizationId: string, input: { displayName: string; role: "owner" | "approver" | "operator" | "auditor" | "developer" }): Promise<PrincipalRecord>;
  listPrincipals(organizationId: string): Promise<PrincipalRecord[]>;
  createAgent(organizationId: string, input: CreateAgentInput): Promise<AgentRecord>;
  listAgents(organizationId: string): Promise<AgentRecord[]>;
  setAgentStatus(organizationId: string, agentId: string, status: AgentRecord["status"]): Promise<AgentRecord | null>;
  createTreasury(organizationId: string, input: Omit<TreasuryRecord, "id" | "organizationId" | "status" | "createdAt">): Promise<TreasuryRecord>;
  listTreasuries(organizationId: string): Promise<TreasuryRecord[]>;
  createSigner(organizationId: string, input: { agentId?: string; chainFamily: SignerRecord["chainFamily"]; address: string; encryptedSecret: string; encryptionNonce: string; authTag: string; keyVersion: number }): Promise<SignerRecord>;
  listSigners(organizationId: string): Promise<SignerRecord[]>;
  getSignerSecret(organizationId: string, signerId: string): Promise<StoredSignerSecret | null>;
  createIntent(intent: PaymentIntent): Promise<{ record: IntentRecord; created: boolean }>;
  listIntents(organizationId: string): Promise<IntentRecord[]>;
  getApprovalRequest(organizationId: string, intentId: string): Promise<ApprovalRequestRecord | null>;
  decideIntent(organizationId: string, intentId: string, input: { principalId: string; decision: "approved" | "rejected"; expectedIntentVersion: number; compiledHash: string; simulationHash: string; signedPayload?: string }): Promise<ApprovalResult>;
  close(): Promise<void>;
}

const organizationColumns = `
  id::text, name, slug, environment, frozen, created_at::text as "createdAt"
`;

export class PostgresControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly sql: Sql) {}

  async health() {
    const [row] = await this.sql<{ ok: number }[]>`select 1 as ok`;
    return row?.ok === 1;
  }

  async createOrganization(input: { name: string; slug: string }) {
    const rows = await this.sql<OrganizationRecord[]>`
      insert into organizations (name, slug)
      values (${input.name}, ${input.slug})
      returning id::text, name, slug, environment, frozen, created_at::text as "createdAt"
    `;
    const record = rows[0];
    if (!record) throw new Error("Organization insert returned no row");
    return record;
  }

  listOrganizations() {
    return this.sql.unsafe<OrganizationRecord[]>(`select ${organizationColumns} from organizations order by created_at desc`);
  }

  async createHumanPrincipal(organizationId: string, input: { displayName: string; role: "owner" | "approver" | "operator" | "auditor" | "developer" }) {
    const rows = await this.sql<PrincipalRecord[]>`
      insert into principals (organization_id, type, display_name, role)
      values (${organizationId}, 'human', ${input.displayName}, ${input.role})
      returning id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
    `;
    if (!rows[0]) throw new Error("Principal insert returned no row");
    return rows[0];
  }

  listPrincipals(organizationId: string) {
    return this.sql<PrincipalRecord[]>`
      select id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
      from principals where organization_id = ${organizationId} order by created_at
    `;
  }

  async createAgent(organizationId: string, input: CreateAgentInput) {
    return this.sql.begin(async (tx) => {
      const principals = await tx<{ id: string }[]>`
        insert into principals (organization_id, type, display_name, role)
        values (${organizationId}, 'agent', ${input.displayName}, 'agent')
        returning id::text
      `;
      const principal = principals[0];
      if (!principal) throw new Error("Principal insert returned no row");
      const rows = await tx<AgentRecord[]>`
        insert into agents (organization_id, principal_id, owner_principal_id, purpose)
        values (${organizationId}, ${principal.id}, ${input.ownerPrincipalId ?? null}, ${input.purpose})
        returning id::text, organization_id::text as "organizationId", principal_id::text as "principalId",
          ${input.displayName}::text as "displayName", purpose, status, capability_version as "capabilityVersion"
      `;
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${input.ownerPrincipalId ?? null}, 'agent.created', 'agent', ${rows[0]?.id ?? "unknown"}, encode(digest(${JSON.stringify(input)}, 'sha256'), 'hex'), ${tx.json({ displayName: input.displayName, purpose: input.purpose, ownerPrincipalId: input.ownerPrincipalId ?? null })})
      `;
      const record = rows[0];
      if (!record) throw new Error("Agent insert returned no row");
      return record;
    });
  }

  listAgents(organizationId: string) {
    return this.sql<AgentRecord[]>`
      select a.id::text, a.organization_id::text as "organizationId", a.principal_id::text as "principalId",
        p.display_name as "displayName", a.purpose, a.status, a.capability_version as "capabilityVersion"
      from agents a join principals p on p.id = a.principal_id
      where a.organization_id = ${organizationId}
      order by a.created_at
    `;
  }

  async setAgentStatus(organizationId: string, agentId: string, status: AgentRecord["status"]) {
    const rows = await this.sql<AgentRecord[]>`
      update agents a set status = ${status}, capability_version = capability_version + 1, updated_at = now()
      from principals p
      where a.id = ${agentId} and a.organization_id = ${organizationId} and p.id = a.principal_id
      returning a.id::text, a.organization_id::text as "organizationId", a.principal_id::text as "principalId",
        p.display_name as "displayName", a.purpose, a.status, a.capability_version as "capabilityVersion"
    `;
    return rows[0] ?? null;
  }

  async createTreasury(organizationId: string, input: Omit<TreasuryRecord, "id" | "organizationId" | "status" | "createdAt">) {
    const rows = await this.sql<TreasuryRecord[]>`
      insert into treasury_accounts (organization_id, name, chain_family, network, address, governance, status)
      values (${organizationId}, ${input.name}, ${input.chainFamily}, ${input.network}, ${input.address}, ${input.governance}, 'active')
      returning id::text, organization_id::text as "organizationId", name, chain_family as "chainFamily",
        network, address, governance, status, created_at::text as "createdAt"
    `;
    if (!rows[0]) throw new Error("Treasury insert returned no row");
    return rows[0];
  }

  listTreasuries(organizationId: string) {
    return this.sql<TreasuryRecord[]>`
      select id::text, organization_id::text as "organizationId", name, chain_family as "chainFamily",
        network, address, governance, status, created_at::text as "createdAt"
      from treasury_accounts where organization_id = ${organizationId} order by created_at
    `;
  }

  async createSigner(organizationId: string, input: { agentId?: string; chainFamily: SignerRecord["chainFamily"]; address: string; encryptedSecret: string; encryptionNonce: string; authTag: string; keyVersion: number }) {
    const rows = await this.sql<SignerRecord[]>`
      insert into signers (organization_id, agent_id, chain_family, address, custody, encrypted_secret, encryption_nonce, auth_tag, key_version)
      values (${organizationId}, ${input.agentId ?? null}, ${input.chainFamily}, ${input.address}, 'encrypted_software', ${input.encryptedSecret}, ${input.encryptionNonce}, ${input.authTag}, ${input.keyVersion})
      returning id::text, organization_id::text as "organizationId", agent_id::text as "agentId",
        chain_family as "chainFamily", address, custody, status, created_at::text as "createdAt"
    `;
    if (!rows[0]) throw new Error("Signer insert returned no row");
    return rows[0];
  }

  listSigners(organizationId: string) {
    return this.sql<SignerRecord[]>`
      select id::text, organization_id::text as "organizationId", agent_id::text as "agentId",
        chain_family as "chainFamily", address, custody, status, created_at::text as "createdAt"
      from signers where organization_id = ${organizationId} order by created_at
    `;
  }

  async getSignerSecret(organizationId: string, signerId: string) {
    const rows = await this.sql<StoredSignerSecret[]>`
      select id::text, organization_id::text as "organizationId", agent_id::text as "agentId",
        chain_family as "chainFamily", address, custody, status, created_at::text as "createdAt",
        encrypted_secret as "encryptedSecret", encryption_nonce as "encryptionNonce", auth_tag as "authTag", key_version as "keyVersion"
      from signers where organization_id = ${organizationId} and id = ${signerId}
    `;
    return rows[0] ?? null;
  }

  async createIntent(intent: PaymentIntent) {
    return this.sql.begin(async (tx) => {
      const existing = await tx<IntentRecord[]>`
        select id::text, idempotency_key as "idempotencyKey", organization_id::text as "organizationId",
          treasury_account_id::text as "treasuryAccountId", requester_principal_id::text as "requesterId",
          network, asset_id as "assetId", amount_base_units::text as "amountBaseUnits", destination,
          purpose, expires_at::text as "expiresAt", kind, status, version, created_at::text as "createdAt"
        from intents
        where organization_id = ${intent.organizationId} and requester_principal_id = ${intent.requesterId}
          and idempotency_key = ${intent.idempotencyKey}
      `;
      if (existing[0]) return { record: existing[0], created: false };

      const rows = await tx<IntentRecord[]>`
        insert into intents (
          id, organization_id, treasury_account_id, requester_principal_id, idempotency_key, kind,
          network, asset_id, amount_base_units, destination, purpose, status, expires_at
        ) values (
          ${intent.id}, ${intent.organizationId}, ${intent.treasuryAccountId}, ${intent.requesterId},
          ${intent.idempotencyKey}, ${intent.kind}, ${intent.network}, ${intent.assetId},
          ${intent.amountBaseUnits}, ${intent.destination}, ${intent.purpose}, 'received', ${intent.expiresAt}
        ) returning id::text, idempotency_key as "idempotencyKey", organization_id::text as "organizationId",
          treasury_account_id::text as "treasuryAccountId", requester_principal_id::text as "requesterId",
          network, asset_id as "assetId", amount_base_units::text as "amountBaseUnits", destination,
          purpose, expires_at::text as "expiresAt", kind, status, version, created_at::text as "createdAt"
      `;
      const record = rows[0];
      if (!record) throw new Error("Intent insert returned no row");
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

  listIntents(organizationId: string) {
    return this.sql<IntentRecord[]>`
      select id::text, idempotency_key as "idempotencyKey", organization_id::text as "organizationId",
        treasury_account_id::text as "treasuryAccountId", requester_principal_id::text as "requesterId",
        network, asset_id as "assetId", amount_base_units::text as "amountBaseUnits", destination,
        purpose, expires_at::text as "expiresAt", kind, status, version, created_at::text as "createdAt"
      from intents where organization_id = ${organizationId} order by created_at desc
    `;
  }

  async getApprovalRequest(organizationId: string, intentId: string) {
    const rows = await this.sql<ApprovalRequestRecord[]>`
      select ar.intent_id::text as "intentId", ar.required_approvals as "requiredApprovals",
        count(a.id) filter (where a.decision = 'approved')::int as approvals,
        ar.compiled_hash as "compiledHash", ar.simulation_hash as "simulationHash",
        ar.status, ar.expires_at::text as "expiresAt"
      from approval_requests ar left join approvals a on a.intent_id = ar.intent_id
      where ar.organization_id = ${organizationId} and ar.intent_id = ${intentId}
      group by ar.id
    `;
    return rows[0] ?? null;
  }

  async decideIntent(organizationId: string, intentId: string, input: { principalId: string; decision: "approved" | "rejected"; expectedIntentVersion: number; compiledHash: string; simulationHash: string; signedPayload?: string }) {
    return this.sql.begin(async (tx): Promise<ApprovalResult> => {
      const principals = await tx<PrincipalRecord[]>`
        select id::text, organization_id::text as "organizationId", type, display_name as "displayName", role, status
        from principals where id = ${input.principalId} and organization_id = ${organizationId}
      `;
      const principal = principals[0];
      if (!principal) throw new ApprovalError("not_found");
      if (principal.type !== "human" || principal.status !== "active" || !["owner", "approver"].includes(principal.role)) throw new ApprovalError("not_eligible");
      const rows = await tx<{ status: string; version: number; expiresAt: string; requestStatus: string; requiredApprovals: number; compiledHash: string | null; simulationHash: string | null }[]>`
        select i.status, i.version, i.expires_at::text as "expiresAt", ar.status as "requestStatus",
          ar.required_approvals as "requiredApprovals", ar.compiled_hash as "compiledHash", ar.simulation_hash as "simulationHash"
        from intents i join approval_requests ar on ar.intent_id = i.id
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
      if (!state.compiledHash || !state.simulationHash || state.compiledHash !== input.compiledHash || state.simulationHash !== input.simulationHash) throw new ApprovalError("evidence_mismatch");
      await tx`
        insert into approvals (organization_id, intent_id, approver_principal_id, decision, signed_payload)
        values (${organizationId}, ${intentId}, ${input.principalId}, ${input.decision}, ${input.signedPayload ?? null})
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
        values (${organizationId}, ${intentId}, ${eventRows[0]?.sequence ?? 1}, ${`intent.${input.decision}`}, ${input.principalId}, ${tx.json({ approvals, requiredApprovals: state.requiredApprovals, compiledHash: input.compiledHash, simulationHash: input.simulationHash })})
      `;
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${input.principalId}, ${`intent.${input.decision}`}, 'intent', ${intentId}, encode(digest(${JSON.stringify(input)}, 'sha256'), 'hex'), ${tx.json({ intentId, decision: input.decision, expectedIntentVersion: input.expectedIntentVersion })})
      `;
      if (nextStatus === "approved") await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${organizationId}, 'transaction.execute', 'intent', ${intentId}, ${tx.json({ intentId })})
      `;
      return { intentId, intentStatus: nextStatus, requestStatus, approvals, requiredApprovals: state.requiredApprovals, idempotentReplay: false };
    });
  }

  async close() { await this.sql.end(); }
}

export function createPostgresStore(databaseUrl: string): PostgresControlPlaneStore {
  return new PostgresControlPlaneStore(postgres(databaseUrl, { max: 10, idle_timeout: 20 }));
}

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private organizations: OrganizationRecord[] = [];
  private agents: AgentRecord[] = [];
  private intents: IntentRecord[] = [];
  private treasuries: TreasuryRecord[] = [];
  private signers: StoredSignerSecret[] = [];
  private principals: PrincipalRecord[] = [];
  async health() { return true; }
  async createOrganization(input: { name: string; slug: string }) {
    const record: OrganizationRecord = { id: crypto.randomUUID(), ...input, environment: "test", frozen: false, createdAt: new Date().toISOString() };
    this.organizations.unshift(record); return record;
  }
  async listOrganizations() { return [...this.organizations]; }
  async createHumanPrincipal(organizationId: string, input: { displayName: string; role: "owner" | "approver" | "operator" | "auditor" | "developer" }) { const record: PrincipalRecord = { id: crypto.randomUUID(), organizationId, type: "human", displayName: input.displayName, role: input.role, status: "active" }; this.principals.push(record); return record; }
  async listPrincipals(organizationId: string) { return this.principals.filter((p) => p.organizationId === organizationId); }
  async createAgent(organizationId: string, input: CreateAgentInput) {
    const record: AgentRecord = { id: crypto.randomUUID(), organizationId, principalId: crypto.randomUUID(), displayName: input.displayName, purpose: input.purpose, status: "active", capabilityVersion: 1 };
    this.agents.push(record); return record;
  }
  async listAgents(organizationId: string) { return this.agents.filter((a) => a.organizationId === organizationId); }
  async setAgentStatus(organizationId: string, agentId: string, status: AgentRecord["status"]) {
    const agent = this.agents.find((a) => a.organizationId === organizationId && a.id === agentId);
    if (!agent) return null; agent.status = status; agent.capabilityVersion += 1; return { ...agent };
  }
  async createTreasury(organizationId: string, input: Omit<TreasuryRecord, "id" | "organizationId" | "status" | "createdAt">) {
    const record: TreasuryRecord = { id: crypto.randomUUID(), organizationId, ...input, status: "active", createdAt: new Date().toISOString() };
    this.treasuries.push(record); return record;
  }
  async listTreasuries(organizationId: string) { return this.treasuries.filter((t) => t.organizationId === organizationId); }
  async createSigner(organizationId: string, input: { agentId?: string; chainFamily: SignerRecord["chainFamily"]; address: string; encryptedSecret: string; encryptionNonce: string; authTag: string; keyVersion: number }) {
    const record: StoredSignerSecret = { id: crypto.randomUUID(), organizationId, agentId: input.agentId ?? null, chainFamily: input.chainFamily, address: input.address, custody: "encrypted_software", status: "active", createdAt: new Date().toISOString(), encryptedSecret: input.encryptedSecret, encryptionNonce: input.encryptionNonce, authTag: input.authTag, keyVersion: input.keyVersion };
    this.signers.push(record); const { encryptedSecret: _a, encryptionNonce: _b, authTag: _c, keyVersion: _d, ...publicRecord } = record; return publicRecord;
  }
  async listSigners(organizationId: string) { return this.signers.filter((s) => s.organizationId === organizationId).map(({ encryptedSecret: _a, encryptionNonce: _b, authTag: _c, keyVersion: _d, ...record }) => record); }
  async getSignerSecret(organizationId: string, signerId: string) { return this.signers.find((s) => s.organizationId === organizationId && s.id === signerId) ?? null; }
  async createIntent(intent: PaymentIntent) {
    const existing = this.intents.find((i) => i.organizationId === intent.organizationId && i.requesterId === intent.requesterId && i.idempotencyKey === intent.idempotencyKey);
    if (existing) return { record: existing, created: false };
    const record: IntentRecord = { ...intent, status: "received", version: 1, createdAt: new Date().toISOString() };
    this.intents.unshift(record); return { record, created: true };
  }
  async listIntents(organizationId: string) { return this.intents.filter((i) => i.organizationId === organizationId); }
  async getApprovalRequest(_organizationId: string, _intentId: string) { return null; }
  async decideIntent(_organizationId: string, intentId: string, _input: { principalId: string; decision: "approved" | "rejected"; expectedIntentVersion: number; compiledHash: string; simulationHash: string; signedPayload?: string }): Promise<ApprovalResult> { const intent = this.intents.find((i) => i.id === intentId); if (!intent) throw new ApprovalError("not_found"); throw new ApprovalError("invalid_state"); }
  async close() {}
}
