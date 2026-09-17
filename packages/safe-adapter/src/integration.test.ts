import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { EvmAdapter } from "@ai-neobank/evm-adapter";
import { deploySafeProtocolFixture, recoverSafeSigner, SafeGovernanceAdapter } from "./index.js";

const rpcUrl = process.env.EVM_RPC_URL;
const testIf = process.env.RUN_SAFE_INTEGRATION === "1" && rpcUrl ? it : it.skip;
const chainId = 31337;
const chain = defineChain({ id: chainId, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl ?? ""] } } });
const fixture = JSON.parse(readFileSync(new URL("../../evm-adapter/fixtures/TestToken.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function setBalance(address: string, amount: bigint) {
  const response = await fetch(rpcUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${amount.toString(16)}`] }) });
  if (!response.ok) throw new Error("Unable to fund local account");
}

async function untilFinal(adapter: EvmAdapter, hash: string, expected?: Parameters<EvmAdapter["waitForTransaction"]>[1]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = await adapter.waitForTransaction(hash, expected).catch(() => null);
    if (receipt?.finalized || receipt?.failed) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Transaction did not finalize in time");
}

describe("Safe governance adapter", () => {
  testIf("owners sign typed data off chain; a non-owner executor submits; threshold is enforced by the Safe", async () => {
    const ownerKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
    const ownerAccounts = ownerKeys.map((key) => privateKeyToAccount(key));
    const executorKey = generatePrivateKey();
    const executor = privateKeyToAccount(executorKey);
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    await setBalance(ownerAccounts[0]!.address, parseEther("100"));
    await setBalance(executor.address, parseEther("10"));
    const contracts = await deploySafeProtocolFixture(rpcUrl!, chainId, ownerKeys[0]!);
    const safe = new SafeGovernanceAdapter({ rpcUrl: rpcUrl!, chainId, contracts });
    const evm = new EvmAdapter({ rpcUrl: rpcUrl!, chainId, network: `eip155:${chainId}` });

    const prepared = await safe.prepareDeployment(ownerAccounts.map((account) => account.address), 2, "4242");
    const deployment = await safe.deploy(ownerKeys[0]!, ownerAccounts.map((account) => account.address), 2, "4242");
    expect(deployment.address).toBe(prepared.address);
    const wallet = createWalletClient({ account: ownerAccounts[0]!, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: ownerAccounts[0]!, to: deployment.address as Address, value: parseEther("5") }) });
    const observed = await safe.observe(deployment.address);
    expect(observed.threshold).toBe(2);
    expect(observed.owners.map((owner) => owner.toLowerCase())).not.toContain(executor.address.toLowerCase());

    // Native transfer: compile at the current nonce, two owners sign typed data, executor (not an owner) executes.
    const compiled = await safe.compileTransfer(deployment.address, { kind: "native" }, destination, parseEther("1"));
    expect(compiled.nonce).toBe(0);
    const first = await safe.signTypedDataFor(deployment.address, compiled, ownerKeys[0]!);
    expect((await recoverSafeSigner(compiled.safeTxHash, first.signature)).toLowerCase()).toBe(ownerAccounts[0]!.address.toLowerCase());
    const notOwner = await safe.signTypedDataFor(deployment.address, compiled, executorKey);
    expect(observed.owners.map((owner) => owner.toLowerCase())).not.toContain((await recoverSafeSigner(compiled.safeTxHash, notOwner.signature)).toLowerCase());

    // One signature: the Safe itself reverts (GS020 style), proven on chain rather than by the SDK.
    const underSigned = await evm.simulateCall({ from: executor.address, to: deployment.address, data: safe.encodeExecution(compiled, [first]) });
    expect(underSigned.ok).toBe(false);
    const second = await safe.signTypedDataFor(deployment.address, compiled, ownerKeys[2]!);
    const calldata = safe.encodeExecution(compiled, [second, first]);
    expect((await evm.simulateCall({ from: executor.address, to: deployment.address, data: calldata })).ok).toBe(true);
    const signed = await evm.signCall({ from: executor.address, to: deployment.address, data: calldata }, executorKey);
    await evm.broadcast(signed);
    const receipt = await untilFinal(evm, signed.hash, { to: destination, asset: { kind: "native", decimals: 18 }, amountBaseUnits: parseEther("1") });
    expect(receipt.finalized).toBe(true);
    expect(receipt.destinationDeltaBaseUnits).toBe(parseEther("1"));
    expect(await publicClient.getBalance({ address: destination })).toBe(parseEther("1"));
    expect((await safe.observe(deployment.address)).nonce).toBe(1);

    // Replay of the same signed transaction is refused by the Safe (nonce moved).
    expect((await evm.simulateCall({ from: executor.address, to: deployment.address, data: calldata })).ok).toBe(false);

    // ERC-20 transfer through the Safe, evidenced by the token's Transfer log.
    const deployHash = await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: ownerAccounts[0]! });
    const token = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [deployment.address, 5_000_000n], account: ownerAccounts[0]! }) });
    const tokenCompiled = await safe.compileTransfer(deployment.address, { kind: "erc20", address: token }, destination, 1_250_000n);
    expect(tokenCompiled.nonce).toBe(1);
    const tokenSignatures = [await safe.signTypedDataFor(deployment.address, tokenCompiled, ownerKeys[1]!), await safe.signTypedDataFor(deployment.address, tokenCompiled, ownerKeys[2]!)];
    const tokenSigned = await evm.signCall({ from: executor.address, to: deployment.address, data: safe.encodeExecution(tokenCompiled, tokenSignatures) }, executorKey);
    await evm.broadcast(tokenSigned);
    const tokenReceipt = await untilFinal(evm, tokenSigned.hash, { to: destination, asset: { kind: "erc20", address: token, decimals: 6 }, amountBaseUnits: 1_250_000n });
    expect(tokenReceipt.finalized).toBe(true);
    expect(tokenReceipt.destinationDeltaBaseUnits).toBe(1_250_000n);
    expect(await evm.getBalance(destination, { kind: "erc20", address: token, decimals: 6 })).toBe(1_250_000n);
  }, 90_000);
});
