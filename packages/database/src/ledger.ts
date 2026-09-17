import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql;

export interface LedgerLine {
  /** Null for organisation-level accounts that belong to no treasury (executor fees). */
  treasuryId: string | null;
  code: LedgerAccountCode;
  assetId: string;
  direction: "debit" | "credit";
  amount: string;
}

export type LedgerAccountCode =
  | "treasury_asset"
  | "pending_outbound"
  | "settled_expense"
  | "fee_expense"
  | "executor_fee_expense"
  | "accounts_receivable"
  | "revenue"
  | "inbound_unallocated"
  | "opening_balance";

const accountNames: Record<LedgerAccountCode, string> = {
  treasury_asset: "Treasury asset",
  pending_outbound: "Pending outbound",
  settled_expense: "Settled expense",
  fee_expense: "Network fees",
  executor_fee_expense: "Executor network fees",
  accounts_receivable: "Accounts receivable",
  revenue: "Invoiced revenue",
  inbound_unallocated: "Unallocated receipts",
  opening_balance: "Opening balance"
};

async function account(tx: Db, organizationId: string, treasuryId: string | null, code: LedgerAccountCode, assetId: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into ledger_accounts (organization_id, treasury_account_id, code, name, asset_id)
    values (${organizationId}, ${treasuryId}, ${code}, ${accountNames[code]}, ${assetId})
    on conflict (organization_id, coalesce(treasury_account_id, '00000000-0000-0000-0000-000000000000'::uuid), code, asset_id) do update set name = excluded.name
    returning id::text
  `;
  if (!rows[0]) throw new Error("Ledger account upsert failed");
  return rows[0].id;
}

/**
 * Posts balanced entries once per external reference. Returns false when the
 * reference was already posted, which makes every caller safe to repeat.
 */
export async function postLedger(tx: Db, organizationId: string, intentId: string | null, reference: string, description: string, lines: LedgerLine[]): Promise<boolean> {
  const perAsset = new Map<string, bigint>();
  for (const line of lines) {
    if (BigInt(line.amount) <= 0n) throw new Error(`Ledger amounts must be positive (${line.code})`);
    perAsset.set(line.assetId, (perAsset.get(line.assetId) ?? 0n) + (line.direction === "debit" ? 1n : -1n) * BigInt(line.amount));
  }
  for (const [assetId, net] of perAsset) if (net !== 0n) throw new Error(`Unbalanced ledger posting for ${assetId}`);
  const rows = await tx<{ id: string }[]>`
    insert into ledger_transactions (organization_id, intent_id, external_reference, description, effective_at)
    values (${organizationId}, ${intentId}, ${reference}, ${description}, now())
    on conflict (organization_id, external_reference) do nothing returning id::text
  `;
  const transactionId = rows[0]?.id;
  if (!transactionId) return false;
  for (const line of lines) {
    const accountId = await account(tx, organizationId, line.treasuryId, line.code, line.assetId);
    await tx`insert into ledger_entries (transaction_id, account_id, direction, amount_base_units) values (${transactionId}, ${accountId}, ${line.direction}, ${line.amount})`;
  }
  return true;
}

/** Net debit balance of one treasury account code for an asset, optionally before a timestamp. */
export async function ledgerNet(tx: Db, treasuryId: string, code: LedgerAccountCode, assetId: string, before?: string): Promise<bigint> {
  const rows = await tx<{ net: string }[]>`
    select coalesce(sum(case when le.direction = 'debit' then le.amount_base_units else -le.amount_base_units end), 0)::text as net
    from ledger_entries le
    join ledger_accounts la on la.id = le.account_id
    join ledger_transactions lt on lt.id = le.transaction_id
    where la.treasury_account_id = ${treasuryId} and la.code = ${code} and la.asset_id = ${assetId}
      and (${before ?? null}::timestamptz is null or lt.effective_at < ${before ?? null})
  `;
  return BigInt(rows[0]?.net ?? "0");
}
