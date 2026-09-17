"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const messages: Record<string, string> = {
  unauthenticated: "Your session has ended. Sign in again.",
  forbidden: "Your role does not allow this.",
  origin_not_allowed: "This request came from an origin the API does not trust.",
  organization_frozen: "The organization is frozen. Unfreeze it in Settings to continue.",
  software_signers_disabled: "Development signers are disabled on this server.",
  software_signers_need_kms: "Production needs KMS-wrapped or KMS-held signers.",
  approval_signature_invalid: "The signature did not come from your signed-in wallet.",
  wallet_is_not_a_safe_owner: "Your wallet is not an owner of this Safe.",
  treasury_busy: "Payments are in flight on this treasury. Finish them first.",
  evidence_mismatch: "The payment changed since you opened it. Reload and review again.",
  stale_version: "The payment changed since you opened it. Reload and review again.",
  frozen: "Something involved is frozen: the organization, the treasury, or the requester.",
  network_not_configured: "The API is not connected to that network."
};

function describe(code: string, fallback: string): string {
  return messages[code] ?? fallback ?? code;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { payload = { error: "invalid_response", message: text.slice(0, 200) }; }
  if (!response.ok) {
    const code = String(payload.error ?? response.status);
    const details = payload.details;
    let message = typeof payload.message === "string" ? payload.message : describe(code, code.replaceAll("_", " "));
    if (code === "invalid_request" && typeof details === "string") message = details;
    if (response.status === 502 || response.status === 504) message = "The Relay API is not reachable. Start it with pnpm dev:api.";
    throw new ApiError(response.status, code, describe(code, message), details);
  }
  return payload as T;
}

// Every mounted resource refetches when a mutation invalidates it.
const listeners = new Set<(path: string) => void>();

export function invalidate(prefix = "/"): void {
  for (const listener of listeners) listener(prefix);
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload(): Promise<void>;
}

/** Fetches `path` (unwrapping `{ data }`), refetches on invalidation, and optionally polls without overlapping requests. */
export function useApi<T>(path: string | null, options: { refreshMs?: number; raw?: boolean } = {}): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(Boolean(path));
  const inFlight = useRef(false);
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    const target = current.current;
    if (!target || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await api<{ data: T }>(target);
      if (current.current === target) { setData(options.raw ? result as unknown as T : result.data); setError(undefined); }
    } catch (caught) {
      if (current.current === target) setError(caught instanceof ApiError ? caught : new ApiError(0, "network", "The Relay API is not reachable. Start it with pnpm dev:api."));
    } finally {
      inFlight.current = false;
      if (current.current === target) setLoading(false);
    }
  }, [options.raw]);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    setLoading(true);
    void load();
    const listener = (prefix: string) => { if (path.startsWith(prefix) || prefix === "/") void load(); };
    listeners.add(listener);
    const timer = options.refreshMs ? window.setInterval(() => void load(), options.refreshMs) : undefined;
    return () => { listeners.delete(listener); if (timer) window.clearInterval(timer); };
  }, [path, load, options.refreshMs]);

  return { data, error, loading, reload: load };
}
