import { randomBytes, randomInt } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import bs58 from "bs58";
import { ledgerNet, postLedger } from "./ledger.js";

type Db = Sql | TransactionSql;

// Records

export interface BeneficiaryRecord {
  id: string;
  organizationId: string;
  name: string;
  chainFamily: "evm" | "svm";
  network: string;
  address: string;
  email: string | null;
  notes: string | null;
  status: "pending" | "active" | "archived";
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ScheduleRecord {
  id: string;
  organizationId: string;
  treasuryAccountId: string;
  beneficiaryId: string;
  requesterPrincipalId: string;
  assetId: string;
  amountBaseUnits: string;
  purpose: string;
  intervalUnit: "day" | "week" | "month";
  intervalCount: number;
  startAt: string;
  endAt: string | null;
  maxOccurrences: number | null;
  nextRunAt: string;
  occurrencesCreated: number;
  status: "active" | "paused" | "completed" | "cancelled";
  createdAt: string;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmountBaseUnits: string;
}

export interface InvoiceRecord {
  id: string;
  organizationId: string;
  number: string;
  treasuryAccountId: string;
  assetId: string;
  network: string;
  customerName: string;
  customerEmail: string | null;
  memo: string | null;
  lineItems: InvoiceLineItem[];
  subtotalBaseUnits: string;
  amountDueBaseUnits: string;
  amountPaidBaseUnits: string;
  reference: string | null;
  publicToken: string;
  status: "draft" | "open" | "paid" | "void";
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InflowRecord {
  id: string;
  treasuryAccountId: string;
  network: string;
  assetId: string;
  transactionHash: string;
  eventKey: string;
  amountBaseUnits: string;
  fromAddress: string | null;
  invoiceId: string | null;
  method: "transfer" | "x402";
  observedAt: string;
}

export interface ReconciliationRecord {
  treasuryAccountId: string;
  assetId: string;
  chainBalanceBaseUnits: string;
  ledgerBalanceBaseUnits: string;
  pendingOutboundBaseUnits: string;
  differenceBaseUnits: string;
  status: "matched" | "break" | "in_flight";
  note: string | null;
  createdAt: string;
}

export interface StatementLine {
  effectiveAt: string;
  description: string;
  reference: string | null;
  intentId: string | null;
  category: "inflow" | "outflow" | "reversal" | "fee" | "opening_balance" | "other";
  amountBaseUnits: string;
  runningBalanceBaseUnits: string;
}

export interface StatementRecord {
  treasuryAccountId: string;
  assetId: string;
  symbol: string;
  decimals: number;
  from: string;
  to: string;
  openingBalanceBaseUnits: string;
  inflowsBaseUnits: string;
  outflowsBaseUnits: string;
  feesBaseUnits: string;
  closingBalanceBaseUnits: string;
  lines: StatementLine[];
  latestReconciliation: ReconciliationRecord | null;
}

export class OperationsError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "OperationsError"; }
}

const beneficiaryColumns = `id::text, organization_id::text as "organizationId", name, chain_family as "chainFamily", network, address, email, notes, status,
  created_by::text as "createdBy", approved_by::text as "approvedBy", to_char(approved_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "approvedAt", to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;
const scheduleColumns = `id::text, organization_id::text as "organizationId", treasury_account_id::text as "treasuryAccountId", beneficiary_id::text as "beneficiaryId",
  requester_principal_id::text as "requesterPrincipalId", asset_id as "assetId", amount_base_units::text as "amountBaseUnits", purpose,
  interval_unit as "intervalUnit", interval_count as "intervalCount", to_char(start_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startAt", to_char(end_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endAt", max_occurrences as "maxOccurrences",
  to_char(next_run_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "nextRunAt", occurrences_created as "occurrencesCreated", status, to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;
const invoiceColumnsFor = (t: string) => `${t}.id::text, ${t}.organization_id::text as "organizationId", ${t}.number, ${t}.treasury_account_id::text as "treasuryAccountId", ${t}.asset_id as "assetId", ${t}.network,
  ${t}.customer_name as "customerName", ${t}.customer_email as "customerEmail", ${t}.memo, ${t}.line_items as "lineItems", ${t}.subtotal_base_units::text as "subtotalBaseUnits",
  ${t}.amount_due_base_units::text as "amountDueBaseUnits", ${t}.amount_paid_base_units::text as "amountPaidBaseUnits", ${t}.reference, ${t}.public_token as "publicToken", ${t}.status,
  to_char(${t}.issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "issuedAt", to_char(${t}.due_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "dueAt", to_char(${t}.paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "paidAt", to_char(${t}.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;
const invoiceColumns = invoiceColumnsFor("invoices");
const inflowColumns = `id::text, treasury_account_id::text as "treasuryAccountId", network, asset_id as "assetId", transaction_hash as "transactionHash", event_key as "eventKey",
  amount_base_units::text as "amountBaseUnits", from_address as "fromAddress", invoice_id::text as "invoiceId", method, to_char(observed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt"`;
const reconciliationColumns = `treasury_account_id::text as "treasuryAccountId", asset_id as "assetId", chain_balance_base_units::text as "chainBalanceBaseUnits",
  ledger_balance_base_units::text as "ledgerBalanceBaseUnits", pending_outbound_base_units::text as "pendingOutboundBaseUnits", difference_base_units::text as "differenceBaseUnits",
  status, note, to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

async function audit(tx: Db, organizationId: string, actorPrincipalId: string | null, action: string, resourceType: string, resourceId: string, data: Record<string, unknown>): Promise<void> {
  await tx`
    insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
    values (${organizationId}, ${actorPrincipalId}, ${action}, ${resourceType}, ${resourceId}, encode(digest(${JSON.stringify(data)}, 'sha256'), 'hex'), ${tx.json(data as never)})
  `;
}

/**
 * Payables and receivables: beneficiaries, recurring payments, invoices, the
 * inflow record the chain indexer writes, reconciliation, and statements.
 */
export class OperationsStore {
  constructor(readonly sql: Sql) {}

  // Beneficiaries

  async createBeneficiary(organizationId: string, input: { name: string; chainFamily: "evm" | "svm"; network: string; address: string; email?: string; notes?: string }, actorPrincipalId: string): Promise<BeneficiaryRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<BeneficiaryRecord[]>(
        `insert into beneficiaries (organization_id, name, chain_family, network, address, email, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${beneficiaryColumns}`,
        [organizationId, input.name, input.chainFamily, input.network, input.address, input.email ?? null, input.notes ?? null, actorPrincipalId]
      );
      if (!rows[0]) throw new Error("Beneficiary insert returned no row");
      await audit(tx, organizationId, actorPrincipalId, "beneficiary.created", "beneficiary", rows[0].id, { name: input.name, network: input.network, address: input.address });
      return rows[0];
    });
  }

  listBeneficiaries(organizationId: string): Promise<BeneficiaryRecord[]> {
    return this.sql.unsafe<BeneficiaryRecord[]>(`select ${beneficiaryColumns} from beneficiaries where organization_id = $1 order by status = 'archived', name`, [organizationId]);
  }

  async getBeneficiary(organizationId: string, beneficiaryId: string): Promise<BeneficiaryRecord | null> {
    const rows = await this.sql.unsafe<BeneficiaryRecord[]>(`select ${beneficiaryColumns} from beneficiaries where organization_id = $1 and id = $2`, [organizationId, beneficiaryId]);
    return rows[0] ?? null;
  }

  /** The exact text an owner's wallet signs to approve a recipient. */
  static beneficiaryApprovalMessage(domain: string, beneficiary: Pick<BeneficiaryRecord, "id" | "name" | "network" | "address">): string {
    return [`${domain} beneficiary approval`, `Beneficiary: ${beneficiary.id}`, `Name: ${beneficiary.name}`, `Network: ${beneficiary.network}`, `Address: ${beneficiary.address}`].join("\n");
  }

  async approveBeneficiary(organizationId: string, beneficiaryId: string, actorPrincipalId: string, signature: string): Promise<BeneficiaryRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<BeneficiaryRecord[]>(
        `update beneficiaries set status = 'active', approved_by = $3, approval_signature = $4, approved_at = now(), updated_at = now()
         where organization_id = $1 and id = $2 and status = 'pending' returning ${beneficiaryColumns}`,
        [organizationId, beneficiaryId, actorPrincipalId, signature]
      );
      if (!rows[0]) throw new OperationsError("beneficiary_not_pending", "Beneficiary is not pending approval");
      await audit(tx, organizationId, actorPrincipalId, "beneficiary.approved", "beneficiary", beneficiaryId, { address: rows[0].address, network: rows[0].network });
      return rows[0];
    });
  }

  async archiveBeneficiary(organizationId: string, beneficiaryId: string, actorPrincipalId: string): Promise<BeneficiaryRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<BeneficiaryRecord[]>(`update beneficiaries set status = 'archived', updated_at = now() where organization_id = $1 and id = $2 returning ${beneficiaryColumns}`, [organizationId, beneficiaryId]);
      if (!rows[0]) throw new OperationsError("beneficiary_not_found", "Beneficiary not found");
      await tx`update payment_schedules set status = 'paused', updated_at = now() where organization_id = ${organizationId} and beneficiary_id = ${beneficiaryId} and status = 'active'`;
      await audit(tx, organizationId, actorPrincipalId, "beneficiary.archived", "beneficiary", beneficiaryId, {});
      return rows[0];
    });
  }

  // Recurring payments

  async createSchedule(organizationId: string, input: { treasuryAccountId: string; beneficiaryId: string; assetId: string; amountBaseUnits: string; purpose: string; intervalUnit: ScheduleRecord["intervalUnit"]; intervalCount: number; startAt: string; endAt?: string; maxOccurrences?: number }, actorPrincipalId: string): Promise<ScheduleRecord> {
    return this.sql.begin(async (tx) => {
      const checks = await tx<{ treasuryNetwork: string; beneficiaryNetwork: string; beneficiaryStatus: string; assetNetwork: string | null }[]>`
        select t.network as "treasuryNetwork", b.network as "beneficiaryNetwork", b.status as "beneficiaryStatus", a.network as "assetNetwork"
        from treasury_accounts t, beneficiaries b left join assets a on a.id = ${input.assetId}
        where t.organization_id = ${organizationId} and t.id = ${input.treasuryAccountId} and b.organization_id = ${organizationId} and b.id = ${input.beneficiaryId}
      `;
      const check = checks[0];
      if (!check) throw new OperationsError("not_found", "Treasury or beneficiary not found");
      if (check.beneficiaryStatus !== "active") throw new OperationsError("beneficiary_not_active", "Recurring payments need an approved beneficiary");
      if (check.beneficiaryNetwork !== check.treasuryNetwork) throw new OperationsError("network_mismatch", "Beneficiary and treasury are on different networks");
      if (check.assetNetwork !== check.treasuryNetwork) throw new OperationsError("asset_mismatch", "Asset is not on the treasury's network");
      const rows = await tx.unsafe<ScheduleRecord[]>(
        `insert into payment_schedules (organization_id, treasury_account_id, beneficiary_id, requester_principal_id, asset_id, amount_base_units, purpose, interval_unit, interval_count, start_at, end_at, max_occurrences, next_run_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $10) returning ${scheduleColumns}`,
        [organizationId, input.treasuryAccountId, input.beneficiaryId, actorPrincipalId, input.assetId, input.amountBaseUnits, input.purpose, input.intervalUnit, input.intervalCount, input.startAt, input.endAt ?? null, input.maxOccurrences ?? null]
      );
      if (!rows[0]) throw new Error("Schedule insert returned no row");
      await audit(tx, organizationId, actorPrincipalId, "schedule.created", "payment_schedule", rows[0].id, { ...input });
      return rows[0];
    });
  }

  listSchedules(organizationId: string): Promise<ScheduleRecord[]> {
    return this.sql.unsafe<ScheduleRecord[]>(`select ${scheduleColumns} from payment_schedules where organization_id = $1 order by created_at desc`, [organizationId]);
  }

  async setScheduleStatus(organizationId: string, scheduleId: string, status: "active" | "paused" | "cancelled", actorPrincipalId: string): Promise<ScheduleRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<ScheduleRecord[]>(
        `update payment_schedules set status = $3, updated_at = now(),
           next_run_at = case when $3 = 'active' and next_run_at < now() then now() else next_run_at end
         where organization_id = $1 and id = $2 and status in ('active', 'paused') returning ${scheduleColumns}`,
        [organizationId, scheduleId, status]
      );
      if (!rows[0]) throw new OperationsError("schedule_not_changeable", "Schedule not found or already finished");
      await audit(tx, organizationId, actorPrincipalId, `schedule.${status}`, "payment_schedule", scheduleId, {});
      return rows[0];
    });
  }

  /**
   * Creates the intent for every schedule that is due. Occurrence N is due at
   * start + N-1 intervals; missed occurrences older than one interval are
   * skipped rather than paid in a burst, and the skip is recorded.
   */
  async enqueueDueSchedules(limit = 100): Promise<number> {
    return this.sql.begin(async (tx) => {
      const due = await tx<(ScheduleRecord & { destination: string; network: string; beneficiaryStatus: string; latestDue: number })[]>`
        select s.id::text, s.organization_id::text as "organizationId", s.treasury_account_id::text as "treasuryAccountId", s.beneficiary_id::text as "beneficiaryId",
          s.requester_principal_id::text as "requesterPrincipalId", s.asset_id as "assetId", s.amount_base_units::text as "amountBaseUnits", s.purpose,
          s.interval_unit as "intervalUnit", s.interval_count as "intervalCount", to_char(s.start_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startAt", to_char(s.end_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endAt",
          s.max_occurrences as "maxOccurrences", to_char(s.next_run_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "nextRunAt", s.occurrences_created as "occurrencesCreated", s.status,
          b.address as destination, t.network, b.status as "beneficiaryStatus",
          (select count(*)::int from generate_series(0, 10000) n
            where s.start_at + ((s.interval_count * n)::text || ' ' || s.interval_unit)::interval <= now()) as "latestDue"
        from payment_schedules s join beneficiaries b on b.id = s.beneficiary_id join treasury_accounts t on t.id = s.treasury_account_id
          join organizations o on o.id = s.organization_id
        where s.status = 'active' and s.next_run_at <= now() and not o.frozen
        order by s.next_run_at
        for update of s skip locked
        limit ${limit}
      `;
      for (const schedule of due) {
        if (schedule.beneficiaryStatus !== "active") {
          await tx`update payment_schedules set status = 'paused', updated_at = now() where id = ${schedule.id}`;
          continue;
        }
        const occurrence = Math.max(schedule.occurrencesCreated + 1, schedule.latestDue);
        const skipped = occurrence - (schedule.occurrencesCreated + 1);
        const pastEnd = (schedule.maxOccurrences !== null && occurrence > schedule.maxOccurrences) || (schedule.endAt !== null && new Date(schedule.endAt) < new Date());
        if (pastEnd) {
          await tx`update payment_schedules set status = 'completed', updated_at = now() where id = ${schedule.id}`;
          continue;
        }
        const intentId = crypto.randomUUID();
        const inserted = await tx`
          insert into intents (id, organization_id, treasury_account_id, requester_principal_id, idempotency_key, kind, network, asset_id, amount_base_units, destination, purpose, status, expires_at, beneficiary_id, schedule_id, occurrence)
          values (${intentId}, ${schedule.organizationId}, ${schedule.treasuryAccountId}, ${schedule.requesterPrincipalId}, ${`schedule:${schedule.id}:${occurrence}`}, 'transfer',
            ${schedule.network}, ${schedule.assetId}, ${schedule.amountBaseUnits}, ${schedule.destination}, ${`${schedule.purpose} (payment ${occurrence})`}, 'received', now() + interval '3 days',
            ${schedule.beneficiaryId}, ${schedule.id}, ${occurrence})
          on conflict do nothing
        `;
        if (inserted.count > 0) {
          await tx`insert into intent_events (organization_id, intent_id, sequence, event_type, actor_principal_id, data) values (${schedule.organizationId}, ${intentId}, 1, 'intent.received', ${schedule.requesterPrincipalId}, ${tx.json({ status: "received", scheduleId: schedule.id, occurrence, skippedOccurrences: skipped })})`;
          await tx`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload) values (${schedule.organizationId}, 'intent.evaluate', 'intent', ${intentId}, ${tx.json({ intentId })})`;
        }
        const finished = schedule.maxOccurrences !== null && occurrence >= schedule.maxOccurrences;
        await tx`
          update payment_schedules set occurrences_created = ${occurrence}, updated_at = now(),
            next_run_at = start_at + ((interval_count * ${occurrence})::text || ' ' || interval_unit)::interval,
            status = case when ${finished} then 'completed' when end_at is not null and start_at + ((interval_count * ${occurrence})::text || ' ' || interval_unit)::interval > end_at then 'completed' else status end
          where id = ${schedule.id}
        `;
        if (skipped > 0) await audit(tx, schedule.organizationId, null, "schedule.occurrences_skipped", "payment_schedule", schedule.id, { skipped, occurrence });
      }
      return due.length;
    });
  }

  // Invoices

  async createInvoice(organizationId: string, input: { treasuryAccountId: string; assetId: string; customerName: string; customerEmail?: string; memo?: string; lineItems: InvoiceLineItem[]; dueAt?: string; issue: boolean }, actorPrincipalId: string): Promise<InvoiceRecord> {
    if (input.lineItems.length === 0) throw new OperationsError("no_line_items", "An invoice needs at least one line item");
    const subtotal = input.lineItems.reduce((sum, item) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new OperationsError("invalid_quantity", "Quantities are positive integers");
      return sum + BigInt(item.unitAmountBaseUnits) * BigInt(item.quantity);
    }, 0n);
    if (subtotal <= 0n) throw new OperationsError("invalid_amount", "Invoice total must be positive");
    return this.sql.begin(async (tx) => {
      const context = await tx<{ chainFamily: "evm" | "svm"; network: string; assetKind: string | null; assetNetwork: string | null; decimals: number | null }[]>`
        select t.chain_family as "chainFamily", t.network, a.kind as "assetKind", a.network as "assetNetwork", a.decimals
        from treasury_accounts t left join assets a on a.id = ${input.assetId}
        where t.organization_id = ${organizationId} and t.id = ${input.treasuryAccountId}
      `;
      const treasury = context[0];
      if (!treasury) throw new OperationsError("treasury_not_found", "Treasury not found");
      if (!treasury.assetKind || treasury.assetNetwork !== treasury.network) throw new OperationsError("asset_mismatch", "Asset is not registered on the treasury's network");
      let amountDue = subtotal;
      let reference: string | null = null;
      if (treasury.chainFamily === "svm") {
        // Solana Pay: a random public key the payer's wallet includes as a read-only account.
        reference = bs58.encode(randomBytes(32));
      } else {
        if (treasury.assetKind !== "erc20") throw new OperationsError("evm_native_invoice_unsupported", "EVM invoices are payable in tokens; native deposits cannot be attributed to an invoice");
        if ((treasury.decimals ?? 0) < 4) throw new OperationsError("asset_precision_too_low", "Token precision is too low for an amount identifier");
        const tagCeiling = 10 ** ((treasury.decimals ?? 6) - 2);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const candidate = subtotal + BigInt(randomInt(1, tagCeiling));
          const clash = await tx`select 1 from invoices where treasury_account_id = ${input.treasuryAccountId} and asset_id = ${input.assetId} and amount_due_base_units = ${candidate.toString()} and status in ('draft', 'open')`;
          if (clash.count === 0) { amountDue = candidate; break; }
        }
        if (amountDue === subtotal) throw new OperationsError("amount_identifier_exhausted", "Could not allocate a unique amount identifier");
      }
      const sequence = await tx<{ value: number }[]>`update organizations set invoice_sequence = invoice_sequence + 1 where id = ${organizationId} returning invoice_sequence as value`;
      const number = `INV-${String(sequence[0]!.value).padStart(5, "0")}`;
      const rows = await tx.unsafe<InvoiceRecord[]>(
        `insert into invoices (organization_id, number, treasury_account_id, asset_id, network, customer_name, customer_email, memo, line_items, subtotal_base_units, amount_due_base_units, reference, public_token, due_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13, $14, $15) returning ${invoiceColumns}`,
        [organizationId, number, input.treasuryAccountId, input.assetId, treasury.network, input.customerName, input.customerEmail ?? null, input.memo ?? null, JSON.stringify(input.lineItems), subtotal.toString(), amountDue.toString(), reference, randomBytes(24).toString("base64url"), input.dueAt ?? null, actorPrincipalId]
      );
      const invoice = rows[0];
      if (!invoice) throw new Error("Invoice insert returned no row");
      await audit(tx, organizationId, actorPrincipalId, "invoice.created", "invoice", invoice.id, { number, subtotal: subtotal.toString(), amountDue: amountDue.toString() });
      if (!input.issue) return invoice;
      return this.issueWithin(tx, organizationId, invoice.id, actorPrincipalId);
    });
  }

  private async issueWithin(tx: Db, organizationId: string, invoiceId: string, actorPrincipalId: string): Promise<InvoiceRecord> {
    const rows = await tx.unsafe<InvoiceRecord[]>(`update invoices set status = 'open', issued_at = now(), updated_at = now() where organization_id = $1 and id = $2 and status = 'draft' returning ${invoiceColumns}`, [organizationId, invoiceId]);
    const invoice = rows[0];
    if (!invoice) throw new OperationsError("invoice_not_draft", "Only draft invoices can be issued");
    await postLedger(tx, organizationId, null, `invoice:${invoice.id}:issued`, `Invoice ${invoice.number} issued to ${invoice.customerName}`, [
      { treasuryId: invoice.treasuryAccountId, code: "accounts_receivable", assetId: invoice.assetId, direction: "debit", amount: invoice.amountDueBaseUnits },
      { treasuryId: invoice.treasuryAccountId, code: "revenue", assetId: invoice.assetId, direction: "credit", amount: invoice.amountDueBaseUnits }
    ]);
    await audit(tx, organizationId, actorPrincipalId, "invoice.issued", "invoice", invoiceId, { number: invoice.number });
    return invoice;
  }

  issueInvoice(organizationId: string, invoiceId: string, actorPrincipalId: string): Promise<InvoiceRecord> {
    return this.sql.begin((tx) => this.issueWithin(tx, organizationId, invoiceId, actorPrincipalId));
  }

  async voidInvoice(organizationId: string, invoiceId: string, actorPrincipalId: string): Promise<InvoiceRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<InvoiceRecord[]>(`update invoices set status = 'void', updated_at = now() where organization_id = $1 and id = $2 and status in ('draft', 'open') and amount_paid_base_units = 0 returning ${invoiceColumns}`, [organizationId, invoiceId]);
      const invoice = rows[0];
      if (!invoice) throw new OperationsError("invoice_not_voidable", "Only unpaid draft or open invoices can be voided");
      if (invoice.issuedAt) {
        await postLedger(tx, organizationId, null, `invoice:${invoice.id}:void`, `Invoice ${invoice.number} voided`, [
          { treasuryId: invoice.treasuryAccountId, code: "revenue", assetId: invoice.assetId, direction: "debit", amount: invoice.amountDueBaseUnits },
          { treasuryId: invoice.treasuryAccountId, code: "accounts_receivable", assetId: invoice.assetId, direction: "credit", amount: invoice.amountDueBaseUnits }
        ]);
      }
      await audit(tx, organizationId, actorPrincipalId, "invoice.voided", "invoice", invoiceId, {});
      return invoice;
    });
  }

  listInvoices(organizationId: string): Promise<InvoiceRecord[]> {
    return this.sql.unsafe<InvoiceRecord[]>(`select ${invoiceColumns} from invoices where organization_id = $1 order by created_at desc`, [organizationId]);
  }

  async getInvoice(organizationId: string, invoiceId: string): Promise<{ invoice: InvoiceRecord; payments: InflowRecord[] } | null> {
    const rows = await this.sql.unsafe<InvoiceRecord[]>(`select ${invoiceColumns} from invoices where organization_id = $1 and id = $2`, [organizationId, invoiceId]);
    if (!rows[0]) return null;
    const payments = await this.sql.unsafe<InflowRecord[]>(`select ${inflowColumns} from treasury_inflows where invoice_id = $1 order by observed_at`, [invoiceId]);
    return { invoice: rows[0], payments };
  }

  /** Public view for the payer: no organisation data beyond what the invoice shows. */
  async getInvoiceByToken(publicToken: string): Promise<(InvoiceRecord & { organizationName: string; treasuryAddress: string; chainFamily: "evm" | "svm"; assetAddress: string | null; assetKind: string; symbol: string; decimals: number }) | null> {
    const rows = await this.sql.unsafe<(InvoiceRecord & { organizationName: string; treasuryAddress: string; chainFamily: "evm" | "svm"; assetAddress: string | null; assetKind: string; symbol: string; decimals: number })[]>(
      `select ${invoiceColumnsFor("i")},
         o.name as "organizationName", t.address as "treasuryAddress", t.chain_family as "chainFamily", a.address as "assetAddress", a.kind as "assetKind", a.symbol, a.decimals
       from invoices i join organizations o on o.id = i.organization_id join treasury_accounts t on t.id = i.treasury_account_id join assets a on a.id = i.asset_id
       where i.public_token = $1`,
      [publicToken]
    );
    return rows[0] ?? null;
  }

  // Inflows

  /**
   * Records one observed receipt and books it. Matching order: an explicit
   * invoice (x402 settlement), the Solana Pay reference among the transaction's
   * accounts, then an open EVM invoice whose unique amount equals the receipt.
   * Idempotent per (network, transaction, asset, event).
   */
  async recordInflow(input: { organizationId: string; treasuryAccountId: string; network: string; assetId: string; transactionHash: string; eventKey: string; amountBaseUnits: string; fromAddress: string | null; blockCursor?: string; accountKeys?: string[]; invoiceId?: string; method?: "transfer" | "x402" }): Promise<{ inflow: InflowRecord; created: boolean; invoice: InvoiceRecord | null }> {
    return this.sql.begin(async (tx) => {
      const existing = await tx.unsafe<InflowRecord[]>(`select ${inflowColumns} from treasury_inflows where network = $1 and transaction_hash = $2 and asset_id = $3 and treasury_account_id = $4 order by observed_at`, [input.network, input.transactionHash, input.assetId, input.treasuryAccountId]);
      const sameEvent = existing.find((row) => row.eventKey === input.eventKey);
      if (sameEvent) return { inflow: sameEvent, created: false, invoice: null };
      // The indexer and an x402 settlement can observe the same transfer; the first record wins and the second only allocates it.
      const other = existing.find((row) => row.method !== (input.method ?? "transfer"));
      if (other) {
        if (input.invoiceId && !other.invoiceId) {
          const invoice = await this.allocateWithin(tx, input.organizationId, other.id, input.invoiceId, null);
          return { inflow: { ...other, invoiceId: input.invoiceId }, created: false, invoice };
        }
        return { inflow: other, created: false, invoice: null };
      }
      let invoiceId = input.invoiceId ?? null;
      if (!invoiceId && input.accountKeys && input.accountKeys.length > 0) {
        const matches = await tx<{ id: string }[]>`select id::text from invoices where treasury_account_id = ${input.treasuryAccountId} and asset_id = ${input.assetId} and status = 'open' and reference = any(${input.accountKeys}) limit 1`;
        invoiceId = matches[0]?.id ?? null;
      }
      if (!invoiceId && input.network.startsWith("eip155:")) {
        const matches = await tx<{ id: string }[]>`select id::text from invoices where treasury_account_id = ${input.treasuryAccountId} and asset_id = ${input.assetId} and status = 'open' and amount_due_base_units - amount_paid_base_units = ${input.amountBaseUnits} order by issued_at limit 1`;
        invoiceId = matches[0]?.id ?? null;
      }
      const rows = await tx.unsafe<InflowRecord[]>(
        `insert into treasury_inflows (organization_id, treasury_account_id, network, asset_id, transaction_hash, event_key, amount_base_units, from_address, block_cursor, method)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (network, transaction_hash, asset_id, event_key) do nothing returning ${inflowColumns}`,
        [input.organizationId, input.treasuryAccountId, input.network, input.assetId, input.transactionHash, input.eventKey, input.amountBaseUnits, input.fromAddress, input.blockCursor ?? null, input.method ?? "transfer"]
      );
      const inflow = rows[0];
      if (!inflow) {
        const raced = await tx.unsafe<InflowRecord[]>(`select ${inflowColumns} from treasury_inflows where network = $1 and transaction_hash = $2 and asset_id = $3 and event_key = $4`, [input.network, input.transactionHash, input.assetId, input.eventKey]);
        return { inflow: raced[0]!, created: false, invoice: null };
      }
      await postLedger(tx, input.organizationId, null, `${input.network}:${input.transactionHash}:in:${input.assetId}:${input.eventKey}`, `Receipt from ${input.fromAddress ?? "unknown sender"}`, [
        { treasuryId: input.treasuryAccountId, code: "treasury_asset", assetId: input.assetId, direction: "debit", amount: input.amountBaseUnits },
        { treasuryId: input.treasuryAccountId, code: "inbound_unallocated", assetId: input.assetId, direction: "credit", amount: input.amountBaseUnits }
      ]);
      const invoice = invoiceId ? await this.allocateWithin(tx, input.organizationId, inflow.id, invoiceId, null) : null;
      return { inflow: { ...inflow, invoiceId }, created: true, invoice };
    });
  }

  /** Applies a receipt to an invoice: moves it from unallocated to receivables and marks the invoice paid when covered. */
  private async allocateWithin(tx: Db, organizationId: string, inflowId: string, invoiceId: string, actorPrincipalId: string | null): Promise<InvoiceRecord> {
    const inflows = await tx<{ id: string; amount: string; assetId: string; treasuryId: string; invoiceId: string | null }[]>`
      select id::text, amount_base_units::text as amount, asset_id as "assetId", treasury_account_id::text as "treasuryId", invoice_id::text as "invoiceId"
      from treasury_inflows where organization_id = ${organizationId} and id = ${inflowId} for update
    `;
    const inflow = inflows[0];
    if (!inflow) throw new OperationsError("inflow_not_found", "Receipt not found");
    if (inflow.invoiceId) throw new OperationsError("inflow_already_allocated", "Receipt is already applied to an invoice");
    const invoices = await tx.unsafe<InvoiceRecord[]>(`select ${invoiceColumns} from invoices where organization_id = $1 and id = $2 for update`, [organizationId, invoiceId]);
    const invoice = invoices[0];
    if (!invoice) throw new OperationsError("invoice_not_found", "Invoice not found");
    if (invoice.status !== "open") throw new OperationsError("invoice_not_open", `Invoice is ${invoice.status}`);
    if (invoice.assetId !== inflow.assetId || invoice.treasuryAccountId !== inflow.treasuryId) throw new OperationsError("invoice_mismatch", "Receipt is for a different treasury or asset");
    await tx`update treasury_inflows set invoice_id = ${invoiceId} where id = ${inflowId}`;
    await postLedger(tx, organizationId, null, `inflow:${inflowId}:allocated:${invoiceId}`, `Receipt applied to ${invoice.number}`, [
      { treasuryId: inflow.treasuryId, code: "inbound_unallocated", assetId: inflow.assetId, direction: "debit", amount: inflow.amount },
      { treasuryId: inflow.treasuryId, code: "accounts_receivable", assetId: inflow.assetId, direction: "credit", amount: inflow.amount }
    ]);
    const paid = BigInt(invoice.amountPaidBaseUnits) + BigInt(inflow.amount);
    // EVM invoices carry a sub-cent identifier; the subtotal is what the customer owes.
    const covered = paid >= BigInt(invoice.subtotalBaseUnits);
    const updated = await tx.unsafe<InvoiceRecord[]>(
      `update invoices set amount_paid_base_units = $3, status = case when $4 then 'paid' else status end, paid_at = case when $4 then now() else paid_at end, updated_at = now()
       where organization_id = $1 and id = $2 returning ${invoiceColumns}`,
      [organizationId, invoiceId, paid.toString(), covered]
    );
    await audit(tx, organizationId, actorPrincipalId, covered ? "invoice.paid" : "invoice.partially_paid", "invoice", invoiceId, { inflowId, amount: inflow.amount, paid: paid.toString() });
    return updated[0]!;
  }

  allocateInflow(organizationId: string, inflowId: string, invoiceId: string, actorPrincipalId: string): Promise<InvoiceRecord> {
    return this.sql.begin((tx) => this.allocateWithin(tx, organizationId, inflowId, invoiceId, actorPrincipalId));
  }

  listInflows(organizationId: string, filter: { treasuryAccountId?: string; unallocatedOnly?: boolean } = {}): Promise<InflowRecord[]> {
    return this.sql.unsafe<InflowRecord[]>(
      `select ${inflowColumns} from treasury_inflows where organization_id = $1 and ($2::uuid is null or treasury_account_id = $2) and (not $3 or invoice_id is null) order by observed_at desc limit 500`,
      [organizationId, filter.treasuryAccountId ?? null, filter.unallocatedOnly ?? false]
    );
  }

  // Indexer state and reconciliation

  /** Active treasuries on the given networks with the assets registered there. */
  listSyncTargets(networks: string[]): Promise<{ treasuryId: string; organizationId: string; network: string; chainFamily: "evm" | "svm"; address: string; assets: { id: string; kind: "native" | "erc20" | "spl"; address: string | null; decimals: number }[] }[]> {
    return this.sql<{ treasuryId: string; organizationId: string; network: string; chainFamily: "evm" | "svm"; address: string; assets: { id: string; kind: "native" | "erc20" | "spl"; address: string | null; decimals: number }[] }[]>`
      select t.id::text as "treasuryId", t.organization_id::text as "organizationId", t.network, t.chain_family as "chainFamily", t.address,
        coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'address', a.address, 'decimals', a.decimals)) filter (where a.id is not null), '[]'::jsonb) as assets
      from treasury_accounts t left join assets a on a.network = t.network
      where t.status = 'active' and t.network = any(${networks})
      group by t.id
    `;
  }

  async getCursor(treasuryId: string, assetId: string): Promise<string | null> {
    const rows = await this.sql<{ cursor: string }[]>`select cursor from treasury_sync_cursors where treasury_account_id = ${treasuryId} and asset_id = ${assetId}`;
    return rows[0]?.cursor ?? null;
  }

  /**
   * First sight of a treasury asset: records where reading starts and books an
   * opening balance so the ledger agrees with the chain from this point.
   */
  async openCursor(input: { organizationId: string; treasuryId: string; assetId: string; cursor: string; chainBalanceBaseUnits: bigint }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const inserted = await tx`insert into treasury_sync_cursors (treasury_account_id, asset_id, cursor) values (${input.treasuryId}, ${input.assetId}, ${input.cursor}) on conflict do nothing`;
      if (inserted.count === 0) return false;
      const ledger = await ledgerNet(tx, input.treasuryId, "treasury_asset", input.assetId);
      const pending = await ledgerNet(tx, input.treasuryId, "pending_outbound", input.assetId);
      const opening = input.chainBalanceBaseUnits - (ledger + pending);
      if (opening !== 0n) {
        const amount = (opening < 0n ? -opening : opening).toString();
        await postLedger(tx, input.organizationId, null, `opening:${input.treasuryId}:${input.assetId}`, "Opening balance observed on chain", [
          { treasuryId: input.treasuryId, code: "treasury_asset", assetId: input.assetId, direction: opening > 0n ? "debit" : "credit", amount },
          { treasuryId: input.treasuryId, code: "opening_balance", assetId: input.assetId, direction: opening > 0n ? "credit" : "debit", amount }
        ]);
      }
      return true;
    });
  }

  async advanceCursor(treasuryId: string, assetId: string, cursor: string): Promise<void> {
    await this.sql`update treasury_sync_cursors set cursor = ${cursor}, updated_at = now() where treasury_account_id = ${treasuryId} and asset_id = ${assetId}`;
  }

  /** Chain balance against the ledger. Outbound transfers in flight explain a temporary difference; anything else is a break. */
  async recordReconciliation(input: { organizationId: string; treasuryId: string; assetId: string; chainBalanceBaseUnits: bigint; note?: string }): Promise<ReconciliationRecord> {
    return this.sql.begin(async (tx) => {
      const ledger = await ledgerNet(tx, input.treasuryId, "treasury_asset", input.assetId);
      const pending = await ledgerNet(tx, input.treasuryId, "pending_outbound", input.assetId);
      const difference = input.chainBalanceBaseUnits - ledger;
      const status = difference === 0n ? "matched" : pending !== 0n ? "in_flight" : "break";
      const rows = await tx.unsafe<ReconciliationRecord[]>(
        `insert into reconciliation_runs (organization_id, treasury_account_id, asset_id, chain_balance_base_units, ledger_balance_base_units, pending_outbound_base_units, difference_base_units, status, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${reconciliationColumns}`,
        [input.organizationId, input.treasuryId, input.assetId, input.chainBalanceBaseUnits.toString(), ledger.toString(), pending.toString(), difference.toString(), status, input.note ?? null]
      );
      if (status === "break") await audit(tx, input.organizationId, null, "reconciliation.break", "treasury", input.treasuryId, { assetId: input.assetId, chain: input.chainBalanceBaseUnits.toString(), ledger: ledger.toString() });
      return rows[0]!;
    });
  }

  latestReconciliations(organizationId: string): Promise<ReconciliationRecord[]> {
    return this.sql.unsafe<ReconciliationRecord[]>(
      `select distinct on (treasury_account_id, asset_id) ${reconciliationColumns} from reconciliation_runs where organization_id = $1 order by treasury_account_id, asset_id, created_at desc`,
      [organizationId]
    );
  }

  // Statements

  async statement(organizationId: string, input: { treasuryAccountId: string; assetId: string; from: string; to: string }): Promise<StatementRecord | null> {
    const assets = await this.sql<{ symbol: string; decimals: number; treasuryOk: boolean }[]>`
      select a.symbol, a.decimals, exists(select 1 from treasury_accounts t where t.id = ${input.treasuryAccountId} and t.organization_id = ${organizationId}) as "treasuryOk"
      from assets a where a.id = ${input.assetId}
    `;
    const asset = assets[0];
    if (!asset?.treasuryOk) return null;
    const opening = await ledgerNet(this.sql, input.treasuryAccountId, "treasury_asset", input.assetId, input.from);
    const entries = await this.sql<{ effectiveAt: string; description: string; reference: string | null; intentId: string | null; direction: "debit" | "credit"; amount: string; counterCodes: string[] }[]>`
      select to_char(lt.effective_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveAt", lt.description, lt.external_reference as reference, lt.intent_id::text as "intentId", le.direction, le.amount_base_units::text as amount,
        array(select la2.code from ledger_entries le2 join ledger_accounts la2 on la2.id = le2.account_id where le2.transaction_id = lt.id and le2.id <> le.id) as "counterCodes"
      from ledger_entries le
      join ledger_accounts la on la.id = le.account_id
      join ledger_transactions lt on lt.id = le.transaction_id
      where la.treasury_account_id = ${input.treasuryAccountId} and la.code = 'treasury_asset' and la.asset_id = ${input.assetId}
        and lt.effective_at >= ${input.from} and lt.effective_at < ${input.to}
      order by lt.effective_at, le.created_at
    `;
    let running = opening;
    let inflows = 0n;
    let outflows = 0n;
    let fees = 0n;
    const lines: StatementLine[] = entries.map((entry) => {
      const signed = entry.direction === "debit" ? BigInt(entry.amount) : -BigInt(entry.amount);
      running += signed;
      const codes = entry.counterCodes;
      const category: StatementLine["category"] = codes.includes("opening_balance") ? "opening_balance"
        : codes.includes("fee_expense") ? "fee"
        : codes.includes("pending_outbound") ? (signed < 0n ? "outflow" : "reversal")
        : codes.includes("inbound_unallocated") || codes.includes("accounts_receivable") ? "inflow"
        : "other";
      if (category === "inflow" || category === "opening_balance") inflows += signed > 0n ? signed : 0n;
      if (category === "outflow") outflows += -signed;
      if (category === "reversal") outflows -= signed;
      if (category === "fee") fees += -signed;
      return { effectiveAt: entry.effectiveAt, description: entry.description, reference: entry.reference, intentId: entry.intentId, category, amountBaseUnits: signed.toString(), runningBalanceBaseUnits: running.toString() };
    });
    const latest = await this.sql.unsafe<ReconciliationRecord[]>(`select ${reconciliationColumns} from reconciliation_runs where treasury_account_id = $1 and asset_id = $2 order by created_at desc limit 1`, [input.treasuryAccountId, input.assetId]);
    return {
      treasuryAccountId: input.treasuryAccountId, assetId: input.assetId, symbol: asset.symbol, decimals: asset.decimals, from: input.from, to: input.to,
      openingBalanceBaseUnits: opening.toString(), inflowsBaseUnits: inflows.toString(), outflowsBaseUnits: outflows.toString(), feesBaseUnits: fees.toString(),
      closingBalanceBaseUnits: running.toString(), lines, latestReconciliation: latest[0] ?? null
    };
  }
}
