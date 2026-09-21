import { describe, expect, it } from "vitest";
import * as multisig from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";
import { prepareSquadsTimeLockChange, squadsProposalCancelInstruction, squadsRefFor } from "./index.js";

const multisigPda = multisig.getMultisigPda({ createKey: new PublicKey("11111111111111111111111111111112") })[0].toBase58();
const member = Keypair.generate().publicKey.toBase58();
const index = 4n;

/** Reads the instruction back the way the program will, so the test proves what is encoded, not what was passed in. */
function decodeActions(data: Buffer) {
  const [decoded] = multisig.generated.configTransactionCreateStruct.deserialize(data);
  return decoded.args.actions;
}

describe("Squads time lock change", () => {
  it("creates a config transaction and its proposal, both signed by the member", () => {
    const prepared = prepareSquadsTimeLockChange(multisigPda, member, index, 3600, "Relay time lock");
    expect(prepared.instructions).toHaveLength(2);
    const ref = squadsRefFor(multisigPda, index);
    expect(prepared.ref).toEqual(ref);
    for (const instruction of prepared.instructions) {
      expect(instruction.programId.toBase58()).toBe(multisig.PROGRAM_ID.toBase58());
      expect(instruction.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())).toContain(member);
    }
    expect(prepared.instructions[0]!.keys.map((key) => key.pubkey.toBase58())).toContain(ref.transactionPda);
    expect(prepared.instructions[1]!.keys.map((key) => key.pubkey.toBase58())).toContain(ref.proposalPda);
  });

  it("encodes the new delay as a SetTimeLock action and nothing else", () => {
    const prepared = prepareSquadsTimeLockChange(multisigPda, member, index, 86_400, "Relay time lock");
    const actions = decodeActions(prepared.instructions[0]!.data);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ __kind: "SetTimeLock", newTimeLock: 86_400 });
  });

  it("encodes a different delay differently and the same delay identically", () => {
    const hour = prepareSquadsTimeLockChange(multisigPda, member, index, 3600, "memo").instructions[0]!.data;
    const day = prepareSquadsTimeLockChange(multisigPda, member, index, 86_400, "memo").instructions[0]!.data;
    expect(hour.equals(day)).toBe(false);
    expect(hour.equals(prepareSquadsTimeLockChange(multisigPda, member, index, 3600, "memo").instructions[0]!.data)).toBe(true);
  });

  it("refuses a delay the program would not take", () => {
    expect(() => prepareSquadsTimeLockChange(multisigPda, member, index, -1, "memo")).toThrow(/Time lock/);
    expect(() => prepareSquadsTimeLockChange(multisigPda, member, index, 1.5, "memo")).toThrow(/Time lock/);
    expect(() => prepareSquadsTimeLockChange(multisigPda, member, index, 90 * 24 * 60 * 60 + 1, "memo")).toThrow(/Time lock/);
    expect(prepareSquadsTimeLockChange(multisigPda, member, index, 0, "memo").instructions).toHaveLength(2);
  });

  it("derives the same accounts as the adapter does for a payment", () => {
    const ref = squadsRefFor(multisigPda, index);
    expect(ref.proposalPda).toBe(multisig.getProposalPda({ multisigPda: new PublicKey(multisigPda), transactionIndex: index })[0].toBase58());
    expect(ref.transactionPda).toBe(multisig.getTransactionPda({ multisigPda: new PublicKey(multisigPda), index })[0].toBase58());
    expect(ref.vaultPda).toBe(multisig.getVaultPda({ multisigPda: new PublicKey(multisigPda), index: 0 })[0].toBase58());
    expect(ref.transactionIndex).toBe("4");
  });
});

describe("Squads proposal cancellation", () => {
  it("is signed by the member and points at the proposal it cancels", () => {
    const instruction = squadsProposalCancelInstruction(multisigPda, index, member, "cancelled");
    expect(instruction.programId.toBase58()).toBe(multisig.PROGRAM_ID.toBase58());
    expect(instruction.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())).toEqual([member]);
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toContain(squadsRefFor(multisigPda, index).proposalPda);
  });

  it("carries a memo only when one is given", () => {
    const withMemo = squadsProposalCancelInstruction(multisigPda, index, member, "cancelled");
    const without = squadsProposalCancelInstruction(multisigPda, index, member);
    expect(withMemo.data.equals(without.data)).toBe(false);
  });
});
