import { describe, expect, it } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { isSquadsConfigTransaction, prepareSquadsTimeLockChange, SquadsGovernanceAdapter } from "./index.js";

const rpcUrl = process.env.SOLANA_RPC_URL;
const testIf = process.env.RUN_SQUADS_INTEGRATION === "1" && rpcUrl ? it : it.skip;

async function airdrop(connection: Connection, address: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
}

describe("Squads governance adapter", () => {
  testIf("executor publishes, members vote on chain, executor executes; the executor cannot vote", async () => {
    const adapter = new SolanaAdapter({ rpcUrl: rpcUrl!, network: "solana:localnet", finality: "confirmed" });
    const squads = new SquadsGovernanceAdapter(adapter);
    const connection = adapter.rpc;
    const creator = Keypair.generate();
    const members = [Keypair.generate(), Keypair.generate()];
    const executor = Keypair.generate();
    const destination = Keypair.generate().publicKey;
    await Promise.all([airdrop(connection, creator.publicKey, 5), airdrop(connection, members[0]!.publicKey, 2), airdrop(connection, members[1]!.publicKey, 2), airdrop(connection, executor.publicKey, 2)]);

    const created = await squads.create(creator, [
      { key: members[0]!.publicKey.toBase58(), role: "owner" },
      { key: members[1]!.publicKey.toBase58(), role: "owner" },
      { key: executor.publicKey.toBase58(), role: "executor" }
    ], 2);
    const observed = await squads.observe(created.multisigPda);
    expect(observed.threshold).toBe(2);
    expect(observed.vaultPda).toBe(created.vaultPda);
    expect(observed.members.find((member) => member.key === executor.publicKey.toBase58())).toMatchObject({ canInitiate: true, canVote: false, canExecute: true });
    await airdrop(connection, new PublicKey(created.vaultPda), 3);

    // Intake evidence: the vault transfer simulates as the vault, and an oversized one does not.
    expect((await squads.simulateVaultTransfer(created.multisigPda, destination.toBase58(), { kind: "native" }, 1_000_000n)).ok).toBe(true);
    expect((await squads.simulateVaultTransfer(created.multisigPda, destination.toBase58(), { kind: "native" }, BigInt(50 * LAMPORTS_PER_SOL))).ok).toBe(false);

    // Publish at the next index; the executor holds only Initiate + Execute.
    const index = observed.transactionIndex + 1n;
    const proposal = await squads.prepareProposal(created.multisigPda, executor.publicKey, index, destination.toBase58(), { kind: "native" }, 1_000_000n, "relay intent test");
    expect(await squads.publishedBy(created.multisigPda, index, executor.publicKey.toBase58())).toBe(false);
    const published = await adapter.signInstructions(proposal.instructions, executor);
    await adapter.broadcast(published);
    await squads.waitFor(published.hash);
    expect(await squads.publishedBy(created.multisigPda, index, executor.publicKey.toBase58())).toBe(true);
    expect((await squads.observeProposal(created.multisigPda, index))?.status).toBe("active");

    // The executor's vote is rejected by the program.
    const executorVote = await adapter.signInstructions([squads.voteInstruction(created.multisigPda, index, executor.publicKey.toBase58(), "approved")], executor);
    await expect(adapter.broadcast(executorVote)).rejects.toThrow();
    // Executing before quorum is rejected by the program.
    const early = await squads.prepareExecute(created.multisigPda, index, executor.publicKey);
    const earlySigned = await adapter.signInstructions([early.instruction], executor, [], early.lookupTableAccounts);
    await expect(adapter.broadcast(earlySigned)).rejects.toThrow();

    // Members vote on chain; the proposal reaches Approved at the threshold.
    await squads.vote(created.multisigPda, index, members[0]!, "approved");
    expect((await squads.observeProposal(created.multisigPda, index))?.approved).toEqual([members[0]!.publicKey.toBase58()]);
    await squads.vote(created.multisigPda, index, members[1]!, "approved");
    const approved = await squads.observeProposal(created.multisigPda, index);
    expect(approved?.status).toBe("approved");
    expect(approved?.approved).toHaveLength(2);

    // Executor executes; destination delta proven from the executed transaction.
    const execute = await squads.prepareExecute(created.multisigPda, index, executor.publicKey);
    const executed = await adapter.signInstructions([execute.instruction], executor, [], execute.lookupTableAccounts);
    await adapter.broadcast(executed);
    await squads.waitFor(executed.hash);
    const receipt = await adapter.waitForTransaction(executed.hash, { to: destination.toBase58(), asset: { kind: "native", decimals: 9 }, amountBaseUnits: 1_000_000n });
    expect(receipt.failed).toBe(false);
    expect(receipt.destinationDeltaBaseUnits).toBe(1_000_000n);
    expect(await connection.getBalance(destination, "confirmed")).toBe(1_000_000);
    expect((await squads.observeProposal(created.multisigPda, index))?.status).toBe("executed");

    // SPL through the vault: the vault pays for the destination token account and transfers.
    const mint = await createMint(connection, creator, creator.publicKey, null, 6);
    const vaultAta = await getOrCreateAssociatedTokenAccount(connection, creator, mint, new PublicKey(created.vaultPda), true);
    await mintTo(connection, creator, mint, vaultAta.address, creator, 5_000_000n);
    const splIndex = index + 1n;
    const splAsset = { kind: "spl" as const, mint: mint.toBase58(), decimals: 6 };
    expect((await squads.simulateVaultTransfer(created.multisigPda, destination.toBase58(), splAsset, 1_250_000n)).ok).toBe(true);
    const splProposal = await squads.prepareProposal(created.multisigPda, executor.publicKey, splIndex, destination.toBase58(), splAsset, 1_250_000n, "relay spl");
    const splPublished = await adapter.signInstructions(splProposal.instructions, executor);
    await adapter.broadcast(splPublished);
    await squads.waitFor(splPublished.hash);
    await squads.vote(created.multisigPda, splIndex, members[0]!, "approved");
    await squads.vote(created.multisigPda, splIndex, members[1]!, "approved");
    const splExecute = await squads.prepareExecute(created.multisigPda, splIndex, executor.publicKey);
    const splExecuted = await adapter.signInstructions([splExecute.instruction], executor, [], splExecute.lookupTableAccounts);
    await adapter.broadcast(splExecuted);
    await squads.waitFor(splExecuted.hash);
    const splReceipt = await adapter.waitForTransaction(splExecuted.hash, { to: destination.toBase58(), asset: splAsset, amountBaseUnits: 1_250_000n });
    expect(splReceipt.destinationDeltaBaseUnits).toBe(1_250_000n);
    expect(await adapter.getBalance(destination.toBase58(), splAsset)).toBe(1_250_000n);

    // A rejected proposal never becomes executable.
    const rejectIndex = splIndex + 1n;
    const rejectProposal = await squads.prepareProposal(created.multisigPda, executor.publicKey, rejectIndex, destination.toBase58(), { kind: "native" }, 1n, "reject me");
    const rejectPublished = await adapter.signInstructions(rejectProposal.instructions, executor);
    await adapter.broadcast(rejectPublished);
    await squads.waitFor(rejectPublished.hash);
    await squads.vote(created.multisigPda, rejectIndex, members[0]!, "rejected");
    expect((await squads.observeProposal(created.multisigPda, rejectIndex))?.status).toBe("rejected");

    // A config change and a payment sit at indices on the same multisig, and only the account behind the index tells them apart.
    const configIndex = rejectIndex + 1n;
    const change = prepareSquadsTimeLockChange(created.multisigPda, members[0]!.publicKey.toBase58(), configIndex, 3600, "relay time lock");
    const changePublished = await adapter.signInstructions(change.instructions, members[0]!);
    await adapter.broadcast(changePublished);
    await squads.waitFor(changePublished.hash);
    expect(await isSquadsConfigTransaction(connection, created.multisigPda, configIndex)).toBe(true);
    for (const paymentIndex of [index, splIndex, rejectIndex]) {
      expect(await isSquadsConfigTransaction(connection, created.multisigPda, paymentIndex)).toBe(false);
      expect((await squads.observeProposal(created.multisigPda, paymentIndex))).not.toBeNull();
    }
    expect(await isSquadsConfigTransaction(connection, created.multisigPda, configIndex + 1n)).toBe(false);
    void SystemProgram;
  }, 180_000);
});
