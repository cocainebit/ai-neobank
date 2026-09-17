import { describe, expect, it } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { SolanaAdapter } from "./index.js";

const rpcUrl = process.env.SOLANA_RPC_URL;
const testIf = process.env.RUN_CHAIN_INTEGRATION === "1" && rpcUrl ? it : it.skip;

async function airdrop(connection: Connection, address: PublicKey, lamports: number) {
  const signature = await connection.requestAirdrop(address, lamports);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function untilFinal(adapter: SolanaAdapter, hash: string, expected: Parameters<SolanaAdapter["waitForTransaction"]>[1]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = await adapter.waitForTransaction(hash, expected).catch(() => null);
    if (receipt?.finalized || receipt?.failed) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Transaction did not finalize in time");
}

describe("Solana adapter", () => {
  testIf("signs before broadcast, reaches finalized commitment, and proves the destination delta for SOL and SPL transfers", async () => {
    const adapter = new SolanaAdapter({ rpcUrl: rpcUrl!, network: "solana:localnet", finality: "finalized" });
    const connection = new Connection(rpcUrl!, "confirmed");
    expect((await adapter.health()).ok).toBe(true);
    const signer = Keypair.generate();
    const destination = Keypair.generate().publicKey;
    await airdrop(connection, signer.publicKey, 5 * LAMPORTS_PER_SOL);

    // Native
    const native = { from: signer.publicKey.toBase58(), to: destination.toBase58(), asset: { kind: "native" as const, decimals: 9 }, amountBaseUnits: 1_000_000n, idempotencyKey: crypto.randomUUID() };
    const simulation = await adapter.simulateTransfer(native);
    expect(simulation.ok).toBe(true);
    expect(simulation.feeBaseUnits).toBeGreaterThan(0n);
    const insufficient = await adapter.simulateTransfer({ ...native, amountBaseUnits: BigInt(100 * LAMPORTS_PER_SOL) });
    expect(insufficient.ok).toBe(false);
    const signed = await adapter.signTransfer(native, signer);
    expect(await adapter.broadcastStatus(signed)).toEqual({ state: "unseen_resendable" });
    const submitted = await adapter.broadcast(signed);
    expect(submitted.hash).toBe(signed.hash);
    const receipt = await untilFinal(adapter, signed.hash, { to: destination.toBase58(), asset: native.asset, amountBaseUnits: native.amountBaseUnits });
    expect(receipt.finalized).toBe(true);
    expect(receipt.destinationDeltaBaseUnits).toBe(1_000_000n);
    expect(receipt.feeBaseUnits).toBeGreaterThan(0n);
    expect(await adapter.broadcastStatus(signed)).toEqual({ state: "seen" });
    expect(await adapter.getNativeBalance(destination.toBase58())).toBe(1_000_000n);

    // SPL
    const mint = await createMint(connection, signer, signer.publicKey, null, 6);
    const sourceAccount = await getOrCreateAssociatedTokenAccount(connection, signer, mint, signer.publicKey);
    await mintTo(connection, signer, mint, sourceAccount.address, signer, 5_000_000n);
    expect(await adapter.readMintDecimals(mint.toBase58())).toBe(6);
    const spl = { from: signer.publicKey.toBase58(), to: destination.toBase58(), asset: { kind: "spl" as const, mint: mint.toBase58(), decimals: 6 }, amountBaseUnits: 1_250_000n, idempotencyKey: crypto.randomUUID() };
    expect(await adapter.getBalance(destination.toBase58(), spl.asset)).toBe(0n);
    const tooMuch = await adapter.simulateTransfer({ ...spl, amountBaseUnits: 6_000_000n });
    expect(tooMuch.ok).toBe(false);
    const splSimulation = await adapter.simulateTransfer(spl);
    expect(splSimulation.ok).toBe(true);
    const splSigned = await adapter.signTransfer(spl, signer);
    await adapter.broadcast(splSigned);
    const splReceipt = await untilFinal(adapter, splSigned.hash, { to: destination.toBase58(), asset: spl.asset, amountBaseUnits: spl.amountBaseUnits });
    expect(splReceipt.finalized).toBe(true);
    expect(splReceipt.destinationDeltaBaseUnits).toBe(1_250_000n);
    expect(await adapter.getBalance(destination.toBase58(), spl.asset)).toBe(1_250_000n);
    expect(await adapter.getBalance(signer.publicKey.toBase58(), spl.asset)).toBe(3_750_000n);
  }, 120_000);
});
