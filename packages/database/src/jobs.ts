import postgres, { type JSONValue, type Sql, type TransactionSql } from "postgres";

type Db = Sql | TransactionSql;
import { evaluatePaymentIntent } from "@ai-neobank/policy";
import { policyDefinitionSchema, nativeAssetIds, type PaymentIntent, type PolicyDecision, type SpendingPolicy } from "@ai-neobank/domain";

export interface JobRecord {
  id: string;
  organizationId: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** A terminal outcome: the intent must be failed, not retried. */
export class ExecutionRejected extends Error {
  constructor(message: string) { super(message); this.name = "ExecutionRejected"; }
}

/** Not an error: check again later without counting toward the dead-letter limit. */
export class Deferred extends Error {
  constructor(message: string, readonly delaySeconds = 5) { super(message); this.name = "Deferred"; }
}

export interface AssetShape {
  id: string;
  kind: "native" | "erc20" | "spl";
  address: string | null;
  decimals: number;
}

export interface ExecutionContext {
  intentId: string;
  organizationId: string;
  treasuryId: string;
  network: string;
  chainFamily: "evm" | "svm";
  governance: "safe" | "squads" | "direct";
  from: string;
  to: string;
  assetId: string;
  asset: AssetShape;
  amountBaseUnits: string;
  intentStatus: string;
  intentVersion: number;
  /** The key that signs: the treasury itself (direct) or the organisation's executor (Safe, Squads). */
  signerId: string;
  signerAddress: string;
  encryptedSecret: string;
  encryptionNonce: string;
  authTag: string;
  keyVersion: number;
  approvalCompiledHash: string;
  externalRef: Record<string, unknown> | null;
  treasuryConfiguration: Record<string, unknown>;
  /** Off-chain owner signatures collected for a Safe transaction. */
  ownerSignatures: { signerAddress: string; signedPayload: string }[];
  kind: "transfer" | "x402";
  /** x402: the quote captured at intake. */
  x402: Record<string, unknown> | null;
  execution: { id: string; status: string; transactionHash: string | null; signedPayload: string | null; nonce: string | null; validUntil: string | null } | null;
}

export interface PublishContext {
  intentId: string;
  organizationId: string;
  treasuryId: string;
  network: string;
  chainFamily: "evm" | "svm";
  governance: "safe" | "squads";
  from: string;
  to: string;
  asset: AssetShape;
  amountBaseUnits: string;
  expiresAt: string;
  minApprovals: number;
  treasuryConfiguration: Record<string, unknown>;
  executorSignerId: string;
  executorAddress: string;
  encryptedSecret: string;
  encryptionNonce: string;
  authTag: string;
  keyVersion: number;
  /** What a previous, possibly crashed, attempt recorded before broadcasting. */
  publication: Record<string, unknown> | null;
}

export type Publisher = (context: PublishContext) => Promise<{ compiledHash: string; requiredApprovals: number; externalRef: Record<string, unknown> }>;

export interface ProposalObservation {
  status: "draft" | "active" | "rejected" | "approved" | "executing" | "executed" | "cancelled";
  approved: string[];
  rejected: string[];
}

export type Observer = (input: { organizationId: string; chainFamily: "evm" | "svm"; network: string; externalRef: Record<string, unknown>; treasuryConfiguration: Record<string, unknown> }) => Promise<ProposalObservation | null>;

export interface ConfirmationContext {
  intentId: string;
  organizationId: string;
  treasuryId: string;
  network: string;
  chainFamily: "evm" | "svm";
  to: string;
  assetId: string;
  asset: AssetShape;
  amountBaseUnits: string;
  executionId: string;
  transactionHash: string;
}

export interface SimulationEvidence {
  ok: boolean;
  feeBaseUnits: string;
  sourceBalanceBaseUnits: string;
  error?: string;
  /** x402: the selected 402 requirements and resource, captured at intake as approval evidence. */
  quote?: Record<string, unknown>;
  /** x402: hash of the quote; replaces the field hash as the compiled hash the approver signs over. */
  compiledHash?: string;
}

export type Simulator = (input: { chainFamily: "evm" | "svm"; network: string; governance: "safe" | "squads" | "direct"; treasuryConfiguration: Record<string, unknown>; from: string; to: string; asset: AssetShape; amountBaseUnits: string; intentId: string; kind: "transfer" | "x402" }) => Promise<SimulationEvidence>;

interface IntentRow {
  intentId: string;
  organizationId: string;
  treasuryId: string;
  requesterId: string;
  requesterType: string;
  requesterStatus: string;
  agentStatus: string | null;
  organizationFrozen: boolean;
  autonomousExecution: boolean;
  treasuryStatus: string;
  treasuryNetwork: string;
  chainFamily: "evm" | "svm";
  governance: "safe" | "squads" | "direct";
  executorSignerId: string | null;
  observedConfiguration: Record<string, unknown>;
  publication: Record<string, unknown> | null;
  policyDecision: Record<string, unknown> | null;
  from: string;
  idempotencyKey: string;
  kind: "transfer" | "x402";
  network: string;
  assetId: string;
  assetKind: "native" | "erc20" | "spl" | null;
  assetAddress: string | null;
  assetDecimals: number | null;
  assetNetwork: string | null;
  amountBaseUnits: string;
  destination: string;
  purpose: string;
  status: string;
  version: number;
  expiresAt: string;
  compiledHash: string;
}

const intentJoin = `
  select i.id::text as "intentId", i.organization_id::text as "organizationId", i.treasury_account_id::text as "treasuryId",
    i.requester_principal_id::text as "requesterId", rp.type as "requesterType", rp.status as "requesterStatus", ag.status as "agentStatus",
    o.frozen as "organizationFrozen", o.autonomous_execution as "autonomousExecution",
    t.status as "treasuryStatus", t.network as "treasuryNetwork", t.chain_family as "chainFamily", t.governance, t.address as "from",
    t.executor_signer_id::text as "executorSignerId", t.observed_configuration as "observedConfiguration", i.publication, i.policy_decision as "policyDecision",
    i.idempotency_key as "idempotencyKey", i.kind, i.network, i.asset_id as "assetId",
    a.kind as "assetKind", a.address as "assetAddress", a.decimals as "assetDecimals", a.network as "assetNetwork",
    i.amount_base_units::text as "amountBaseUnits", i.destination, i.purpose, i.status, i.version, i.expires_at::text as "expiresAt",
    encode(digest(concat_ws('|', i.id::text, i.network, i.asset_id, i.amount_base_units::text, i.destination, i.kind), 'sha256'), 'hex') as "compiledHash"
  from intents i
  join organizations o on o.id = i.organization_id
  join treasury_accounts t on t.id = i.treasury_account_id
  join principals rp on rp.id = i.requester_principal_id
  left join agents ag on ag.principal_id = rp.id
  left join assets a on a.id = i.asset_id
`;

export class PostgresJobQueue {
  constructor(readonly sql: Sql) {}

  // Outbox and job leasing

  async pumpOutbox(limit = 100): Promise<number> {
    return this.sql.begin(async (tx) => {
      const events = await tx<{ id: string; organizationId: string | null; topic: string; payload: Record<string, unknown> }[]>`
        select id::text, organization_id::text as "organizationId", topic, payload
        from outbox_events
        where processed_at is null and available_at <= now()
        order by created_at
        for update skip locked
        limit ${limit}
      `;
      for (const event of events) {
        await tx`
          insert into jobs (organization_id, type, payload, dedupe_key)
          values (${event.organizationId}, ${event.topic}, ${tx.json(event.payload as JSONValue)}, ${`outbox:${event.id}`})
          on conflict (dedupe_key) where dedupe_key is not null do nothing
        `;
        await tx`update outbox_events set processed_at = now(), claimed_at = coalesce(claimed_at, now()), attempts = attempts + 1 where id = ${event.id}`;
      }
      return events.length;
    });
  }

  /** Leases the next ready job. A job left `running` by a crashed worker is re-leased once its lease lapses. */
  async claim(workerId: string, leaseSeconds = 60): Promise<JobRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<JobRecord[]>`
        with candidate as (
          select id from jobs
          where (status in ('queued', 'retry') and run_at <= now())
             or (status = 'running' and leased_until < now())
          order by run_at, created_at
          for update skip locked
          limit 1
        )
        update jobs j set status = 'running', leased_until = now() + (${leaseSeconds} * interval '1 second'),
          attempts = attempts + 1, updated_at = now(), last_error = null,
          payload = j.payload || ${tx.json({ claimedBy: workerId })}
        from candidate where j.id = candidate.id
        returning j.id::text, j.organization_id::text as "organizationId", j.type, j.payload,
          j.attempts, j.max_attempts as "maxAttempts"
      `;
      return rows[0] ?? null;
    });
  }

  async heartbeat(jobId: string, leaseSeconds = 60): Promise<void> {
    await this.sql`update jobs set leased_until = now() + (${leaseSeconds} * interval '1 second') where id = ${jobId} and status = 'running'`;
  }

  async complete(jobId: string): Promise<void> {
    await this.sql`update jobs set status = 'succeeded', leased_until = null, updated_at = now() where id = ${jobId} and status = 'running'`;
  }

  async fail(job: JobRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= job.maxAttempts;
    const delay = Math.min(300, 2 ** Math.min(job.attempts, 8));
    await this.sql`
      update jobs set status = ${dead ? "dead" : "retry"}, leased_until = null,
        run_at = now() + (${delay} * interval '1 second'), last_error = ${message.slice(0, 2000)}, updated_at = now()
      where id = ${job.id}
    `;
  }

  /** Re-queues without counting an attempt; for waiting on chain finality. */
  async defer(job: JobRecord, delaySeconds: number, note: string): Promise<void> {
    await this.sql`
      update jobs set status = 'retry', leased_until = null, attempts = greatest(attempts - 1, 0),
        run_at = now() + (${delaySeconds} * interval '1 second'), last_error = ${note.slice(0, 2000)}, updated_at = now()
      where id = ${job.id}
    `;
  }

  async listJobs(filter: { status?: string; limit?: number } = {}): Promise<(JobRecord & { status: string; lastError: string | null; runAt: string })[]> {
    return this.sql<(JobRecord & { status: string; lastError: string | null; runAt: string })[]>`
      select id::text, organization_id::text as "organizationId", type, payload, attempts, max_attempts as "maxAttempts", status, last_error as "lastError", run_at::text as "runAt"
      from jobs where (${filter.status ?? null}::text is null or status = ${filter.status ?? null}) order by created_at desc limit ${filter.limit ?? 100}
    `;
  }

  // Policy

  private async loadPolicy(tx: Db, organizationId: string, requesterId: string, treasuryId: string): Promise<{ versionId: string; policy: SpendingPolicy } | null> {
    const rows = await tx<{ id: string; version: number; policyId: string; definition: unknown }[]>`
      select pv.id::text, pv.version, pv.policy_id::text as "policyId", pv.definition
      from policy_bindings b
      join policy_versions pv on pv.id = b.policy_version_id
      join agents ag on ag.id = b.agent_id
      where b.organization_id = ${organizationId} and ag.principal_id = ${requesterId} and b.treasury_account_id is null and pv.status = 'active'
      union all
      select pv.id::text, pv.version, pv.policy_id::text, pv.definition
      from policy_bindings b
      join policy_versions pv on pv.id = b.policy_version_id
      where b.organization_id = ${organizationId} and b.treasury_account_id = ${treasuryId} and b.agent_id is null and pv.status = 'active'
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const definition = policyDefinitionSchema.parse(row.definition);
    return { versionId: row.id, policy: { ...definition, id: row.policyId, version: row.version } };
  }

  /** Base units of the same asset the requester has committed in the trailing 24 hours, excluding this intent. */
  private async spentToday(tx: Db, organizationId: string, requesterId: string, assetId: string, excludeIntentId: string): Promise<string> {
    const rows = await tx<{ spent: string }[]>`
      select coalesce(sum(amount_base_units), 0)::text as spent from intents
      where organization_id = ${organizationId} and requester_principal_id = ${requesterId} and asset_id = ${assetId} and id <> ${excludeIntentId}
        and status in ('approval_required', 'auto_authorized', 'approved', 'executing', 'submitted', 'finalized', 'reconciled')
        and created_at > now() - interval '24 hours'
    `;
    return rows[0]?.spent ?? "0";
  }

  private gate(row: IntentRow): string | null {
    if (row.organizationFrozen) return "Organization is frozen";
    if (row.treasuryStatus !== "active") return `Treasury is ${row.treasuryStatus}`;
    if (row.requesterStatus !== "active") return `Requester is ${row.requesterStatus}`;
    if (row.requesterType === "agent" && row.agentStatus !== "active") return `Agent is ${row.agentStatus ?? "unregistered"}`;
    if (row.treasuryNetwork !== row.network) return "Intent network does not match the treasury network";
    if (!row.assetKind || row.assetDecimals === null) return `Unknown asset ${row.assetId}`;
    if (row.assetNetwork !== row.network) return "Asset does not belong to the intent network";
    if (row.kind === "x402") {
      if (row.governance !== "direct") return "x402 payments are made from direct treasuries; governed treasuries are not supported for x402 yet";
      if (row.assetKind === "native") return "x402 pays in tokens, not the native coin";
      if (!/^https?:\/\//.test(row.destination)) return "x402 destination must be an http(s) resource URL";
    }
    return null;
  }

  private intentOf(row: IntentRow): PaymentIntent {
    return { id: row.intentId, idempotencyKey: row.idempotencyKey, organizationId: row.organizationId, treasuryAccountId: row.treasuryId, requesterId: row.requesterId, network: row.network, assetId: row.assetId, amountBaseUnits: row.amountBaseUnits, destination: row.destination, purpose: row.purpose, expiresAt: row.expiresAt, kind: row.kind };
  }

  /**
   * Intake: gates, policy, and a real simulation against the chain before any
   * approval request exists. The simulation runs outside the transaction; the
   * transition re-checks the intent is still `received` under lock.
   */
  async evaluateIntent(intentId: string, simulate?: Simulator): Promise<void> {
    const rows = await this.sql.unsafe<IntentRow[]>(`${intentJoin} where i.id = $1`, [intentId]);
    const row = rows[0];
    if (!row) throw new Error("Intent not found");
    if (row.status !== "received") return;
    if (new Date(row.expiresAt) <= new Date()) {
      await this.sql.begin((tx) => this.transition(tx, intentId, row.organizationId, row.version, "received", "expired", "intent.expired"));
      return;
    }
    const gate = this.gate(row);
    if (gate) {
      await this.reject(intentId, row, { outcome: "rejected", reasons: [gate] }, null);
      return;
    }
    const asset: AssetShape = { id: row.assetId, kind: row.assetKind!, address: row.assetAddress, decimals: row.assetDecimals! };
    const policyResult = await this.loadPolicy(this.sql, row.organizationId, row.requesterId, row.treasuryId);
    const spent = await this.spentToday(this.sql, row.organizationId, row.requesterId, row.assetId, intentId);
    const decision: PolicyDecision = policyResult
      ? evaluatePaymentIntent(this.intentOf(row), policyResult.policy, { spentTodayBaseUnits: spent, now: new Date() })
      : { outcome: "approval_required", reasons: ["No policy is bound to this agent or treasury; human approval is required"] };
    if (decision.outcome === "rejected") {
      await this.reject(intentId, row, decision, policyResult?.versionId ?? null);
      return;
    }
    let evidence: SimulationEvidence = { ok: true, feeBaseUnits: "0", sourceBalanceBaseUnits: "unknown" };
    if (simulate) {
      evidence = await simulate({ chainFamily: row.chainFamily, network: row.network, governance: row.governance, treasuryConfiguration: row.observedConfiguration ?? {}, from: row.from, to: row.destination, asset, amountBaseUnits: row.amountBaseUnits, intentId, kind: row.kind });
      if (!evidence.ok) {
        await this.reject(intentId, row, { outcome: "rejected", reasons: [`Simulation failed: ${evidence.error ?? "unknown"}`] }, policyResult?.versionId ?? null);
        return;
      }
    }
    const requiredApprovals = policyResult?.policy.minApprovals ?? 1;
    if (row.governance !== "direct") {
      // Governed treasuries: owners decide on chain or with owner signatures, so the
      // proposal is published first and the approval request follows from it.
      await this.sql.begin(async (tx) => {
        const locked = await tx<{ status: string }[]>`select status from intents where id = ${intentId} for update`;
        if (locked[0]?.status !== "received") return;
        const simulationHash = await this.hash(tx, ["simulation-v1", intentId, row.network, row.amountBaseUnits, row.destination, evidence.feeBaseUnits, evidence.sourceBalanceBaseUnits]);
        await tx`update intents set policy_version_id = ${policyResult?.versionId ?? null}, policy_decision = ${tx.json({ outcome: "approval_required", reasons: [...decision.reasons, `${row.governance} treasury: owners approve on chain`], spentTodayBaseUnits: spent, simulation: evidence, simulationHash, minApprovals: requiredApprovals } as never)} where id = ${intentId}`;
        await this.transition(tx, intentId, row.organizationId, row.version, "received", "policy_evaluated", "intent.policy_evaluated", { governance: row.governance, requiredApprovals });
        await tx`
          insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
          values (${row.organizationId}, 'proposal.publish', 'intent', ${intentId}, ${tx.json({ intentId })})
        `;
      });
      return;
    }
    const autonomous = decision.outcome === "auto_authorized" && row.autonomousExecution;
    const reasons = decision.outcome === "auto_authorized" && !row.autonomousExecution
      ? [...decision.reasons, "Autonomous execution is disabled for this organization"]
      : decision.reasons;
    const compiledHash = evidence.compiledHash ?? row.compiledHash;
    await this.sql.begin(async (tx) => {
      const locked = await tx<{ status: string; version: number }[]>`select status, version from intents where id = ${intentId} for update`;
      if (locked[0]?.status !== "received") return;
      const { quote, ...simulation } = evidence;
      await tx`update intents set policy_version_id = ${policyResult?.versionId ?? null}, policy_decision = ${tx.json({ outcome: autonomous ? "auto_authorized" : "approval_required", reasons, spentTodayBaseUnits: spent, simulation, ...(quote ? { x402: quote } : {}) } as never)} where id = ${intentId}`;
      const simulationHash = await this.hash(tx, ["simulation-v1", intentId, row.network, row.amountBaseUnits, row.destination, evidence.feeBaseUnits, evidence.sourceBalanceBaseUnits]);
      if (autonomous) {
        await this.transition(tx, intentId, row.organizationId, row.version, "received", "approved", "intent.auto_authorized", { reasons, requiredApprovals: 0 });
        await tx`
          insert into approval_requests (organization_id, intent_id, required_approvals, compiled_hash, simulation_hash, status, expires_at)
          values (${row.organizationId}, ${intentId}, 1, ${compiledHash}, ${simulationHash}, 'approved', ${row.expiresAt})
          on conflict (intent_id) do nothing
        `;
        await tx`
          insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
          values (${row.organizationId}, 'transaction.execute', 'intent', ${intentId}, ${tx.json({ intentId })})
        `;
        return;
      }
      await this.transition(tx, intentId, row.organizationId, row.version, "received", "approval_required", "intent.approval_required", { reasons, requiredApprovals });
      await tx`
        insert into approval_requests (organization_id, intent_id, required_approvals, compiled_hash, simulation_hash, expires_at)
        values (${row.organizationId}, ${intentId}, ${requiredApprovals}, ${compiledHash}, ${simulationHash}, ${row.expiresAt})
        on conflict (intent_id) do nothing
      `;
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload, available_at)
        values (${row.organizationId}, 'approval.expire', 'intent', ${intentId}, ${tx.json({ intentId })}, ${row.expiresAt})
      `;
    });
  }

  private async reject(intentId: string, row: IntentRow, decision: PolicyDecision, policyVersionId: string | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      const locked = await tx<{ status: string }[]>`select status from intents where id = ${intentId} for update`;
      if (locked[0]?.status !== "received") return;
      await tx`update intents set policy_version_id = ${policyVersionId}, policy_decision = ${tx.json(decision as never)}, failure_reason = ${decision.reasons.join("; ")} where id = ${intentId}`;
      await this.transition(tx, intentId, row.organizationId, row.version, "received", "rejected", "intent.rejected", { reasons: decision.reasons });
    });
  }

  private async hash(tx: Db, parts: string[]): Promise<string> {
    const rows = await tx<{ hash: string }[]>`select encode(digest(${parts.join("|")}, 'sha256'), 'hex') as hash`;
    return rows[0]!.hash;
  }

  /** Everything the worker needs to publish a governed intent's proposal. */
  async getPublishContext(intentId: string): Promise<PublishContext> {
    const rows = await this.sql.unsafe<(IntentRow & { signerAddress: string | null; encryptedSecret: string | null; encryptionNonce: string | null; authTag: string | null; keyVersion: number | null; signerStatus: string | null })[]>(`
      select base.*, s.address as "signerAddress", s.encrypted_secret as "encryptedSecret", s.encryption_nonce as "encryptionNonce", s.auth_tag as "authTag", s.key_version as "keyVersion", s.status as "signerStatus"
      from (${intentJoin} where i.id = $1) base
      left join signers s on s.id = base."executorSignerId"::uuid and s.organization_id = base."organizationId"::uuid
    `, [intentId]);
    const row = rows[0];
    if (!row) throw new Error("Intent not found");
    if (row.status !== "policy_evaluated") throw new Error(`Intent is ${row.status}, not policy_evaluated`);
    if (row.governance === "direct") throw new ExecutionRejected("Direct treasuries do not publish proposals");
    const gate = this.gate(row);
    if (gate) throw new ExecutionRejected(gate);
    if (!row.executorSignerId || !row.signerAddress || !row.encryptedSecret || !row.encryptionNonce || !row.authTag || row.keyVersion === null) throw new ExecutionRejected("Treasury has no executor signer");
    if (row.signerStatus !== "active") throw new ExecutionRejected(`Executor signer is ${row.signerStatus}`);
    if (new Date(row.expiresAt) <= new Date()) throw new ExecutionRejected("Intent expired before publication");
    const minApprovals = Number((row.policyDecision as { minApprovals?: number } | null)?.minApprovals ?? 1);
    return {
      intentId, organizationId: row.organizationId, treasuryId: row.treasuryId, network: row.network, chainFamily: row.chainFamily, governance: row.governance,
      from: row.from, to: row.destination, asset: { id: row.assetId, kind: row.assetKind!, address: row.assetAddress, decimals: row.assetDecimals! }, amountBaseUnits: row.amountBaseUnits,
      expiresAt: row.expiresAt, minApprovals, treasuryConfiguration: row.observedConfiguration ?? {},
      executorSignerId: row.executorSignerId, executorAddress: row.signerAddress, encryptedSecret: row.encryptedSecret, encryptionNonce: row.encryptionNonce, authTag: row.authTag, keyVersion: row.keyVersion,
      publication: row.publication
    };
  }

  /** Persists what the publisher is about to broadcast so a retry can recognise its own work. */
  async recordPublication(intentId: string, publication: Record<string, unknown>): Promise<void> {
    await this.sql`update intents set publication = ${this.sql.json(publication as never)}, updated_at = now() where id = ${intentId}`;
  }

  /** Publication done: the approval request now points at the Safe hash or the Squads proposal. */
  async completePublication(intentId: string, result: { compiledHash: string; requiredApprovals: number; externalRef: Record<string, unknown> }): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; status: string; version: number; expiresAt: string; governance: string; simulationHash: string | null }[]>`
        select i.organization_id::text as "organizationId", i.status, i.version, i.expires_at::text as "expiresAt", t.governance, i.policy_decision->>'simulationHash' as "simulationHash"
        from intents i join treasury_accounts t on t.id = i.treasury_account_id where i.id = ${intentId} for update of i
      `;
      const row = rows[0];
      if (!row) throw new Error("Intent not found");
      if (row.status !== "policy_evaluated") return;
      await this.transition(tx, intentId, row.organizationId, row.version, "policy_evaluated", "approval_required", "intent.approval_required", { requiredApprovals: result.requiredApprovals, externalRef: result.externalRef });
      await tx`
        insert into approval_requests (organization_id, intent_id, required_approvals, compiled_hash, simulation_hash, external_ref, expires_at)
        values (${row.organizationId}, ${intentId}, ${result.requiredApprovals}, ${result.compiledHash}, ${row.simulationHash ?? ""}, ${tx.json(result.externalRef as never)}, ${row.expiresAt})
        on conflict (intent_id) do update set required_approvals = excluded.required_approvals, compiled_hash = excluded.compiled_hash, external_ref = excluded.external_ref
      `;
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload, available_at)
        values (${row.organizationId}, 'approval.expire', 'intent', ${intentId}, ${tx.json({ intentId })}, ${row.expiresAt})
      `;
      if (row.governance === "squads") await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${row.organizationId}, 'proposal.observe', 'intent', ${intentId}, ${tx.json({ intentId })})
      `;
    });
  }

  /**
   * Reads on-chain votes into approvals. The chain's own threshold decides;
   * the database only mirrors it and schedules the next look.
   */
  async observeProposal(intentId: string, observe: Observer): Promise<void> {
    const rows = await this.sql<{ organizationId: string; status: string; version: number; requestStatus: string; externalRef: Record<string, unknown> | null; expiresAt: string; chainFamily: "evm" | "svm"; network: string; treasuryConfiguration: Record<string, unknown> }[]>`
      select i.organization_id::text as "organizationId", i.status, i.version, ar.status as "requestStatus", ar.external_ref as "externalRef", ar.expires_at::text as "expiresAt",
        t.chain_family as "chainFamily", i.network, t.observed_configuration as "treasuryConfiguration"
      from intents i join approval_requests ar on ar.intent_id = i.id join treasury_accounts t on t.id = i.treasury_account_id where i.id = ${intentId}
    `;
    const row = rows[0];
    if (!row) throw new Error("Intent not found");
    if (row.status !== "approval_required" || row.requestStatus !== "pending" || !row.externalRef) return;
    const observation = await observe({ organizationId: row.organizationId, chainFamily: row.chainFamily, network: row.network, externalRef: row.externalRef, treasuryConfiguration: row.treasuryConfiguration ?? {} });
    if (!observation) throw new Deferred("Proposal account not yet visible", 3);
    const wallets = await this.sql<{ address: string; principalId: string }[]>`
      select address, principal_id::text as "principalId" from human_wallets where organization_id = ${row.organizationId} and chain_family = ${row.chainFamily}
    `;
    const principalFor = (address: string) => wallets.find((wallet) => (row.chainFamily === "evm" ? wallet.address.toLowerCase() === address.toLowerCase() : wallet.address === address))?.principalId ?? null;
    await this.sql.begin(async (tx) => {
      const locked = await tx<{ status: string; version: number }[]>`select status, version from intents where id = ${intentId} for update`;
      if (locked[0]?.status !== "approval_required") return;
      for (const [decision, addresses] of [["approved", observation.approved], ["rejected", observation.rejected]] as const) {
        for (const address of addresses) {
          await tx`
            insert into approvals (organization_id, intent_id, approver_principal_id, decision, signer_address, signed_payload)
            values (${row.organizationId}, ${intentId}, ${principalFor(address)}, ${decision}, ${address}, 'on-chain vote')
            on conflict (intent_id, signer_address) where signer_address is not null do nothing
          `;
        }
      }
      if (observation.status === "approved") {
        await tx`update approval_requests set status = 'approved', updated_at = now() where intent_id = ${intentId}`;
        await this.transition(tx, intentId, row.organizationId, locked[0].version, "approval_required", "approved", "intent.approved", { onChain: true, approved: observation.approved });
        await tx`
          insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
          values (${row.organizationId}, 'transaction.execute', 'intent', ${intentId}, ${tx.json({ intentId })})
        `;
        return;
      }
      if (observation.status === "rejected" || observation.status === "cancelled") {
        await tx`update approval_requests set status = 'rejected', updated_at = now() where intent_id = ${intentId}`;
        await tx`update intents set failure_reason = ${`Proposal ${observation.status} on chain`} where id = ${intentId}`;
        await this.transition(tx, intentId, row.organizationId, locked[0].version, "approval_required", "rejected", "intent.rejected", { onChain: true, rejected: observation.rejected });
        return;
      }
      if (new Date(row.expiresAt) > new Date()) {
        await tx`
          insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload, available_at)
          values (${row.organizationId}, 'proposal.observe', 'intent', ${intentId}, ${tx.json({ intentId })}, now() + interval '5 seconds')
        `;
      }
    });
  }

  async expireApproval(intentId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; status: string; version: number; requestStatus: string; expiresAt: string }[]>`
        select i.organization_id::text as "organizationId", i.status, i.version,
          ar.status as "requestStatus", ar.expires_at::text as "expiresAt"
        from intents i join approval_requests ar on ar.intent_id = i.id
        where i.id = ${intentId} for update of i, ar
      `;
      const state = rows[0];
      if (!state || state.status !== "approval_required" || state.requestStatus !== "pending") return;
      if (new Date(state.expiresAt) > new Date()) throw new Deferred("Approval expiry job ran before expiry", Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / 1000) + 1);
      await tx`update approval_requests set status = 'expired', updated_at = now() where intent_id = ${intentId}`;
      await this.transition(tx, intentId, state.organizationId, state.version, "approval_required", "expired", "intent.expired");
    });
  }

  // Execution

  /**
   * Everything the worker needs to sign, re-checked at execution time: freezes,
   * expiry, and the policy run again against current spend. Throws
   * ExecutionRejected for anything that must fail the intent.
   */
  async getExecutionContext(intentId: string): Promise<ExecutionContext> {
    const explicit = await this.sql.unsafe<(IntentRow & {
      signerId: string | null; signerAddress: string | null; signerStatus: string | null; encryptedSecret: string | null; encryptionNonce: string | null; authTag: string | null; keyVersion: number | null;
      approvalStatus: string | null; approvalCompiledHash: string | null; externalRef: Record<string, unknown> | null;
      executionId: string | null; executionStatus: string | null; transactionHash: string | null; signedPayload: string | null; nonce: string | null; validUntil: string | null;
    })[]>(`
      select base.*, sg."signerId", sg."signerAddress", sg."signerStatus", sg."encryptedSecret", sg."encryptionNonce", sg."authTag", sg."keyVersion",
        ar.status as "approvalStatus", ar.compiled_hash as "approvalCompiledHash", ar.external_ref as "externalRef",
        e.id::text as "executionId", e.status as "executionStatus", e.transaction_hash as "transactionHash", e.signed_payload as "signedPayload", e.nonce, e.valid_until as "validUntil"
      from (${intentJoin} where i.id = $1) base
      left join lateral (
        select s.id::text as "signerId", s.address as "signerAddress", s.status as "signerStatus", s.encrypted_secret as "encryptedSecret", s.encryption_nonce as "encryptionNonce", s.auth_tag as "authTag", s.key_version as "keyVersion"
        from signers s where s.organization_id = base."organizationId"::uuid and s.custody = 'encrypted_software' and s.chain_family = base."chainFamily"
          and ((base.governance = 'direct' and lower(s.address) = lower(base."from")) or (base.governance <> 'direct' and s.id = base."executorSignerId"::uuid))
        order by s.created_at desc limit 1
      ) sg on true
      left join approval_requests ar on ar.intent_id = base."intentId"::uuid
      left join executions e on e.intent_id = base."intentId"::uuid
    `, [intentId]);
    const row = explicit[0];
    if (!row) throw new Error("Intent not found");
    if (!["approved", "executing"].includes(row.status)) throw new Error(`Intent is ${row.status}, not approved`);
    if (row.approvalStatus !== "approved" || !row.approvalCompiledHash) throw new ExecutionRejected("No approved approval request");
    if (row.status === "executing" && !row.executionId) throw new ExecutionRejected("Intent is executing without an execution record");
    const gate = this.gate(row);
    if (gate) throw new ExecutionRejected(gate);
    if (!row.signerId || !row.signerAddress || !row.encryptedSecret || !row.encryptionNonce || !row.authTag || row.keyVersion === null) throw new ExecutionRejected(row.governance === "direct" ? "No encrypted signer matches the treasury address" : "Treasury has no executor signer");
    if (row.signerStatus !== "active") throw new ExecutionRejected(`Signer is ${row.signerStatus}`);
    if (row.status === "approved" && new Date(row.expiresAt) <= new Date()) throw new ExecutionRejected("Intent expired before execution");
    if (row.status === "approved") {
      // Policy runs again immediately before signing, against spend committed since approval.
      const policyResult = await this.loadPolicy(this.sql, row.organizationId, row.requesterId, row.treasuryId);
      if (policyResult) {
        const spent = await this.spentToday(this.sql, row.organizationId, row.requesterId, row.assetId, intentId);
        const decision = evaluatePaymentIntent(this.intentOf(row), policyResult.policy, { spentTodayBaseUnits: spent, now: new Date() });
        if (decision.outcome === "rejected") throw new ExecutionRejected(`Policy rejected at execution: ${decision.reasons.join("; ")}`);
      }
    }
    const ownerSignatures = row.governance === "safe"
      ? await this.sql<{ signerAddress: string; signedPayload: string }[]>`select signer_address as "signerAddress", signed_payload as "signedPayload" from approvals where intent_id = ${intentId} and decision = 'approved' and signer_address is not null and signed_payload is not null`
      : [];
    return {
      intentId, organizationId: row.organizationId, treasuryId: row.treasuryId, network: row.network, chainFamily: row.chainFamily, governance: row.governance,
      from: row.from, to: row.destination, assetId: row.assetId, asset: { id: row.assetId, kind: row.assetKind!, address: row.assetAddress, decimals: row.assetDecimals! },
      amountBaseUnits: row.amountBaseUnits, intentStatus: row.status, intentVersion: row.version,
      signerId: row.signerId, signerAddress: row.signerAddress, encryptedSecret: row.encryptedSecret, encryptionNonce: row.encryptionNonce, authTag: row.authTag, keyVersion: row.keyVersion,
      approvalCompiledHash: row.approvalCompiledHash, externalRef: row.externalRef, treasuryConfiguration: row.observedConfiguration ?? {}, ownerSignatures,
      kind: row.kind, x402: (row.policyDecision as { x402?: Record<string, unknown> } | null)?.x402 ?? null,
      execution: row.executionId ? { id: row.executionId, status: row.executionStatus!, transactionHash: row.transactionHash, signedPayload: row.signedPayload, nonce: row.nonce, validUntil: row.validUntil } : null
    };
  }

  async recordSimulation(context: ExecutionContext, feeBaseUnits: bigint, compiledPayload: Record<string, unknown>, compiledHash: string): Promise<string> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into executions (organization_id, intent_id, signer_id, network, compiled_payload, compiled_hash, simulation, status)
        values (${context.organizationId}, ${context.intentId}, ${context.signerId}, ${context.network},
          ${tx.json(compiledPayload as JSONValue)}, ${compiledHash}, ${tx.json({ ok: true, feeBaseUnits: feeBaseUnits.toString() })}, 'simulated')
        on conflict (intent_id) do update set simulation = excluded.simulation, updated_at = now()
        returning id::text
      `;
      const moved = await tx`update intents set status = 'executing', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'approved'`;
      if (moved.count > 0) await this.event(tx, context.organizationId, context.intentId, "intent.executing", { feeBaseUnits: feeBaseUnits.toString() });
      if (!rows[0]) throw new Error("Execution insert returned no row");
      return rows[0].id;
    });
  }

  /** Persists the signed bytes and their hash before anything reaches the network. */
  async markSigned(executionId: string, signed: { hash: string; raw: string; nonce: string; validUntil: string }): Promise<void> {
    await this.sql`
      update executions set status = 'signed', transaction_hash = ${signed.hash}, signed_payload = ${signed.raw}, nonce = ${signed.nonce}, valid_until = ${signed.validUntil}, updated_at = now()
      where id = ${executionId} and status = 'simulated'
    `;
  }

  /**
   * The transaction is on its way. For x402 the settlement is learned from the
   * seller's response, so the hash, payee, and paid amount arrive here rather
   * than at signing time.
   */
  async markSubmitted(intentId: string, executionId: string, settlement?: { transactionHash: string; payTo: string; amountBaseUnits: string; observed?: Record<string, unknown> }): Promise<void> {
    await this.sql.begin(async (tx) => {
      const executions = await tx<{ transactionHash: string; network: string }[]>`
        update executions set status = 'submitted', broadcast_at = coalesce(broadcast_at, now()), updated_at = now(),
          transaction_hash = coalesce(${settlement?.transactionHash ?? null}, transaction_hash),
          compiled_payload = compiled_payload || ${tx.json((settlement ? { payTo: settlement.payTo, settledAmountBaseUnits: settlement.amountBaseUnits, settlement: settlement.observed ?? {} } : {}) as never)}
        where id = ${executionId} and status in ('signed', 'submitted') returning transaction_hash as "transactionHash", network
      `;
      const execution = executions[0];
      if (!execution?.transactionHash) throw new Error("Execution has no signed transaction");
      const rows = await tx<{ organizationId: string; treasuryId: string; assetId: string; amountBaseUnits: string }[]>`
        update intents set status = 'submitted', version = version + 1, updated_at = now()
        where id = ${intentId} and status = 'executing'
        returning organization_id::text as "organizationId", treasury_account_id::text as "treasuryId", asset_id as "assetId", amount_base_units::text as "amountBaseUnits"
      `;
      const intent = rows[0];
      if (!intent) throw new Error("Intent was not executing during submission");
      const amount = settlement?.amountBaseUnits ?? intent.amountBaseUnits;
      await this.event(tx, intent.organizationId, intentId, "intent.submitted", { transactionHash: execution.transactionHash, ...(settlement ? { payTo: settlement.payTo, amountBaseUnits: amount } : {}) });
      await this.postLedger(tx, intent.organizationId, intentId, `${execution.network}:${execution.transactionHash}:submitted`, "Outbound transfer submitted", [
        { treasuryId: intent.treasuryId, code: "pending_outbound", assetId: intent.assetId, direction: "debit", amount },
        { treasuryId: intent.treasuryId, code: "treasury_asset", assetId: intent.assetId, direction: "credit", amount }
      ]);
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${intent.organizationId}, 'transaction.confirm', 'intent', ${intentId}, ${tx.json({ intentId })})
      `;
    });
  }

  /** Terminal failure. Reverses the pending booking if the transfer had been submitted; books the fee if one was paid. */
  async markFailed(intentId: string, reason: string, fee?: { feeBaseUnits: bigint; network: string; transactionHash: string }): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; treasuryId: string; assetId: string; amountBaseUnits: string; status: string; version: number; chainFamily: "evm" | "svm"; network: string }[]>`
        select i.organization_id::text as "organizationId", i.treasury_account_id::text as "treasuryId", i.asset_id as "assetId", i.amount_base_units::text as "amountBaseUnits",
          i.status, i.version, t.chain_family as "chainFamily", i.network
        from intents i join treasury_accounts t on t.id = i.treasury_account_id where i.id = ${intentId} for update of i
      `;
      const intent = rows[0];
      if (!intent) throw new Error("Intent not found");
      if (["failed", "reconciled", "finalized", "rejected", "expired"].includes(intent.status)) return;
      const executions = await tx<{ status: string; transactionHash: string | null; network: string }[]>`
        update executions set status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now() where intent_id = ${intentId} returning status, transaction_hash as "transactionHash", network
      `;
      await tx`update intents set status = 'failed', failure_reason = ${reason.slice(0, 2000)}, version = version + 1, updated_at = now() where id = ${intentId}`;
      await this.event(tx, intent.organizationId, intentId, "intent.failed", { from: intent.status, reason });
      const execution = executions[0];
      if (intent.status === "submitted" && execution?.transactionHash) {
        await this.postLedger(tx, intent.organizationId, intentId, `${execution.network}:${execution.transactionHash}:reversal`, `Submitted transfer failed: ${reason.slice(0, 120)}`, [
          { treasuryId: intent.treasuryId, code: "treasury_asset", assetId: intent.assetId, direction: "debit", amount: intent.amountBaseUnits },
          { treasuryId: intent.treasuryId, code: "pending_outbound", assetId: intent.assetId, direction: "credit", amount: intent.amountBaseUnits }
        ]);
      }
      if (fee && fee.feeBaseUnits > 0n) {
        const nativeAsset = `${fee.network}/${nativeAssetIds[intent.chainFamily]}`;
        await this.postLedger(tx, intent.organizationId, intentId, `${fee.network}:${fee.transactionHash}:fee`, "Network fee on failed transaction", [
          { treasuryId: intent.treasuryId, code: "fee_expense", assetId: nativeAsset, direction: "debit", amount: fee.feeBaseUnits.toString() },
          { treasuryId: intent.treasuryId, code: "treasury_asset", assetId: nativeAsset, direction: "credit", amount: fee.feeBaseUnits.toString() }
        ]);
      }
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${intent.organizationId}, null, 'intent.failed', 'intent', ${intentId}, encode(digest(${reason}, 'sha256'), 'hex'), ${tx.json({ reason, previousStatus: intent.status })})
      `;
    });
  }

  async getConfirmationContext(intentId: string): Promise<ConfirmationContext> {
    const rows = await this.sql<ConfirmationContext[]>`
      select i.id::text as "intentId", i.organization_id::text as "organizationId",
        i.treasury_account_id::text as "treasuryId", i.network, t.chain_family as "chainFamily",
        coalesce(e.compiled_payload->>'payTo', i.destination) as "to",
        i.asset_id as "assetId", jsonb_build_object('id', a.id, 'kind', a.kind, 'address', a.address, 'decimals', a.decimals) as asset,
        coalesce(e.compiled_payload->>'settledAmountBaseUnits', i.amount_base_units::text) as "amountBaseUnits",
        e.id::text as "executionId", e.transaction_hash as "transactionHash"
      from intents i join treasury_accounts t on t.id = i.treasury_account_id
      join executions e on e.intent_id = i.id
      join assets a on a.id = i.asset_id
      where i.id = ${intentId} and i.status = 'submitted' and e.status = 'submitted'
    `;
    if (!rows[0]) throw new Error("Submitted execution not found");
    return rows[0];
  }

  /**
   * Finality reached. Settles the pending booking, books the fee, and marks the
   * intent reconciled only when the chain shows the destination received the
   * intended amount; otherwise it stays `finalized` with a recorded break.
   */
  async markFinalized(context: ConfirmationContext, receipt: { blockHeight: bigint; feeBaseUnits: bigint; confirmations: number; destinationDeltaBaseUnits?: bigint }): Promise<"reconciled" | "finalized"> {
    return this.sql.begin(async (tx) => {
      const delta = receipt.destinationDeltaBaseUnits;
      const reconciled = delta !== undefined && delta === BigInt(context.amountBaseUnits);
      const observed = { destinationDeltaBaseUnits: delta?.toString() ?? null, expectedBaseUnits: context.amountBaseUnits, reconciliation: reconciled ? "matched" : delta === undefined ? "unverifiable" : "break" };
      await tx`
        update executions set status = 'finalized', block_cursor = ${receipt.blockHeight.toString()},
          fee_base_units = ${receipt.feeBaseUnits.toString()}, confirmations = ${receipt.confirmations}, observed = ${tx.json(observed)}, updated_at = now()
        where id = ${context.executionId} and status = 'submitted'
      `;
      const moved = await tx`update intents set status = 'finalized', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'submitted'`;
      if (moved.count === 0) return reconciled ? "reconciled" : "finalized";
      await this.event(tx, context.organizationId, context.intentId, "intent.finalized", { blockHeight: receipt.blockHeight.toString(), confirmations: receipt.confirmations, feeBaseUnits: receipt.feeBaseUnits.toString() });
      const reference = `${context.network}:${context.transactionHash}`;
      await this.postLedger(tx, context.organizationId, context.intentId, `${reference}:finalized`, "Outbound transfer finalized", [
        { treasuryId: context.treasuryId, code: "settled_expense", assetId: context.assetId, direction: "debit", amount: context.amountBaseUnits },
        { treasuryId: context.treasuryId, code: "pending_outbound", assetId: context.assetId, direction: "credit", amount: context.amountBaseUnits }
      ]);
      if (receipt.feeBaseUnits > 0n) {
        const nativeAsset = `${context.network}/${nativeAssetIds[context.chainFamily]}`;
        await this.postLedger(tx, context.organizationId, context.intentId, `${reference}:fee`, "Network fee", [
          { treasuryId: context.treasuryId, code: "fee_expense", assetId: nativeAsset, direction: "debit", amount: receipt.feeBaseUnits.toString() },
          { treasuryId: context.treasuryId, code: "treasury_asset", assetId: nativeAsset, direction: "credit", amount: receipt.feeBaseUnits.toString() }
        ]);
      }
      if (reconciled) {
        await tx`update intents set status = 'reconciled', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'finalized'`;
        await this.event(tx, context.organizationId, context.intentId, "intent.reconciled", observed);
        return "reconciled";
      }
      await this.event(tx, context.organizationId, context.intentId, "intent.reconciliation_break", observed);
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${context.organizationId}, null, 'reconciliation.break', 'intent', ${context.intentId}, encode(digest(${JSON.stringify(observed)}, 'sha256'), 'hex'), ${tx.json(observed)})
      `;
      return "finalized";
    });
  }

  // Ledger helpers

  private async account(tx: TransactionSql, organizationId: string, treasuryId: string, code: string, assetId: string): Promise<string> {
    const names: Record<string, string> = { treasury_asset: "Treasury asset", pending_outbound: "Pending outbound", settled_expense: "Settled expense", fee_expense: "Network fees" };
    const rows = await tx<{ id: string }[]>`
      insert into ledger_accounts (organization_id, treasury_account_id, code, name, asset_id)
      values (${organizationId}, ${treasuryId}, ${code}, ${names[code] ?? code}, ${assetId})
      on conflict (organization_id, coalesce(treasury_account_id, '00000000-0000-0000-0000-000000000000'::uuid), code, asset_id) do update set name = excluded.name
      returning id::text
    `;
    if (!rows[0]) throw new Error("Ledger account upsert failed");
    return rows[0].id;
  }

  /** Posts a balanced set of entries once per external reference. */
  private async postLedger(tx: TransactionSql, organizationId: string, intentId: string, reference: string, description: string, entries: { treasuryId: string; code: string; assetId: string; direction: "debit" | "credit"; amount: string }[]): Promise<boolean> {
    const perAsset = new Map<string, bigint>();
    for (const entry of entries) perAsset.set(entry.assetId, (perAsset.get(entry.assetId) ?? 0n) + (entry.direction === "debit" ? 1n : -1n) * BigInt(entry.amount));
    for (const [assetId, net] of perAsset) if (net !== 0n) throw new Error(`Unbalanced ledger posting for ${assetId}`);
    const rows = await tx<{ id: string }[]>`
      insert into ledger_transactions (organization_id, intent_id, external_reference, description, effective_at)
      values (${organizationId}, ${intentId}, ${reference}, ${description}, now())
      on conflict (organization_id, external_reference) do nothing returning id::text
    `;
    const transactionId = rows[0]?.id;
    if (!transactionId) return false;
    for (const entry of entries) {
      const accountId = await this.account(tx, organizationId, entry.treasuryId, entry.code, entry.assetId);
      await tx`insert into ledger_entries (transaction_id, account_id, direction, amount_base_units) values (${transactionId}, ${accountId}, ${entry.direction}, ${entry.amount})`;
    }
    return true;
  }

  private async event(tx: TransactionSql, organizationId: string, intentId: string, eventType: string, data: Record<string, unknown>): Promise<void> {
    const sequences = await tx<{ sequence: number }[]>`select coalesce(max(sequence), 0) + 1 as sequence from intent_events where intent_id = ${intentId}`;
    await tx`
      insert into intent_events (organization_id, intent_id, sequence, event_type, data)
      values (${organizationId}, ${intentId}, ${sequences[0]?.sequence ?? 1}, ${eventType}, ${tx.json(data as never)})
    `;
  }

  private async transition(tx: TransactionSql, intentId: string, organizationId: string, version: number, from: string, to: string, eventType: string, data: Record<string, unknown> = {}) {
    const updated = await tx<{ version: number }[]>`
      update intents set status = ${to}, version = version + 1, updated_at = now()
      where id = ${intentId} and status = ${from} and version = ${version}
      returning version
    `;
    if (!updated[0]) throw new Error(`Concurrent intent transition from ${from}`);
    await this.event(tx, organizationId, intentId, eventType, { ...data, from, to, version: updated[0].version });
  }

  async close(): Promise<void> { await this.sql.end(); }
}

export function createPostgresJobQueue(databaseUrl: string): PostgresJobQueue {
  return new PostgresJobQueue(postgres(databaseUrl, { max: 5, idle_timeout: 20 }));
}
