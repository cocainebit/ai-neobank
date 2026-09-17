import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { EvmAdapter } from "./index.js";

const rpcUrl = process.env.EVM_RPC_URL;
const testIf = process.env.RUN_CHAIN_INTEGRATION === "1" && rpcUrl ? it : it.skip;
const chainId = 31337;
const chain = defineChain({ id: chainId, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl ?? ""] } } });
const fixture = JSON.parse(readFileSync(new URL("../fixtures/TestToken.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function untilFinal(adapter: EvmAdapter, hash: string, expected?: Parameters<EvmAdapter["waitForTransaction"]>[1]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = await adapter.waitForTransaction(hash, expected).catch(() => null);
    if (receipt?.finalized || receipt?.failed) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Transaction did not finalize in time");
}

async function fund(address: string, amount: bigint) {
  const response = await fetch(rpcUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${amount.toString(16)}`] }) });
  if (!response.ok) throw new Error("anvil_setBalance failed");
}

describe("EVM adapter", () => {
  testIf("signs before broadcast, reaches finality, and proves the destination delta for native and ERC-20 transfers", async () => {
    const adapter = new EvmAdapter({ rpcUrl: rpcUrl!, chainId, network: `eip155:${chainId}`, confirmations: 1 });
    expect((await adapter.health()).ok).toBe(true);
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    await fund(account.address, parseEther("10"));

    // Native
    const native = { from: account.address, to: destination, asset: { kind: "native" as const, decimals: 18 }, amountBaseUnits: parseEther("1"), idempotencyKey: crypto.randomUUID() };
    const simulation = await adapter.simulateTransfer(native);
    expect(simulation.ok).toBe(true);
    expect(simulation.feeBaseUnits).toBeGreaterThan(0n);
    const signed = await adapter.signTransfer(native, key);
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await adapter.broadcastStatus(signed)).toEqual({ state: "unseen_resendable" });
    const submitted = await adapter.broadcast(signed);
    expect(submitted.hash).toBe(signed.hash);
    expect(await adapter.broadcastStatus(signed)).toEqual({ state: "seen" });
    const receipt = await untilFinal(adapter, signed.hash, { to: destination, asset: native.asset, amountBaseUnits: native.amountBaseUnits });
    expect(receipt.finalized).toBe(true);
    expect(receipt.failed).toBe(false);
    expect(receipt.destinationDeltaBaseUnits).toBe(parseEther("1"));
    expect(receipt.feeBaseUnits).toBeGreaterThan(0n);
    expect(await adapter.getNativeBalance(destination)).toBe(parseEther("1"));

    // A second signed transaction with the same nonce that is never sent becomes dead once the nonce is used.
    const stale = await adapter.signTransfer({ ...native, idempotencyKey: crypto.randomUUID() }, key);
    const replacement = await adapter.signTransfer({ ...native, amountBaseUnits: parseEther("0.5"), idempotencyKey: crypto.randomUUID() }, key);
    expect(stale.nonce).toBe(replacement.nonce);
    await adapter.broadcast(replacement);
    await untilFinal(adapter, replacement.hash);
    const dead = await adapter.broadcastStatus(stale);
    expect(dead.state).toBe("unseen_dead");

    // ERC-20
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployHash = await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const token = deployReceipt.contractAddress as Address;
    const mintHash = await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [account.address, 5_000_000n], account });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    expect(await adapter.readTokenDecimals(token)).toBe(6);
    const erc20 = { from: account.address, to: destination, asset: { kind: "erc20" as const, address: token, decimals: 6 }, amountBaseUnits: 1_250_000n, idempotencyKey: crypto.randomUUID() };
    const tooMuch = await adapter.simulateTransfer({ ...erc20, amountBaseUnits: 6_000_000n });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.error).toContain("balance");
    const tokenSimulation = await adapter.simulateTransfer(erc20);
    expect(tokenSimulation.ok).toBe(true);
    const tokenSigned = await adapter.signTransfer(erc20, key);
    await adapter.broadcast(tokenSigned);
    const tokenReceipt = await untilFinal(adapter, tokenSigned.hash, { to: destination, asset: erc20.asset, amountBaseUnits: erc20.amountBaseUnits });
    expect(tokenReceipt.finalized).toBe(true);
    expect(tokenReceipt.destinationDeltaBaseUnits).toBe(1_250_000n);
    expect(await adapter.getBalance(destination, erc20.asset)).toBe(1_250_000n);
    expect(await adapter.getBalance(account.address, erc20.asset)).toBe(3_750_000n);
  }, 60_000);
});
