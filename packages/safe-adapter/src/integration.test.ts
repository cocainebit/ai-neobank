import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deploySafeProtocolFixture, SafeGovernanceAdapter } from "./index.js";

const testIf = process.env.RUN_SAFE_INTEGRATION === "1" ? it : it.skip;

describe("Safe governance adapter", () => {
  testIf("deploys a 2-of-3 Safe and executes only after two owner signatures", async () => {
    const rpcUrl = process.env.EVM_RPC_URL;
    if (!rpcUrl) throw new Error("EVM_RPC_URL is required");
    const chainId = 31337;
    const chain = defineChain({ id: chainId, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const ownerKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
    const ownerAccounts = ownerKeys.map((key) => privateKeyToAccount(key));
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    const setBalance = async (address: string, amount: bigint) => {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${amount.toString(16)}`] }) });
      if (!response.ok) throw new Error("Unable to fund local account");
    };
    await setBalance(ownerAccounts[0]!.address, parseEther("100"));
    const contracts = await deploySafeProtocolFixture(rpcUrl, chainId, ownerKeys[0]!);
    const adapter = new SafeGovernanceAdapter({ rpcUrl, chainId, contracts });
    const deployment = await adapter.deploy(ownerKeys[0]!, ownerAccounts.map((account) => account.address), 2, "4242");
    const wallet = createWalletClient({ account: ownerAccounts[0]!, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const fundingHash = await wallet.sendTransaction({ account: ownerAccounts[0]!, to: deployment.address as `0x${string}`, value: parseEther("5") });
    await publicClient.waitForTransactionReceipt({ hash: fundingHash });
    const observed = await adapter.observe(deployment.address);
    expect(observed.threshold).toBe(2);
    expect(observed.owners.map((owner) => owner.toLowerCase()).sort()).toEqual(ownerAccounts.map((owner) => owner.address.toLowerCase()).sort());
    expect(observed.modules).toEqual([]);
    const transfer = await adapter.buildNativeTransfer(deployment.address, ownerKeys[0]!, destination, parseEther("1"));
    await adapter.collectSignatures(deployment.address, transfer.transaction, transfer.safeTransactionHash, [ownerKeys[0]!]);
    await expect(adapter.execute(deployment.address, ownerKeys[0]!, transfer.transaction)).rejects.toThrow();
    await adapter.collectSignatures(deployment.address, transfer.transaction, transfer.safeTransactionHash, [ownerKeys[1]!]);
    const executed = await adapter.execute(deployment.address, ownerKeys[0]!, transfer.transaction);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: executed.transactionHash as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(await publicClient.getBalance({ address: destination })).toBe(parseEther("1"));
    expect((await adapter.observe(deployment.address)).nonce).toBe(1);
  }, 60_000);
});
