import { buildApp } from "./app.js";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { keyConfigurationFromEnv } from "@ai-neobank/signer";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { readLocalSafeContracts } from "./local-fixtures.js";

const env = process.env;
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const environment = (env.RELAY_ENVIRONMENT ?? "development") as "development" | "test" | "production";
const port = Number(env.PORT ?? 8720);
const host = env.HOST ?? "127.0.0.1";
const evmChainId = env.EVM_CHAIN_ID ? Number(env.EVM_CHAIN_ID) : undefined;
const keyConfiguration = await keyConfigurationFromEnv(env);
// Local chains have no canonical Safe deployments; scripts/localnet.sh records fixture addresses here.
const safeContracts = readLocalSafeContracts(env.LOCAL_FIXTURES_FILE);

const app = buildApp({
  store: createPostgresStore(databaseUrl),
  queue: createPostgresJobQueue(databaseUrl),
  environment,
  auth: { domain: env.AUTH_DOMAIN ?? "localhost", uri: env.AUTH_URI ?? `http://localhost:${port}` },
  ...(env.WEB_ORIGIN ? { webOrigin: env.WEB_ORIGIN } : {}),
  ...(keyConfiguration.keys ? { keys: keyConfiguration.keys, allowSoftwareSigners: env.ALLOW_SOFTWARE_SIGNERS === "true" } : {}),
  ...(keyConfiguration.kms ? { kms: keyConfiguration.kms } : {}),
  ...(env.X402_FACILITATOR_URL ? { x402Seller: { facilitator: new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }) } } : {}),
  chains: {
    ...(env.EVM_RPC_URL && evmChainId ? { evm: { rpcUrl: env.EVM_RPC_URL, chainId: evmChainId, network: `eip155:${evmChainId}` as const, confirmations: Number(env.EVM_CONFIRMATIONS ?? 1), ...(safeContracts ? { safeContracts } : {}) } } : {}),
    ...(env.SOLANA_RPC_URL && env.SOLANA_NETWORK ? { solana: { rpcUrl: env.SOLANA_RPC_URL, network: env.SOLANA_NETWORK as `solana:${string}`, finality: (env.SOLANA_FINALITY as "confirmed" | "finalized" | undefined) ?? "finalized" } } : {})
  }
});
await app.listen({ port, host });
