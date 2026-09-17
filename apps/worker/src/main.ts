import { createWorker } from "./worker.js";
import { parseMasterKey } from "@ai-neobank/signer";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pollMs = Number(process.env.WORKER_POLL_MS ?? 500);
const signerMasterKey = process.env.SIGNER_MASTER_KEY ? parseMasterKey(process.env.SIGNER_MASTER_KEY) : undefined;
const evmChainId = process.env.EVM_CHAIN_ID ? Number(process.env.EVM_CHAIN_ID) : undefined;
const chainConfig = signerMasterKey ? {
  signerMasterKey,
  ...(process.env.EVM_RPC_URL && evmChainId ? { evm: { rpcUrl: process.env.EVM_RPC_URL, chainId: evmChainId, network: `eip155:${evmChainId}` as const } } : {}),
  ...(process.env.SOLANA_RPC_URL && process.env.SOLANA_NETWORK ? { solana: { rpcUrl: process.env.SOLANA_RPC_URL, network: process.env.SOLANA_NETWORK as `solana:${string}` } } : {})
} : undefined;
const runtime = createWorker(databaseUrl, chainConfig);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const worked = await runtime.worker.runOnce();
  if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await runtime.close();
