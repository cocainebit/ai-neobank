"use client";

import { api } from "./api";
import type { Session } from "./types";
import { connectEvm, connectSolana, signEvmMessage, signEvmTypedData, signSolanaMessage, signSolanaTransaction } from "./wallet";

/** Connects the wallet the session was signed in with and refuses a different account. */
export async function sessionWallet(session: Session): Promise<{ chainFamily: "evm" | "svm"; address: string }> {
  if (!session.wallet) throw new Error("Your session has no wallet bound. Sign out and sign in with your wallet.");
  const connected = session.wallet.chainFamily === "evm" ? await connectEvm() : await connectSolana();
  const same = session.wallet.chainFamily === "evm" ? connected.toLowerCase() === session.wallet.address.toLowerCase() : connected === session.wallet.address;
  if (!same) throw new Error(`Your wallet is on ${connected}. Switch to ${session.wallet.address}, the account you signed in with.`);
  return { chainFamily: session.wallet.chainFamily, address: session.wallet.address };
}

export async function signPlain(session: Session, message: string): Promise<string> {
  const wallet = await sessionWallet(session);
  return wallet.chainFamily === "evm" ? signEvmMessage(wallet.address, message) : signSolanaMessage(message);
}

type ApprovalMessage =
  | { kind: "plain"; message: string; expectedIntentVersion: number; compiledHash: string; simulationHash: string }
  | { kind: "eip712"; typedData: unknown; expectedIntentVersion: number; compiledHash: string; simulationHash: string }
  | { kind: "solana_transaction"; transactionBase64: string; member: string; expectedIntentVersion: number; compiledHash: string; simulationHash: string };

/**
 * Approve or reject a payment with the right wallet action for its treasury:
 * a signed message (direct), an EIP-712 Safe signature, or an on-chain Squads vote.
 */
export async function decide(session: Session, intentId: string, decision: "approved" | "rejected"): Promise<void> {
  const { data } = await api<{ data: ApprovalMessage }>(`/v1/intents/${intentId}/approval-message/${decision}`);
  const path = `/v1/intents/${intentId}/${decision === "approved" ? "approve" : "reject"}`;
  if (data.kind === "solana_transaction") {
    await sessionWallet(session);
    const signed = await signSolanaTransaction(data.transactionBase64);
    const relayed = await api<{ data: { signature: string } }>("/v1/relay/solana", { method: "POST", body: { transactionBase64: signed } });
    await waitForConfirmation("solana", relayed.data.signature);
    await api(path, { method: "POST", body: { transactionSignature: relayed.data.signature } });
    return;
  }
  const evidence = { expectedIntentVersion: data.expectedIntentVersion, compiledHash: data.compiledHash, simulationHash: data.simulationHash };
  if (data.kind === "eip712") {
    const wallet = await sessionWallet(session);
    const signature = await signEvmTypedData(wallet.address, data.typedData);
    await api(path, { method: "POST", body: { ...evidence, signature } });
    return;
  }
  const signature = await signPlain(session, data.message);
  await api(path, { method: "POST", body: { ...evidence, signature } });
}

export async function waitForConfirmation(family: "evm" | "solana", hash: string, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data } = await api<{ data: { found: boolean; failed: boolean; confirmed: boolean } }>(`/v1/relay/${family}/status/${hash}`);
    if (data.failed) throw new Error("The transaction failed on chain");
    if (data.found && data.confirmed) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The transaction was not confirmed in time");
}
