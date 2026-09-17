import postgres, { type JSONValue, type Sql, type TransactionSql } from "postgres";

export interface JobRecord {
  id: string;
  organizationId: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
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
  amountBaseUnits: string;
  intentStatus: string;
  signerId: string;
  signerStatus: string;
  encryptedSecret: string;
  encryptionNonce: string;
  authTag: string;
  keyVersion: number;
  approvalCompiledHash: string;
}

export interface ConfirmationContext {
  intentId: string;
  organizationId: string;
  treasuryId: string;
  network: string;
  chainFamily: "evm" | "svm";
  assetId: string;
  amountBaseUnits: string;
  executionId: string;
  transactionHash: string;
}

export class PostgresJobQueue {
  constructor(private readonly sql: Sql) {}

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

  async claim(workerId: string, leaseSeconds = 30): Promise<JobRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<JobRecord[]>`
        with candidate as (
          select id from jobs
          where status in ('queued', 'retry') and run_at <= now()
            and (leased_until is null or leased_until < now())
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

  async evaluateIntent(intentId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ organizationId: string; status: string; version: number; expiresAt: string; compiledHash: string; simulationHash: string }[]>`
        select organization_id::text as "organizationId", status, version, expires_at::text as "expiresAt",
          encode(digest(concat_ws('|', id::text, network, asset_id, amount_base_units::text, destination, kind), 'sha256'), 'hex') as "compiledHash",
          encode(digest(concat_ws('|', 'preflight-v1', id::text, network, amount_base_units::text, destination), 'sha256'), 'hex') as "simulationHash"
        from intents where id = ${intentId} for update
      `;
      const intent = rows[0];
      if (!intent) throw new Error("Intent not found");
      if (intent.status !== "received") return;
      if (new Date(intent.expiresAt) <= new Date()) {
        await this.transition(tx, intentId, intent.organizationId, intent.version, "received", "expired", "intent.expired");
        return;
      }
      await this.transition(tx, intentId, intent.organizationId, intent.version, "received", "approval_required", "intent.approval_required");
      await tx`
        insert into approval_requests (organization_id, intent_id, required_approvals, compiled_hash, simulation_hash, expires_at)
        values (${intent.organizationId}, ${intentId}, 1, ${intent.compiledHash}, ${intent.simulationHash}, ${intent.expiresAt})
        on conflict (intent_id) do nothing
      `;
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload, available_at)
        values (${intent.organizationId}, 'approval.expire', 'intent', ${intentId}, ${tx.json({ intentId })}, ${intent.expiresAt})
      `;
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
      if (new Date(state.expiresAt) > new Date()) throw new Error("Approval expiry job ran before expiry");
      await tx`update approval_requests set status = 'expired', updated_at = now() where intent_id = ${intentId}`;
      await this.transition(tx, intentId, state.organizationId, state.version, "approval_required", "expired", "intent.expired");
    });
  }

  async getExecutionContext(intentId: string): Promise<ExecutionContext> {
    const rows = await this.sql<ExecutionContext[]>`
      select i.id::text as "intentId", i.organization_id::text as "organizationId",
        i.treasury_account_id::text as "treasuryId", i.network, t.chain_family as "chainFamily",
        t.governance, t.address as "from", i.destination as "to", i.asset_id as "assetId",
        i.amount_base_units::text as "amountBaseUnits", i.status as "intentStatus",
        s.id::text as "signerId", s.status as "signerStatus", s.encrypted_secret as "encryptedSecret",
        s.encryption_nonce as "encryptionNonce", s.auth_tag as "authTag", s.key_version as "keyVersion",
        ar.compiled_hash as "approvalCompiledHash"
      from intents i
      join treasury_accounts t on t.id = i.treasury_account_id
      join signers s on s.organization_id = i.organization_id and s.chain_family = t.chain_family
        and lower(s.address) = lower(t.address)
      join approval_requests ar on ar.intent_id = i.id and ar.status = 'approved'
      where i.id = ${intentId}
      order by s.created_at desc limit 1
    `;
    const context = rows[0];
    if (!context) throw new Error("Execution context or matching signer not found");
    if (context.intentStatus !== "approved") throw new Error(`Intent is ${context.intentStatus}, not approved`);
    if (context.signerStatus !== "active") throw new Error("Signer is not active");
    if (context.governance !== "direct") throw new Error(`Governance ${context.governance} requires its dedicated adapter`);
    return context;
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
      await tx`update intents set status = 'executing', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'approved'`;
      if (!rows[0]) throw new Error("Execution insert returned no row");
      return rows[0].id;
    });
  }

  async markSubmitted(intentId: string, executionId: string, transactionHash: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`update executions set status = 'submitted', transaction_hash = ${transactionHash}, updated_at = now() where id = ${executionId}`;
      const rows = await tx<{ organizationId: string }[]>`
        update intents set status = 'submitted', version = version + 1, updated_at = now()
        where id = ${intentId} and status = 'executing' returning organization_id::text as "organizationId"
      `;
      if (!rows[0]) throw new Error("Intent was not executing during submission");
      await tx`
        insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload)
        values (${rows[0].organizationId}, 'transaction.confirm', 'intent', ${intentId}, ${tx.json({ intentId })})
      `;
    });
  }

  async getConfirmationContext(intentId: string): Promise<ConfirmationContext> {
    const rows = await this.sql<ConfirmationContext[]>`
      select i.id::text as "intentId", i.organization_id::text as "organizationId",
        i.treasury_account_id::text as "treasuryId", i.network, t.chain_family as "chainFamily",
        i.asset_id as "assetId", i.amount_base_units::text as "amountBaseUnits",
        e.id::text as "executionId", e.transaction_hash as "transactionHash"
      from intents i join treasury_accounts t on t.id = i.treasury_account_id
      join executions e on e.intent_id = i.id
      where i.id = ${intentId} and i.status = 'submitted' and e.status = 'submitted'
    `;
    if (!rows[0]) throw new Error("Submitted execution not found");
    return rows[0];
  }

  async markFinalized(context: ConfirmationContext, receipt: { blockHeight: bigint; feeBaseUnits: bigint }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        update executions set status = 'finalized', block_cursor = ${receipt.blockHeight.toString()},
          fee_base_units = ${receipt.feeBaseUnits.toString()}, updated_at = now()
        where id = ${context.executionId} and status = 'submitted'
      `;
      await tx`update intents set status = 'finalized', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'submitted'`;
      const treasuryAccounts = await tx<{ id: string }[]>`
        insert into ledger_accounts (organization_id, treasury_account_id, code, name, asset_id)
        values (${context.organizationId}, ${context.treasuryId}, 'treasury_asset', 'Treasury asset', ${context.assetId})
        on conflict (organization_id, code, asset_id) do update set name = excluded.name returning id::text
      `;
      const expenseAccounts = await tx<{ id: string }[]>`
        insert into ledger_accounts (organization_id, code, name, asset_id)
        values (${context.organizationId}, 'settled_expense', 'Settled expense', ${context.assetId})
        on conflict (organization_id, code, asset_id) do update set name = excluded.name returning id::text
      `;
      const ledgerTransactions = await tx<{ id: string }[]>`
        insert into ledger_transactions (organization_id, intent_id, external_reference, description, effective_at)
        values (${context.organizationId}, ${context.intentId}, ${`${context.network}:${context.transactionHash}`}, 'Finalized outbound transfer', now())
        on conflict (organization_id, external_reference) do update set description = excluded.description returning id::text
      `;
      const transactionId = ledgerTransactions[0]?.id;
      const treasuryAccountId = treasuryAccounts[0]?.id;
      const expenseAccountId = expenseAccounts[0]?.id;
      if (!transactionId || !treasuryAccountId || !expenseAccountId) throw new Error("Ledger account creation failed");
      const existing = await tx<{ count: number }[]>`select count(*)::int as count from ledger_entries where transaction_id = ${transactionId}`;
      if ((existing[0]?.count ?? 0) === 0) {
        await tx`
          insert into ledger_entries (transaction_id, account_id, direction, amount_base_units) values
            (${transactionId}, ${expenseAccountId}, 'debit', ${context.amountBaseUnits}),
            (${transactionId}, ${treasuryAccountId}, 'credit', ${context.amountBaseUnits})
        `;
      }
      await tx`update intents set status = 'reconciled', version = version + 1, updated_at = now() where id = ${context.intentId} and status = 'finalized'`;
    });
  }

  private async transition(tx: TransactionSql, intentId: string, organizationId: string, version: number, from: string, to: string, eventType: string) {
    const updated = await tx<{ version: number }[]>`
      update intents set status = ${to}, version = version + 1, updated_at = now()
      where id = ${intentId} and status = ${from} and version = ${version}
      returning version
    `;
    if (!updated[0]) throw new Error(`Concurrent intent transition from ${from}`);
    const sequences = await tx<{ sequence: number }[]>`
      select coalesce(max(sequence), 0) + 1 as sequence from intent_events where intent_id = ${intentId}
    `;
    const sequence = sequences[0]?.sequence ?? 1;
    await tx`
      insert into intent_events (organization_id, intent_id, sequence, event_type, data)
      values (${organizationId}, ${intentId}, ${sequence}, ${eventType}, ${tx.json({ from, to, version: updated[0].version })})
    `;
  }

  async close(): Promise<void> { await this.sql.end(); }
}

export function createPostgresJobQueue(databaseUrl: string): PostgresJobQueue {
  return new PostgresJobQueue(postgres(databaseUrl, { max: 5, idle_timeout: 20 }));
}
