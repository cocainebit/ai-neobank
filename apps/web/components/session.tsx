"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, invalidate } from "../lib/api";
import type { Session } from "../lib/types";
import { availableWallets, connectEvm, connectSolana, signEvmMessage, signSolanaMessage, type WalletSource } from "../lib/wallet";
import { Icons } from "./icons";
import { Notice } from "./ui";

interface SessionContextValue {
  session: Session;
  reload(): Promise<void>;
  signOut(): Promise<void>;
  can(...roles: Session["memberships"][number]["role"][]): boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "unreachable">("loading");

  const reload = useCallback(async () => {
    try {
      const result = await api<{ data: Session }>("/v1/auth/session");
      if (result.data.kind !== "human") throw new ApiError(401, "unauthenticated", "Agents cannot use the console");
      setSession(result.data);
      setState("ready");
    } catch (error) {
      setSession(null);
      setState(error instanceof ApiError && error.status === 401 ? "signed-out" : "unreachable");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const signOut = useCallback(async () => {
    await api("/v1/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setSession(null);
    setState("signed-out");
  }, []);

  if (state === "loading") return <div className="auth" aria-busy="true" />;
  if (state === "unreachable") {
    return (
      <div className="pay-page">
        <div className="pay-card panel"><div className="panel-body stack">
          <h2 style={{ margin: 0 }}>The Relay API is not reachable</h2>
          <Notice tone="negative">The console proxies <b>/api</b> to the API on port 8720. Start it with <b>pnpm dev:api</b>, and the local chains with <b>pnpm localnet</b>.</Notice>
          <div><button className="btn" onClick={() => void reload()}><Icons.Refresh />Try again</button></div>
        </div></div>
      </div>
    );
  }
  if (state === "signed-out" || !session) return <SignIn onSignedIn={reload} />;
  const can = (...roles: Session["memberships"][number]["role"][]) => Boolean(session.principal && roles.includes(session.principal.role));
  return <SessionContext.Provider value={{ session, reload, signOut, can }}>{children}</SessionContext.Provider>;
}

function SignIn({ onSignedIn }: { onSignedIn(): Promise<void> }) {
  const [wallets, setWallets] = useState<{ evm: WalletSource | null; solana: WalletSource | null }>({ evm: null, solana: null });
  const [busy, setBusy] = useState<"evm" | "svm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setWallets(availableWallets()); }, []);

  async function signIn(chainFamily: "evm" | "svm") {
    setBusy(chainFamily);
    setError(null);
    try {
      const address = chainFamily === "evm" ? await connectEvm() : await connectSolana();
      const challenge = await api<{ data: { nonce: string; message: string } }>("/v1/auth/challenges", { method: "POST", body: { chainFamily, address } });
      const signature = chainFamily === "evm" ? await signEvmMessage(address, challenge.data.message) : await signSolanaMessage(challenge.data.message);
      await api("/v1/auth/verify", { method: "POST", body: { chainFamily, address, nonce: challenge.data.nonce, signature } });
      invalidate();
      await onSignedIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="auth">
      <section className="auth-story">
        <div className="brand"><span className="brand-mark"><Icons.Logo /></span>Relay</div>
        <div style={{ display: "grid", gap: 20 }}>
          <h1>Money your agents can move. Rules only you can change.</h1>
          <p>Relay is a crypto business account for people and the AI agents that work for them. Treasuries stay in your Safe or Squads vault; agents ask, policy decides, and your wallet signs.</p>
        </div>
        <div className="auth-points">
          <div><Icons.Policy style={{ width: 20, color: "var(--dim)" }} /><span><b>Policy before signature</b><span>Limits, allowlists, and freezes run at request time and again right before signing.</span></span></div>
          <div><Icons.Treasury style={{ width: 20, color: "var(--dim)" }} /><span><b>Your keys own the treasury</b><span>Safe owners and Squads members approve on chain. Relay never holds a vote.</span></span></div>
          <div><Icons.Statement style={{ width: 20, color: "var(--dim)" }} /><span><b>Every movement reconciled</b><span>Receipts, payouts, and fees are booked and checked against the chain.</span></span></div>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div>
            <h2 style={{ margin: "0 0 6px", fontSize: 22, letterSpacing: "-0.02em" }}>Sign in with your wallet</h2>
            <p className="dim" style={{ margin: 0 }}>Signing proves you control the address. It does not move funds or grant spending authority.</p>
          </div>
          <button className="wallet-option" onClick={() => void signIn("evm")} disabled={busy !== null || !wallets.evm}>
            <span className="wallet-glyph"><Icons.Ethereum /></span>
            <span><b style={{ display: "block", fontWeight: 600 }}>Ethereum wallet</b><span className="faint" style={{ fontSize: 13 }}>{wallets.evm === "development" ? "Development wallet in this browser" : wallets.evm ? "MetaMask, Rabby, or any EIP-1193 wallet" : "No Ethereum wallet detected"}</span></span>
            <span className="faint">{busy === "evm" ? "Waiting…" : <Icons.ChevronRight style={{ width: 18 }} />}</span>
          </button>
          <button className="wallet-option" onClick={() => void signIn("svm")} disabled={busy !== null || !wallets.solana}>
            <span className="wallet-glyph"><Icons.Solana /></span>
            <span><b style={{ display: "block", fontWeight: 600 }}>Solana wallet</b><span className="faint" style={{ fontSize: 13 }}>{wallets.solana === "development" ? "Development wallet in this browser" : wallets.solana ? "Phantom, Backpack, or Solflare" : "No Solana wallet detected"}</span></span>
            <span className="faint">{busy === "svm" ? "Waiting…" : <Icons.ChevronRight style={{ width: 18 }} />}</span>
          </button>
          {error && <Notice tone="negative">{error}</Notice>}
          <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>First time here? Signing in creates a workspace that your wallet owns. To join a team, ask an owner to add your wallet address, then sign in.</p>
        </div>
      </section>
    </main>
  );
}
