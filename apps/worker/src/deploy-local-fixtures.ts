/**
 * Local Anvil fixtures, deployed once and recorded in .local/local-fixtures.json:
 * the Safe 1.4.1 singletons (public networks use the canonical deployments Protocol
 * Kit already knows) and a six-decimal test token so token transfers, invoices, and
 * x402 can be exercised on a local chain. Local-only by design.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploySafeProtocolFixture, type SafeContractAddresses } from "@ai-neobank/safe-adapter";

interface Fixtures {
  safe: SafeContractAddresses;
  token: { address: Address; symbol: string; decimals: number };
  /** An EIP-3009 token with ERC-1271 support, so x402 (including from a Safe) can be exercised locally. */
  x402Token: { address: Address; symbol: string; decimals: number };
}

const rpcUrl = process.env.EVM_RPC_URL ?? "http://127.0.0.1:8722";
const output = new URL("../../../.local/local-fixtures.json", import.meta.url);
// Anvil's first default account: a published key, funded only on local chains.
const anvilKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const erc20 = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestToken.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
const erc3009 = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

const client = createPublicClient({ transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (chainId !== 31337) throw new Error(`Refusing to deploy fixtures to chain ${chainId}; this script is for local Anvil only`);

const existing = await readExisting();
if (existing) {
  console.log(`Local fixtures already deployed; Safe singleton ${existing.safe.safeSingletonAddress}, token ${existing.token.address}`);
  process.exit(0);
}

const account = privateKeyToAccount(anvilKey);
const chain = { id: chainId, name: "Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const safe = await deploySafeProtocolFixture(rpcUrl, chainId, anvilKey);
const deployHash = await wallet.deployContract({ abi: erc20.abi as never, bytecode: erc20.bytecode, account, chain });
const token = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
// A large float held by the faucet account, so the dev faucet can hand out test dollars.
const mintHash = await wallet.writeContract({ address: token, abi: erc20.abi as never, functionName: "mint", args: [account.address, 100_000_000_000n], account, chain });
await client.waitForTransactionReceipt({ hash: mintHash });
const [symbol, decimals] = await Promise.all([
  client.readContract({ address: token, abi: erc20.abi as never, functionName: "symbol" }) as Promise<string>,
  client.readContract({ address: token, abi: erc20.abi as never, functionName: "decimals" }) as Promise<number>
]);

const x402Hash = await wallet.deployContract({ abi: erc3009.abi as never, bytecode: erc3009.bytecode, account, chain });
const x402Token = (await client.waitForTransactionReceipt({ hash: x402Hash })).contractAddress as Address;
const x402MintHash = await wallet.writeContract({ address: x402Token, abi: erc3009.abi as never, functionName: "mint", args: [account.address, 100_000_000_000n], account, chain });
await client.waitForTransactionReceipt({ hash: x402MintHash });
const [x402Symbol, x402Decimals] = await Promise.all([
  client.readContract({ address: x402Token, abi: erc3009.abi as never, functionName: "symbol" }) as Promise<string>,
  client.readContract({ address: x402Token, abi: erc3009.abi as never, functionName: "decimals" }) as Promise<number>
]);

const fixtures: Fixtures = { safe, token: { address: token, symbol, decimals }, x402Token: { address: x402Token, symbol: x402Symbol, decimals: x402Decimals } };
writeFileSync(output, JSON.stringify(fixtures, null, 2));
console.log(`Deployed Safe contracts (singleton ${safe.safeSingletonAddress}), ${symbol} at ${token}, and the EIP-3009 token at ${x402Token}`);

async function readExisting(): Promise<Fixtures | null> {
  let parsed: Fixtures;
  try { parsed = JSON.parse(readFileSync(output, "utf8")) as Fixtures; } catch { return null; }
  if (!parsed.safe?.safeSingletonAddress || !parsed.token?.address || !parsed.x402Token?.address) return null;
  const [safeCode, tokenCode, x402Code] = await Promise.all([client.getCode({ address: parsed.safe.safeSingletonAddress as Address }), client.getCode({ address: parsed.token.address }), client.getCode({ address: parsed.x402Token.address })]);
  return [safeCode, tokenCode, x402Code].every((code) => code && code !== "0x") ? parsed : null;
}
