import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { EvmAdapter } from "./index.js";

const enabled = process.env.RUN_CHAIN_INTEGRATION === "1";
const testIf = enabled ? it : it.skip;

describe("EVM adapter against Anvil", () => {
  testIf("simulates, sends, confirms, and reconciles a native transfer", async () => {
    const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const from = privateKeyToAccount(privateKey).address;
    const to = "0x000000000000000000000000000000000000bEEF";
    const adapter = new EvmAdapter({ rpcUrl: "http://127.0.0.1:8545", chainId: 31337, network: "eip155:31337" });
    const before = await adapter.getNativeBalance(to);
    const request = { from, to, amountBaseUnits: 1_000_000_000_000_000n, idempotencyKey: "anvil-transfer-001" };

    expect((await adapter.health()).ok).toBe(true);
    expect((await adapter.simulateNativeTransfer(request)).ok).toBe(true);
    const submitted = await adapter.sendNativeTransfer(request, privateKey);
    const receipt = await adapter.waitForTransaction(submitted.hash);
    expect(receipt.finalized).toBe(true);
    expect(await adapter.getNativeBalance(to)).toBe(before + request.amountBaseUnits);
  }, 20_000);
});
