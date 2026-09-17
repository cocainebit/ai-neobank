import * as multisig from "@sqds/multisig";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type Connection,
  type TransactionInstruction
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { SignedTransaction } from "@ai-neobank/chain-core";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";

const { Permission, Permissions } = multisig.types;

export interface SquadsMemberSpec {
  key: string;
  /** Humans own the vault: all permissions. The Relay executor only initiates and executes. */
  role: "owner" | "executor";
}

export interface SquadsObservation {
  multisigPda: string;
  vaultPda: string;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  members: { key: string; canInitiate: boolean; canVote: boolean; canExecute: boolean }[];
}

export interface SquadsProposalObservation {
  transactionIndex: bigint;
  proposalPda: string;
  status: "draft" | "active" | "rejected" | "approved" | "executing" | "executed" | "cancelled";
  approved: string[];
  rejected: string[];
  cancelled: string[];
}

export interface SquadsRef {
  multisigPda: string;
  vaultPda: string;
  transactionIndex: string;
  transactionPda: string;
  proposalPda: string;
}

function permissionsFor(role: SquadsMemberSpec["role"]) {
  return role === "owner" ? Permissions.all() : Permissions.fromPermissions([Permission.Initiate, Permission.Execute]);
}

/**
 * Squads v4 governance over the Solana adapter. Every method builds unsigned
 * instructions or reads chain state; signing and broadcasting go through the
 * adapter's sign-before-broadcast path so a crash is recoverable.
 */
export class SquadsGovernanceAdapter {
  readonly programId: PublicKey;
  private readonly connection: Connection;

  constructor(readonly adapter: SolanaAdapter, programId: PublicKey = multisig.PROGRAM_ID) {
    this.programId = programId;
    this.connection = adapter.rpc;
  }

  static vaultOf(multisigPda: string, index = 0, programId: PublicKey = multisig.PROGRAM_ID): string {
    return multisig.getVaultPda({ multisigPda: new PublicKey(multisigPda), index, programId })[0].toBase58();
  }

  /** Builds the create instruction. `createKey` must sign alongside the creator (fee payer). */
  async prepareCreate(creator: PublicKey, members: SquadsMemberSpec[], threshold: number, createKey: Keypair = Keypair.generate()): Promise<{ instruction: TransactionInstruction; createKey: Keypair; multisigPda: string; vaultPda: string }> {
    if (threshold < 1) throw new Error("Threshold must be at least 1");
    const voters = members.filter((member) => member.role === "owner").length;
    if (threshold > voters) throw new Error("Threshold exceeds the number of voting members");
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey, programId: this.programId });
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0, programId: this.programId });
    const [programConfigPda] = multisig.getProgramConfigPda({ programId: this.programId });
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(this.connection, programConfigPda);
    const instruction = multisig.instructions.multisigCreateV2({
      treasury: programConfig.treasury,
      creator,
      multisigPda,
      configAuthority: null,
      threshold,
      members: members.map((member) => ({ key: new PublicKey(member.key), permissions: permissionsFor(member.role) })),
      timeLock: 0,
      createKey: createKey.publicKey,
      rentCollector: null,
      programId: this.programId
    });
    return { instruction, createKey, multisigPda: multisigPda.toBase58(), vaultPda: vaultPda.toBase58() };
  }

  /** Test and tooling helper: creates a multisig with a locally held creator key. */
  async create(creator: Keypair, members: SquadsMemberSpec[], threshold: number): Promise<{ multisigPda: string; vaultPda: string; signature: string }> {
    const prepared = await this.prepareCreate(creator.publicKey, members, threshold);
    const signed = await this.adapter.signInstructions([prepared.instruction], creator, [prepared.createKey]);
    await this.adapter.broadcast(signed);
    await this.waitFor(signed.hash);
    return { multisigPda: prepared.multisigPda, vaultPda: prepared.vaultPda, signature: signed.hash };
  }

  async observe(multisigPda: string): Promise<SquadsObservation> {
    const pda = new PublicKey(multisigPda);
    const account = await multisig.accounts.Multisig.fromAccountAddress(this.connection, pda, "confirmed");
    return {
      multisigPda,
      vaultPda: multisig.getVaultPda({ multisigPda: pda, index: 0, programId: this.programId })[0].toBase58(),
      threshold: account.threshold,
      timeLock: account.timeLock,
      transactionIndex: BigInt(account.transactionIndex.toString()),
      members: account.members.map((member) => ({
        key: member.key.toBase58(),
        canInitiate: Permissions.has(member.permissions, Permission.Initiate),
        canVote: Permissions.has(member.permissions, Permission.Vote),
        canExecute: Permissions.has(member.permissions, Permission.Execute)
      }))
    };
  }

  private refFor(multisigPda: PublicKey, transactionIndex: bigint): SquadsRef {
    return {
      multisigPda: multisigPda.toBase58(),
      vaultPda: multisig.getVaultPda({ multisigPda, index: 0, programId: this.programId })[0].toBase58(),
      transactionIndex: transactionIndex.toString(),
      transactionPda: multisig.getTransactionPda({ multisigPda, index: transactionIndex, programId: this.programId })[0].toBase58(),
      proposalPda: multisig.getProposalPda({ multisigPda, transactionIndex, programId: this.programId })[0].toBase58()
    };
  }

  /** The vault's transfer as a message the multisig will wrap. */
  private async transferMessage(vaultPda: PublicKey, to: PublicKey, asset: { kind: "native" } | { kind: "spl"; mint: string; decimals: number }, amountBaseUnits: bigint): Promise<TransactionMessage> {
    const instructions: TransactionInstruction[] = [];
    if (asset.kind === "native") {
      instructions.push(SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: to, lamports: amountBaseUnits }));
    } else {
      const mint = new PublicKey(asset.mint);
      const source = getAssociatedTokenAddressSync(mint, vaultPda, true);
      const destination = getAssociatedTokenAddressSync(mint, to, true);
      // The vault pays for the destination's token account if it does not exist yet.
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(vaultPda, destination, to, mint));
      instructions.push(createTransferCheckedInstruction(source, mint, destination, vaultPda, amountBaseUnits, asset.decimals));
    }
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    return new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions });
  }

  /**
   * Instructions for the executor to publish a transfer as vault transaction +
   * proposal at `transactionIndex`. The caller persists the index before
   * broadcasting so a retry can recognise its own proposal.
   */
  async prepareProposal(multisigPda: string, executor: PublicKey, transactionIndex: bigint, to: string, asset: { kind: "native" } | { kind: "spl"; mint: string; decimals: number }, amountBaseUnits: bigint, memo: string): Promise<{ instructions: TransactionInstruction[]; ref: SquadsRef }> {
    const pda = new PublicKey(multisigPda);
    const ref = this.refFor(pda, transactionIndex);
    const message = await this.transferMessage(new PublicKey(ref.vaultPda), new PublicKey(to), asset, amountBaseUnits);
    const create = multisig.instructions.vaultTransactionCreate({ multisigPda: pda, transactionIndex, creator: executor, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo, programId: this.programId });
    const propose = multisig.instructions.proposalCreate({ multisigPda: pda, creator: executor, transactionIndex, programId: this.programId });
    return { instructions: [create, propose], ref };
  }

  /** Simulates the vault transfer itself (as the vault), independent of governance, for intake evidence. */
  async simulateVaultTransfer(multisigPda: string, to: string, asset: { kind: "native" } | { kind: "spl"; mint: string; decimals: number }, amountBaseUnits: bigint) {
    const vaultPda = new PublicKey(SquadsGovernanceAdapter.vaultOf(multisigPda, 0, this.programId));
    const message = await this.transferMessage(vaultPda, new PublicKey(to), asset, amountBaseUnits);
    return this.adapter.simulateInstructions(message.instructions, vaultPda);
  }

  /** Whether the vault transaction at this index exists and was created by `executor`. */
  async publishedBy(multisigPda: string, transactionIndex: bigint, executor: string): Promise<boolean> {
    const ref = this.refFor(new PublicKey(multisigPda), transactionIndex);
    const info = await this.connection.getAccountInfo(new PublicKey(ref.transactionPda), "confirmed");
    if (!info) return false;
    const [account] = multisig.accounts.VaultTransaction.fromAccountInfo(info);
    return account.creator.toBase58() === executor;
  }

  async observeProposal(multisigPda: string, transactionIndex: bigint): Promise<SquadsProposalObservation | null> {
    const ref = this.refFor(new PublicKey(multisigPda), transactionIndex);
    const info = await this.connection.getAccountInfo(new PublicKey(ref.proposalPda), "confirmed");
    if (!info) return null;
    const [proposal] = multisig.accounts.Proposal.fromAccountInfo(info);
    const status = proposal.status.__kind.toLowerCase() as SquadsProposalObservation["status"];
    return {
      transactionIndex,
      proposalPda: ref.proposalPda,
      status,
      approved: proposal.approved.map((key) => key.toBase58()),
      rejected: proposal.rejected.map((key) => key.toBase58()),
      cancelled: proposal.cancelled.map((key) => key.toBase58())
    };
  }

  /**
   * A config transaction and proposal that replaces one member with another,
   * published by an existing member with Initiate permission.
   */
  prepareMemberSwap(multisigPda: string, creator: PublicKey, transactionIndex: bigint, add: SquadsMemberSpec, remove: string, memo: string): { instructions: TransactionInstruction[]; ref: SquadsRef } {
    const pda = new PublicKey(multisigPda);
    const ref = this.refFor(pda, transactionIndex);
    const actions: multisig.types.ConfigAction[] = [
      { __kind: "AddMember", newMember: { key: new PublicKey(add.key), permissions: permissionsFor(add.role) } },
      { __kind: "RemoveMember", oldMember: new PublicKey(remove) }
    ];
    const create = multisig.instructions.configTransactionCreate({ multisigPda: pda, transactionIndex, creator, actions, memo, programId: this.programId });
    const propose = multisig.instructions.proposalCreate({ multisigPda: pda, creator, transactionIndex, programId: this.programId });
    return { instructions: [create, propose], ref };
  }

  /** Whether the config transaction at this index exists and was created by `creator`. */
  async configPublishedBy(multisigPda: string, transactionIndex: bigint, creator: string): Promise<boolean> {
    const ref = this.refFor(new PublicKey(multisigPda), transactionIndex);
    const info = await this.connection.getAccountInfo(new PublicKey(ref.transactionPda), "confirmed");
    if (!info) return false;
    const [account] = multisig.accounts.ConfigTransaction.fromAccountInfo(info);
    return account.creator.toBase58() === creator;
  }

  prepareConfigExecute(multisigPda: string, transactionIndex: bigint, member: PublicKey): TransactionInstruction {
    return multisig.instructions.configTransactionExecute({ multisigPda: new PublicKey(multisigPda), transactionIndex, member, rentPayer: member, programId: this.programId });
  }

  /** Unsigned vote instruction for a member's wallet. */
  voteInstruction(multisigPda: string, transactionIndex: bigint, member: string, decision: "approved" | "rejected"): TransactionInstruction {
    const args = { multisigPda: new PublicKey(multisigPda), transactionIndex, member: new PublicKey(member), programId: this.programId };
    return decision === "approved" ? multisig.instructions.proposalApprove(args) : multisig.instructions.proposalReject(args);
  }

  /** Test and tooling helper: votes with a locally held member key. */
  async vote(multisigPda: string, transactionIndex: bigint, member: Keypair, decision: "approved" | "rejected"): Promise<string> {
    const signed = await this.adapter.signInstructions([this.voteInstruction(multisigPda, transactionIndex, member.publicKey.toBase58(), decision)], member);
    await this.adapter.broadcast(signed);
    await this.waitFor(signed.hash);
    return signed.hash;
  }

  /** Execute instruction plus the lookup tables the wrapped message needs. */
  async prepareExecute(multisigPda: string, transactionIndex: bigint, executor: PublicKey) {
    return multisig.instructions.vaultTransactionExecute({ connection: this.connection, multisigPda: new PublicKey(multisigPda), transactionIndex, member: executor, programId: this.programId });
  }

  async waitFor(signature: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const receipt = await this.adapter.waitForTransaction(signature).catch(() => null);
      if (receipt?.failed) throw new Error(`Transaction ${signature} failed on chain`);
      if (receipt && !receipt.pending) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Transaction ${signature} did not finalize in time`);
  }
}

export type { SignedTransaction };
