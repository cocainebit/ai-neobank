"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { displayUnits, formatUnits, type Tone } from "../lib/format";
import { Icons } from "./icons";

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

export function Panel({ title, description, actions, children, className = "", bodyless = false }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyless?: boolean }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="btn-row">{actions}</div>}
        </header>
      )}
      {bodyless ? children : <div className="panel-body">{children}</div>}
    </section>
  );
}

export function PageHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const Glyph = tone === "negative" || tone === "pending" ? Icons.Alert : Icons.Info;
  return <div className={`notice ${tone === "neutral" ? "" : tone}`} role={tone === "negative" ? "alert" : undefined}><Glyph />{<div>{children}</div>}</div>;
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rows" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="row" key={index}><span className="skeleton" style={{ width: `${40 + ((index * 17) % 35)}%` }} /><span className="skeleton" style={{ width: 80 }} /></div>
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: { message: string }; retry?: () => void }) {
  return (
    <div className="panel-body">
      <Notice tone="negative"><b>Could not load.</b> {error.message} {retry && <button className="btn small ghost" onClick={retry}>Try again</button>}</Notice>
    </div>
  );
}

/** A base-unit amount with its unit one step dimmer; the exact value is in the tooltip. */
export function Amount({ value, decimals, symbol, sign, places }: { value: string | bigint; decimals: number; symbol?: string; sign?: "+" | "-"; places?: number }) {
  return (
    <span className="amount num" title={`${formatUnits(value, decimals)}${symbol ? ` ${symbol}` : ""}`}>
      {sign === "-" ? "−" : sign === "+" ? "+" : ""}{displayUnits(value, decimals, places)}
      {symbol && <span className="unit">{symbol}</span>}
    </span>
  );
}

export function Modal({ title, description, onClose, children, footer, wide = false }: { title: string; description?: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="overlay-head">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icons.Close /></button>
        </div>
        <div className="overlay-body">{children}</div>
        {footer && <div className="overlay-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Drawer({ title, description, onClose, children, footer }: { title: ReactNode; description?: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="overlay-head">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icons.Close /></button>
        </div>
        <div className="overlay-body">{children}</div>
        {footer && <div className="overlay-foot">{footer}</div>}
      </aside>
    </>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const toast = useToast();
  return (
    <div className="copy-field">
      <span className="address" title={value}>{label ?? value}</span>
      <button className="btn small ghost" type="button" onClick={() => { void navigator.clipboard.writeText(value); toast("Copied"); }}><Icons.Copy />Copy</button>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(value: boolean): void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)} />;
}

// Toasts

const ToastContext = createContext<(message: string, tone?: "negative") => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; tone?: "negative" }[]>([]);
  const push = useCallback((message: string, tone?: "negative") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, ...(tone ? { tone } : {}) }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), tone ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone ?? ""}`}>{toast.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Runs an async action with a busy flag and a failure toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const result = await action();
      if (success) toast(success);
      return result;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "negative");
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}

/** Client-only relative time, so the server render and the first client render agree. */
export function Ago({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const update = async () => { const { timeAgo } = await import("../lib/format"); setText(timeAgo(iso)); };
    void update();
    const timer = window.setInterval(() => void update(), 30_000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return <time dateTime={iso} title={new Date(iso).toISOString()}>{text || " "}</time>;
}
