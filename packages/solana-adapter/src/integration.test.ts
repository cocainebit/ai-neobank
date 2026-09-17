import { describe, expect, it } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaAdapter } from "./index.js";

const enabled = process.env.RUN_CHAIN_INTEGRATION === "1";
const testIf = enabled ? it : it.skip;

describe("Solana adapter against solana-test-validator", () => {
  testIf("simulates, sends, confirms, and reconciles a native transfer", async () => {
    const rpcUrl = "http://127.0.0.1:8899";
    const connection = new Connection(rpcUrl, "confirmed");
    const signer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const airdrop = await connection.requestAirdrop(signer.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop, "confirmed");
    const adapter = new SolanaAdapter({ rpcUrl, network: "solana:localnet" });
    const request = {
      from: signer.publicKey.toBase58(),
      to: recipient.toBase58(),
      amountBaseUnits: 100_000_000n,
      idempotencyKey: "solana-transfer-001"
    };

    expect((await adapter.health()).ok).toBe(true);
    expect((await adapter.simulateNativeTransfer(request)).ok).toBe(true);
    const submitted = await adapter.sendNativeTransfer(request, signer);
    expect((await adapter.waitForTransaction(submitted.hash)).finalized).toBe(true);
    expect(await adapter.getNativeBalance(recipient.toBase58())).toBe(request.amountBaseUnits);
  }, 30_000);
});
