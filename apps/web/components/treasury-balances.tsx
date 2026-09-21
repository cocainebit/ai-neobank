"use client";

import { useApi } from "../lib/api";
import type { Balance, Reconciliation, Treasury } from "../lib/types";
import { Amount } from "./ui";

/** Live balances read from chain for one treasury; zero balances sink below the rest. */
export function useTreasuryBalances(treasuryId: string) {
  return useApi<{ balances: Balance[]; observedAt: string }>(`/v1/treasuries/${treasuryId}/balances`, { refreshMs: 20_000 });
}

export function BalanceList({ treasury, reconciliations, compact = false }: { treasury: Treasury; reconciliations?: Reconciliation[]; compact?: boolean }) {
  const balances = useTreasuryBalances(treasury.id);
  if (balances.error) return <span className="faint" style={{ fontSize: 13 }}>{balances.error.code === "network_not_configured" ? `The API is not connected to ${treasury.network}.` : balances.error.message}</span>;
  if (!balances.data) return <span className="skeleton" style={{ width: 120 }} />;
  // A null balance is one the chain could not be read for, which is not the same
  // as holding none: treating it as zero hid an unreadable asset behind a
  // treasury that looked empty. Held first, unreadable next, empty last, and the
  // compact view never drops an unreadable one.
  const rank = (balance: Balance) => (balance.balanceBaseUnits === null ? 1 : BigInt(balance.balanceBaseUnits) > 0n ? 0 : 2);
  const sorted = [...balances.data.balances].sort((a, b) => rank(a) - rank(b));
  const shown = compact ? sorted.filter((balance) => rank(balance) < 2).slice(0, 3) : sorted;
  if (shown.length === 0) return <span className="faint" style={{ fontSize: 13 }}>Empty. Send funds to the address to get started.</span>;
  const unreadable = shown.some((balance) => balance.balanceBaseUnits === null);
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 8 }}>
      {shown.map((balance) => {
        const reconciliation = reconciliations?.find((entry) => entry.treasuryAccountId === treasury.id && entry.assetId === balance.assetId);
        return (
          <div key={balance.assetId} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span className={BigInt(balance.balanceBaseUnits ?? "0") > 0n ? "" : "faint"} style={{ fontSize: compact ? 14 : 15 }}>
              {balance.balanceBaseUnits === null
                ? <span className="faint" title={`${balance.symbol} could not be read on ${treasury.network}. That is not the same as holding none.`}>{balance.symbol} unknown</span>
                : <Amount value={balance.balanceBaseUnits} decimals={balance.decimals} symbol={balance.symbol} places={balance.decimals > 8 ? 4 : 2} />}
            </span>
            {!compact && reconciliation && (
              <span className={reconciliation.status === "matched" ? "positive" : reconciliation.status === "break" ? "negative" : "faint"} style={{ fontSize: 12 }}>
                {reconciliation.status === "matched" ? "Reconciled" : reconciliation.status === "break" ? "Difference found" : "In flight"}
              </span>
            )}
          </div>
        );
      })}
      {unreadable && !compact && (
        <span className="faint" style={{ fontSize: 12 }}>
          An unknown balance is one this network could not be read for, often a token address with no contract behind it. It does not mean the treasury holds none.
        </span>
      )}
    </div>
  );
}
