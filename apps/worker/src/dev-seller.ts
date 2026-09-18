/**
 * A local x402 seller and facilitator for driving the console by hand:
 * prices one resource in a registered token and settles on the local chain.
 *   pnpm --filter @ai-neobank/worker exec tsx src/dev-seller.ts <token address> [port]
 */
import { createLocalFacilitator, startLocalSeller } from "@ai-neobank/x402-adapter/testing";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const token = process.argv[2];
const port = Number(process.argv[3] ?? 8728);
if (!token) throw new Error("Pass the token address");
const rpcUrl = process.env.EVM_RPC_URL ?? "http://127.0.0.1:8722";
// Anvil's third published account pays settlement gas as the facilitator.
const facilitatorKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const payee = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

const facilitator = await createLocalFacilitator({ evm: { rpcUrl, chainId: 31337, privateKey: facilitatorKey } });
const seller = await startLocalSeller(facilitator.client, [
  { route: "GET /report", network: "eip155:31337", payTo: payee, asset: token, amount: "250000", extra: { name: "Test USD", version: "2" }, description: "Quarterly market report", body: { report: "quarterly", pages: 24 } }
], { evm: { rpcUrl } }, port);
console.log(`seller ${seller.url}/report paying ${payee}, facilitator ${privateKeyToAccount(facilitatorKey).address}`);
