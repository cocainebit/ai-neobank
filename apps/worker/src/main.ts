import { createWorker } from "./worker.js";
import { parseMasterKey } from "@ai-neobank/signer";

const env = process.env;
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pollMs = Number(env.WORKER_POLL_MS ?? 500);
const signerMasterKey = env.SIGNER_MASTER_KEY ? parseMasterKey(env.SIGNER_MASTER_KEY) : undefined;
const evmChainId = env.EVM_CHAIN_ID ? Number(env.EVM_CHAIN_ID) : undefined;
const chainConfig = signerMasterKey ? {
  signerMasterKey,
  ...(env.EVM_RPC_URL && evmChainId ? { evm: { rpcUrl: env.EVM_RPC_URL, chainId: evmChainId, network: `eip155:${evmChainId}` as const, confirmations: Number(env.EVM_CONFIRMATIONS ?? 1) } } : {}),
  ...(env.SOLANA_RPC_URL && env.SOLANA_NETWORK ? { solana: { rpcUrl: env.SOLANA_RPC_URL, network: env.SOLANA_NETWORK as `solana:${string}`, finality: (env.SOLANA_FINALITY as "confirmed" | "finalized" | undefined) ?? "finalized" } } : {})
} : undefined;
if (!chainConfig) console.warn("SIGNER_MASTER_KEY is not set: the worker will evaluate and expire intents but cannot execute them");
const runtime = createWorker(databaseUrl, chainConfig);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const worked = await runtime.worker.runOnce().catch((error) => { console.error("worker loop error", error); return false; });
  if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await runtime.close();
