"use client";

import { useMemo } from "react";
import { useApi } from "./api";
import type { Agent, Asset, Beneficiary, Intent, Member, Networks, Policy, Signer, Treasury } from "./types";

export const useTreasuries = () => useApi<Treasury[]>("/v1/treasuries");
export const useMembers = () => useApi<Member[]>("/v1/members");
export const useAgents = () => useApi<Agent[]>("/v1/agents");
export const usePolicies = () => useApi<Policy[]>("/v1/policies");
export const useBeneficiaries = () => useApi<Beneficiary[]>("/v1/beneficiaries");
export const useSigners = () => useApi<Signer[]>("/v1/signers");
export const useNetworks = () => useApi<Networks>("/v1/networks");
export const useIntents = (status?: string) => useApi<Intent[]>(`/v1/intents${status ? `?status=${status}` : ""}`, { refreshMs: 8_000 });

export function useAssets() {
  const resource = useApi<Asset[]>("/v1/assets");
  const byId = useMemo(() => new Map((resource.data ?? []).map((asset) => [asset.id, asset])), [resource.data]);
  return { ...resource, byId };
}

/** Symbol and decimals for an asset id, falling back to the native coin conventions when the registry has not loaded. */
export function assetMeta(byId: Map<string, Asset>, assetId: string): { symbol: string; decimals: number } {
  const known = byId.get(assetId);
  if (known) return { symbol: known.symbol, decimals: known.decimals };
  if (assetId.endsWith("/slip44:60")) return { symbol: "ETH", decimals: 18 };
  if (assetId.endsWith("/slip44:501")) return { symbol: "SOL", decimals: 9 };
  return { symbol: "", decimals: 0 };
}

/** Who asked: a member's name, an agent's name, or a short id. */
export function usePrincipalNames() {
  const members = useMembers();
  const agents = useAgents();
  return useMemo(() => {
    const names = new Map<string, { name: string; kind: "member" | "agent" }>();
    for (const member of members.data ?? []) names.set(member.id, { name: member.displayName, kind: "member" });
    for (const agent of agents.data ?? []) names.set(agent.principalId, { name: agent.displayName, kind: "agent" });
    return names;
  }, [members.data, agents.data]);
}

export const governanceLabel: Record<Treasury["governance"], string> = { direct: "Direct account", safe: "Safe multisig", squads: "Squads vault" };
