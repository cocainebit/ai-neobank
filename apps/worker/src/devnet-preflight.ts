/**
 * Reads the public test networks Relay would run on and reports what is ready
 * and what is blocked on funding. Read-only: it sends no transactions.
 *   pnpm --filter @ai-neobank/worker exec tsx src/devnet-preflight.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, formatEther, type Address } from "viem";

const evmRpc = process.env.DEVNET_EVM_RPC_URL ?? "https://sepolia.base.org";
const solanaRpc = process.env.DEVNET_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const evmAddress = process.env.DEVNET_EVM_ADDRESS as Address | undefined;
const solanaAddress = process.env.DEVNET_SOLANA_ADDRESS;
// Canonical Safe 1.4.1 deployments and Base Sepolia USDC, the assets Relay expects to find.
const safeSingleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address;
const safeFactory = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;
const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const squadsProgram = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

const report: { check: string; state: "ready" | "blocked" | "unknown"; detail: string }[] = [];
const add = (check: string, state: "ready" | "blocked" | "unknown", detail: string) => report.push({ check, state, detail });

try {
  const client = createPublicClient({ transport: http(evmRpc) });
  const [chainId, head] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  add("Base Sepolia RPC", chainId === 84532 ? "ready" : "blocked", `${evmRpc} chain ${chainId}, head ${head}`);
  const [singletonCode, factoryCode] = await Promise.all([client.getCode({ address: safeSingleton }), client.getCode({ address: safeFactory })]);
  add("Safe 1.4.1 deployments", singletonCode && factoryCode && singletonCode !== "0x" ? "ready" : "blocked", singletonCode && singletonCode !== "0x" ? "singleton and factory present, no fixtures needed" : "canonical addresses have no code on this chain");
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" })
  ]);
  add("Base Sepolia USDC", "ready", `${usdc} is ${symbol} with ${decimals} decimals`);
  if (evmAddress) {
    const balance = await client.getBalance({ address: evmAddress });
    add("EVM signer funding", balance > 0n ? "ready" : "blocked", `${evmAddress} holds ${formatEther(balance)} ETH${balance > 0n ? "" : "; Base Sepolia faucets are gated, so this needs a manual top-up"}`);
  } else {
    add("EVM signer funding", "unknown", "Set DEVNET_EVM_ADDRESS (and DEVNET_EVM_KEY to run the transfer) to check");
  }
} catch (error) {
  add("Base Sepolia RPC", "blocked", error instanceof Error ? error.message.split("\n")[0]! : String(error));
}

try {
  const connection = new Connection(solanaRpc, "confirmed");
  const version = await connection.getVersion();
  const slot = await connection.getSlot("finalized");
  add("Solana devnet RPC", "ready", `${solanaRpc} solana-core ${version["solana-core"]}, finalized slot ${slot}`);
  const program = await connection.getAccountInfo(new PublicKey(squadsProgram));
  add("Squads v4 program", program?.executable ? "ready" : "blocked", program?.executable ? `${squadsProgram} is executable` : "program account missing or not executable");
  if (solanaAddress) {
    const balance = await connection.getBalance(new PublicKey(solanaAddress));
    add("Solana signer funding", balance > 0 ? "ready" : "unknown", `${solanaAddress} holds ${balance / 1e9} SOL${balance > 0 ? "" : "; the cluster faucet can fund it during the run"}`);
  } else {
    add("Solana signer funding", "ready", "The devnet faucet funds a fresh treasury during the run");
  }
} catch (error) {
  add("Solana devnet RPC", "blocked", error instanceof Error ? error.message.split("\n")[0]! : String(error));
}

const width = Math.max(...report.map((row) => row.check.length));
for (const row of report) console.log(`${row.check.padEnd(width)}  ${row.state.padEnd(7)}  ${row.detail}`);
process.exit(report.some((row) => row.state === "blocked") ? 1 : 0);
