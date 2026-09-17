/**
 * Deploys Safe 1.4.1 singleton contracts to the local Anvil chain once and records
 * their addresses in .local/safe-contracts.json. Public networks use the canonical
 * deployments that Protocol Kit already knows, so this is local-only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { deploySafeProtocolFixture, type SafeContractAddresses } from "@ai-neobank/safe-adapter";

const rpcUrl = process.env.EVM_RPC_URL ?? "http://127.0.0.1:8722";
const output = new URL("../../../.local/safe-contracts.json", import.meta.url);
// Anvil's first default account: public, funded only on local chains.
const anvilKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const client = createPublicClient({ transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (chainId !== 31337) throw new Error(`Refusing to deploy fixtures to chain ${chainId}; this script is for local Anvil only`);
if (existsSync(output)) {
  const existing = JSON.parse(readFileSync(output, "utf8")) as SafeContractAddresses;
  const code = await client.getCode({ address: existing.safeSingletonAddress as Address });
  if (code && code !== "0x") { console.log(`Safe contracts already deployed at ${existing.safeSingletonAddress}`); process.exit(0); }
}
const contracts = await deploySafeProtocolFixture(rpcUrl, chainId, anvilKey);
writeFileSync(output, JSON.stringify(contracts, null, 2));
console.log(`Deployed Safe contracts; singleton ${contracts.safeSingletonAddress}`);
