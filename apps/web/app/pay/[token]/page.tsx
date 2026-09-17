"use client";

import { use, useEffect, useState } from "react";
import QRCode from "qrcode";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { Icons } from "../../../components/icons";
import { Notice } from "../../../components/ui";
import { networkLabel, shortAddress } from "../../../lib/format";
import { availableWallets, connectEvm, ensureEvmChain, sendEvmTransaction } from "../../../lib/wallet";

interface PublicInvoice {
  number: string; status: "open" | "paid" | "void"; issuer: string; customerName: string; memo: string | null;
  lineItems: { description: string; quantity: number; unitAmountBaseUnits: string }[];
  currency: string; decimals: number; network: string; subtotal: string; amountDue: string; amountPaid: string; amountDueBaseUnits: string;
  payTo: string; asset: string | null; dueAt: string | null; paidAt: string | null; amountNote: string | null;
  instructions: { solanaPay?: string; eip681?: string; x402?: string };
}

function decimal(baseUnits: string | bigint, decimals: number): string {
  const digits = BigInt(baseUnits).toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export default function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [missing, setMissing] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; hash: string | null }>({ busy: false, error: null, hash: null });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const response = await fetch(`/api/v1/public/invoices/${encodeURIComponent(token)}`);
      if (stopped) return;
      if (!response.ok) { setMissing(true); return; }
      setInvoice(((await response.json()) as { data: PublicInvoice }).data);
    };
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [token]);

  const evm = invoice?.network.startsWith("eip155:");
  // EIP-681 needs a token contract; native ETH invoices use a plain address URI with the value in wei.
  const uri = invoice ? invoice.instructions.solanaPay ?? invoice.instructions.eip681 ?? (evm ? `ethereum:${invoice.payTo}@${invoice.network.split(":")[1]}?value=${invoice.amountDueBaseUnits}` : null) : null;

  useEffect(() => {
    if (!uri || invoice?.status !== "open") { setQr(null); return; }
    void QRCode.toDataURL(uri, { margin: 1, width: 360, color: { dark: "#0b0c0f", light: "#f1f1f3" } }).then(setQr);
  }, [uri, invoice?.status]);

  function copy(value: string, key: string) {
    void navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  }

  async function payWithWallet() {
    if (!invoice) return;
    setState({ busy: true, error: null, hash: null });
    try {
      const from = await connectEvm();
      await ensureEvmChain(Number(invoice.network.split(":")[1]));
      const transaction = invoice.asset
        ? { to: invoice.asset, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [invoice.payTo as Hex, BigInt(invoice.amountDueBaseUnits)] }) }
        : { to: invoice.payTo, value: invoice.amountDueBaseUnits, data: "0x" };
      const hash = await sendEvmTransaction(from, transaction);
      setState({ busy: false, error: null, hash });
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message.split("\n")[0]! : "The wallet did not send the payment", hash: null });
    }
  }

  if (missing) {
    return (
      <main className="pay-page">
        <div className="pay-card panel"><div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Invoice not found</h1>
          <p className="dim" style={{ margin: 0 }}>The link may be mistyped, or the invoice has not been issued yet. Ask the sender for a new link.</p>
        </div></div>
      </main>
    );
  }
  if (!invoice) return <main className="pay-page" aria-busy="true" />;

  const due = invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  const wallets = typeof window === "undefined" ? { evm: null } : availableWallets();

  return (
    <main className="pay-page">
      <div className="pay-card" style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--dim)", fontSize: 13.5 }}>
          <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 7 }}><Icons.Logo style={{ width: 13, height: 13 }} /></span>
          Invoice from <b style={{ color: "var(--text)", fontWeight: 550 }}>{invoice.issuer}</b>
        </div>
        <section className="panel milled">
          <div className="panel-body" style={{ display: "grid", gap: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <div className="eyebrow">{invoice.status === "paid" ? "Paid in full" : invoice.status === "void" ? "Voided" : "Amount due"}</div>
                <div className="display" style={{ marginTop: 10 }}>{invoice.status === "paid" ? invoice.amountPaid : invoice.amountDue}<span className="unit">{invoice.currency}</span></div>
                <div className="dim" style={{ marginTop: 8, fontSize: 13.5 }}>{invoice.number} · for {invoice.customerName}{due ? ` · due ${due}` : ""}</div>
              </div>
              <span className={`pill ${invoice.status === "paid" ? "positive" : invoice.status === "void" ? "" : "pending"}`}>{invoice.status === "paid" ? "Paid" : invoice.status === "void" ? "Void" : invoice.amountPaid !== "0" ? "Part paid" : "Awaiting payment"}</span>
            </div>
            <div className="panel" style={{ background: "var(--panel-2)" }}>
              <div className="rows">
                {invoice.lineItems.map((line, index) => (
                  <div key={index} className="row" style={{ padding: "11px 14px", minHeight: 0 }}>
                    <span className="cell-title"><b style={{ fontWeight: 450 }}>{line.description}</b><span className="num">{line.quantity} × {decimal(line.unitAmountBaseUnits, invoice.decimals)} {invoice.currency}</span></span>
                    <span className="num">{decimal(BigInt(line.unitAmountBaseUnits) * BigInt(line.quantity), invoice.decimals)} {invoice.currency}</span>
                  </div>
                ))}
                <div className="row" style={{ padding: "11px 14px", minHeight: 0 }}><span className="dim">Subtotal</span><span className="num">{invoice.subtotal} {invoice.currency}</span></div>
              </div>
            </div>
            {invoice.memo && <p className="dim" style={{ margin: 0 }}>{invoice.memo}</p>}
          </div>
        </section>

        {invoice.status === "open" && (
          <section className="panel">
            <header className="panel-head"><div><h2>Pay {invoice.amountDue} {invoice.currency} on {networkLabel(invoice.network)}</h2><p>Send exactly this amount. It is matched to this invoice automatically.</p></div></header>
            <div className="panel-body" style={{ display: "grid", gridTemplateColumns: qr ? "180px minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
              {qr && <img src={qr} alt={`QR code for paying ${invoice.number}`} width={180} height={180} style={{ borderRadius: 10, display: "block" }} />}
              <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
                <PayField label="Send to" value={invoice.payTo} display={shortAddress(invoice.payTo, 12, 10)} copied={copied === "to"} onCopy={() => copy(invoice.payTo, "to")} />
                <PayField label={`Amount (${invoice.currency})`} value={invoice.amountDue} copied={copied === "amount"} onCopy={() => copy(invoice.amountDue, "amount")} />
                {invoice.asset && <PayField label="Token contract" value={invoice.asset} display={shortAddress(invoice.asset, 12, 10)} copied={copied === "asset"} onCopy={() => copy(invoice.asset!, "asset")} />}
                {evm && (
                  <div className="btn-row">
                    <button className="btn primary" disabled={state.busy || !wallets.evm} onClick={() => void payWithWallet()}><Icons.Wallet />{state.busy ? "Confirm in your wallet…" : "Pay with wallet"}</button>
                    {!wallets.evm && <span className="faint" style={{ fontSize: 12.5 }}>No browser wallet found. Scan the code or send manually.</span>}
                  </div>
                )}
                {!evm && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Scan with Phantom, Solflare, or any Solana Pay wallet.</p>}
              </div>
            </div>
            {(state.error || state.hash || invoice.amountNote) && (
              <div className="panel-body" style={{ paddingTop: 0, display: "grid", gap: 10 }}>
                {state.hash && <Notice tone="positive"><b>Payment sent.</b> This page updates once the payment is confirmed and matched. Transaction {shortAddress(state.hash, 10, 8)}.</Notice>}
                {state.error && <Notice tone="negative">{state.error}</Notice>}
                {invoice.amountNote && !state.hash && <Notice>{invoice.amountNote}</Notice>}
              </div>
            )}
          </section>
        )}

        {invoice.status === "open" && invoice.instructions.x402 && (
          <section className="panel">
            <header className="panel-head"><div><h2>Paying from software</h2><p>This invoice accepts x402 v2. A client that supports x402 can pay it with one request.</p></div></header>
            <div className="panel-body"><PayField label="x402 endpoint" value={invoice.instructions.x402} copied={copied === "x402"} onCopy={() => copy(invoice.instructions.x402!, "x402")} /></div>
          </section>
        )}

        {invoice.status === "paid" && <Notice tone="positive"><b>Thank you.</b> {invoice.issuer} has received {invoice.amountPaid} {invoice.currency}{invoice.paidAt ? ` on ${new Date(invoice.paidAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}` : ""}.</Notice>}
        <p className="faint" style={{ margin: 0, fontSize: 12, textAlign: "center" }}>Payments are final once confirmed on chain. Check the address with {invoice.issuer} if in doubt.</p>
      </div>
    </main>
  );
}

function PayField({ label, value, display, copied, onCopy }: { label: string; value: string; display?: string; copied: boolean; onCopy(): void }) {
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span className="eyebrow">{label}</span>
      <div className="copy-field">
        <span className="address" title={value}>{display ?? value}</span>
        <button className="btn small ghost" type="button" onClick={onCopy}><Icons.Copy />{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}
