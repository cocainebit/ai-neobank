import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { X402PaymentClient, X402QuoteError, solanaWireNetwork } from "./index.js";
import { createLocalFacilitator, startLocalSeller } from "./testing.js";

const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const evmTestIf = process.env.RUN_X402_INTEGRATION === "1" && evmRpc ? it : it.skip;
const solanaTestIf = process.env.RUN_X402_INTEGRATION === "1" && solanaRpc ? it : it.skip;
const fixture = JSON.parse(readFileSync(new URL("../../evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function setBalance(address: string, amount: bigint) {
  await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${amount.toString(16)}`] }) });
}

describe("x402 exact on EVM", () => {
  evmTestIf("quotes a 402, pays with an EIP-3009 authorization settled by the facilitator, and cannot pay twice", async () => {
    const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const deployerKey = generatePrivateKey();
    const deployer = privateKeyToAccount(deployerKey);
    const facilitatorKey = generatePrivateKey();
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    await Promise.all([setBalance(deployer.address, parseEther("10")), setBalance(privateKeyToAccount(facilitatorKey).address, parseEther("10"))]);
    const wallet = createWalletClient({ account: deployer, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const deployHash = await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: deployer });
    const token = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [payer.address, 5_000_000n], account: deployer }) });

    const facilitator = await createLocalFacilitator({ evm: { rpcUrl: evmRpc!, chainId: 31337, privateKey: facilitatorKey } });
    const seller = await startLocalSeller(facilitator.client, [
      { route: "GET /report", network: "eip155:31337", payTo: payee, asset: token, amount: "250000", extra: { name: "Test USD", version: "2" }, body: { report: "market data", pages: 3 } }
    ], { evm: { rpcUrl: evmRpc! } });
    try {
      const client = new X402PaymentClient({ evm: { network: "eip155:31337", chainId: 31337, rpcUrl: evmRpc! } });
      await expect(client.quote({ url: `${seller.url}/report` }, { chainFamily: "evm", network: "eip155:31337", assetAddress: token, maxAmountBaseUnits: 100_000n })).rejects.toMatchObject({ code: "exceeds_max" });
      await expect(client.quote({ url: `${seller.url}/report` }, { chainFamily: "evm", network: "eip155:31337", assetAddress: payee, maxAmountBaseUnits: 1_000_000n })).rejects.toBeInstanceOf(X402QuoteError);
      const quote = await client.quote({ url: `${seller.url}/report` }, { chainFamily: "evm", network: "eip155:31337", assetAddress: token, maxAmountBaseUnits: 1_000_000n });
      expect(quote.requirements.amount).toBe("250000");
      expect(quote.requirements.payTo.toLowerCase()).toBe(payee.toLowerCase());
      expect(X402PaymentClient.quoteHash(quote)).toBe(X402PaymentClient.quoteHash(quote));

      const payload = await client.createPayload(quote, { evmPrivateKey: payerKey });
      const nonce = (payload.payload as { authorization: { nonce: string } }).authorization.nonce;
      expect(X402PaymentClient.payloadId(payload)).toBe(`eip3009:${nonce}`);
      expect(await client.evmAuthorizationUsed(token, payer.address, nonce)).toBe(false);
      expect(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [payee] })).toBe(0n);

      const paid = await client.pay(quote, payload);
      expect(paid.status).toBe(200);
      expect(paid.settle?.success).toBe(true);
      expect(paid.settle?.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      expect(paid.bodyPreview).toContain("market data");
      expect(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [payee] })).toBe(250_000n);
      expect(await client.evmAuthorizationUsed(token, payer.address, nonce)).toBe(true);
      const found = await client.findEvmSettlement(token, payer.address, payee);
      expect(found?.transactionHash).toBe(paid.settle?.transaction);
      expect(found?.amount).toBe(250_000n);

      // Replaying the same payload cannot pay again: the nonce is spent.
      const replay = await client.pay(quote, payload);
      expect(replay.status).toBe(402);
      expect(replay.refusal).toBeTruthy();
      expect(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [payee] })).toBe(250_000n);
    } finally {
      await seller.close();
    }
  }, 90_000);
});

describe("x402 exact on Solana", () => {
  solanaTestIf("quotes a 402, pays with a co-signed SPL transfer settled by the facilitator, and cannot pay twice", async () => {
    const connection = new Connection(solanaRpc!, "confirmed");
    const airdrop = async (address: PublicKey, sol: number) => {
      const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    };
    const mintAuthority = Keypair.generate();
    const facilitator = Keypair.generate();
    const payer = Keypair.generate();
    const payee = Keypair.generate();
    await Promise.all([airdrop(mintAuthority.publicKey, 5), airdrop(facilitator.publicKey, 5), airdrop(payer.publicKey, 2)]);
    const mint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
    const payerAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, payer.publicKey);
    await mintTo(connection, mintAuthority, mint, payerAta.address, mintAuthority, 5_000_000n);
    // The seller's token account exists before payment; the facilitator only sponsors fees.
    await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, payee.publicKey);
    const wireNetwork = await solanaWireNetwork("solana:localnet", solanaRpc!);
    expect(wireNetwork).toMatch(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/);

    const local = await createLocalFacilitator({ solana: { rpcUrl: solanaRpc!, wireNetwork, secretKey: facilitator.secretKey } });
    const seller = await startLocalSeller(local.client, [
      { route: "GET /inference", network: wireNetwork, payTo: payee.publicKey.toBase58(), asset: mint.toBase58(), amount: "125000", body: { tokens: 512 } }
    ], { solana: { rpcUrl: solanaRpc!, wireNetwork } });
    try {
      const client = new X402PaymentClient({ solana: { network: "solana:localnet", wireNetwork, rpcUrl: solanaRpc! } });
      const quote = await client.quote({ url: `${seller.url}/inference` }, { chainFamily: "svm", network: "solana:localnet", assetAddress: mint.toBase58(), maxAmountBaseUnits: 1_000_000n });
      expect(quote.requirements.amount).toBe("125000");
      expect(quote.requirements.extra.feePayer).toBe(facilitator.publicKey.toBase58());
      const payload = await client.createPayload(quote, { solanaSecretKey: payer.secretKey });
      expect(X402PaymentClient.payloadId(payload)).toMatch(/^svm:[0-9a-f]{64}$/);
      const paid = await client.pay(quote, payload);
      expect(paid.status).toBe(200);
      expect(paid.settle?.success).toBe(true);
      expect(paid.bodyPreview).toContain("512");
      const payeeAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, payee.publicKey);
      expect((await connection.getTokenAccountBalance(payeeAta.address, "confirmed")).value.amount).toBe("125000");
      const found = await client.findSolanaSettlement(mint.toBase58(), payer.publicKey.toBase58(), payee.publicKey.toBase58());
      expect(found?.transactionHash).toBe(paid.settle?.transaction);
      expect(found?.amount).toBe(125_000n);
      const replay = await client.pay(quote, payload);
      expect(replay.status).toBe(402);
      expect((await connection.getTokenAccountBalance(payeeAta.address, "confirmed")).value.amount).toBe("125000");
    } finally {
      await seller.close();
    }
  }, 120_000);
});
