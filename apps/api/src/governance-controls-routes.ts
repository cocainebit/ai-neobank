import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApprovalError, type PostgresControlPlaneStore, type PostgresJobQueue, type TreasuryRecord } from "@ai-neobank/database";
import {
  asIntentStatus,
  asTimeLockChangeStatus,
  describeIntentStatus,
  evaluateExecution,
  evaluateRejection,
  nextTimeLockChangeStatus,
  readTimeLock,
  rejectionTransition,
  timeLockChangeSchema,
  timeLockState,
  type ControlRefusal,
  type PrincipalRole,
  type TimeLockChangeEvent,
  type TimeLockChangeStatus,
  type TimeLockReading,
  type TimeLockState
} from "@ai-neobank/domain";
import { compileSafeRejection, recoverSafeSigner, safeRejectionCancels, safeTypedDataJson, type CompiledSafeTransaction, type SafeGovernanceAdapter } from "@ai-neobank/safe-adapter";
import { isSquadsConfigTransaction, observeSquadsProposalTiming, prepareSquadsTimeLockChange, squadsProposalCancelInstruction, type SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import type { EvmAdapter } from "@ai-neobank/evm-adapter";
import type { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";

interface HumanContext { organizationId: string; principalId: string; walletId: string | null; role: PrincipalRole }

export interface GovernanceControlsRouteContext {
  options: { chains?: { evm?: { network: string; chainId: number }; solana?: { network: string } } };
  store: PostgresControlPlaneStore;
  queue: PostgresJobQueue | undefined;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
  adapters: { evm: EvmAdapter | null; solana: SolanaAdapter | null; safe: SafeGovernanceAdapter | null; squads: SquadsGovernanceAdapter | null };
}

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chainReference = z.string().min(32).max(128);
const transactionIndexParam = z.string().regex(/^\d{1,20}$/);
const decisionParam = z.enum(["approved", "rejected", "cancelled"]);
const confirmSchema = z.object({ transactionSignature: chainReference });
const rejectionSchema = z.object({
  expectedIntentVersion: z.number().int().positive(),
  compiledHash: hash,
  simulationHash: hash,
  /** Safe: the owner's EIP-712 signature over the rejection transaction. */
  signature: z.string().min(16).max(8192).optional(),
  /** The rejection that was sent on chain: the Safe nonce burn, or the Solana reject vote. */
  transactionHash: chainReference.optional()
});

/** Intent states that leave a Squads proposal or a Safe nonce in flight. */
const inFlightIntentStatuses = ["policy_evaluated", "approval_required", "approved", "executing", "submitted"];

/** The event a vote route is asking the proposal to reach. */
const voteEvents: Record<z.infer<typeof decisionParam>, TimeLockChangeEvent> = { approved: "approve", rejected: "reject", cancelled: "cancel" };

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

/** A refusal from the domain rules is a conflict, never a validation error: the request was well formed and the state says no. */
function refused(reply: FastifyReply, refusal: ControlRefusal) {
  return reply.code(409).send({ error: refusal.code, message: refusal.message });
}

/**
 * Where a config change stands against the multisig's own delay.
 *
 * The delay runs from the moment the proposal was approved, and Squads writes
 * that moment onto the `Approved` status. It writes none onto `Executing`: a
 * proposal that has passed its threshold and carries no instant has a start
 * Relay cannot read, which is an unknown start and never a delay that has run
 * out. Relay counts that as locked, so it shows and prepares what the program
 * will actually allow.
 */
export function timeLockChangeState(input: { reading: TimeLockReading; status: TimeLockChangeStatus | null; statusAt: string | null; now: Date }): TimeLockState {
  const running = input.status === "approved" || input.status === "executing";
  const state = timeLockState({ reading: input.reading, approvedAt: running ? input.statusAt : null, now: input.now });
  if (!running || input.statusAt || input.reading.seconds <= 0) return state;
  return { ...state, startedAt: null, executableAt: null, remainingSeconds: input.reading.seconds, locked: true };
}

function approvalFailure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ApprovalError)) throw error;
  const status = error.code === "not_found" ? 404 : error.code === "not_eligible" ? 403 : error.code === "expired" ? 410 : error.code === "frozen" ? 423 : 409;
  return reply.code(status).send({ error: error.code });
}

/**
 * Time locks and rejection transactions for Safe and Squads treasuries.
 *
 * Everything here prepares a transaction for a person's own wallet and then
 * records what the chain did. Relay never signs a governance change: the
 * executor key it holds may initiate and execute payments, and it is kept out of
 * every vote here, including the votes on its own treasury's time lock.
 *
 * A rejection ends a payment through the same approval path an approval takes,
 * so the evidence bound to the approval request is the evidence bound to the
 * rejection, and nothing new can move funds.
 */
export function registerGovernanceControlsRoutes(app: FastifyInstance, context: GovernanceControlsRouteContext): void {
  const { store, queue, human, adapters, options } = context;
  const evmNetwork = options.chains?.evm?.network;
  const evmChainId = options.chains?.evm?.chainId;
  const solanaNetwork = options.chains?.solana?.network;

  async function treasuryOf(reply: FastifyReply, organizationId: string, treasuryId: string): Promise<TreasuryRecord | null> {
    const treasury = await store.getTreasury(organizationId, treasuryId);
    if (!treasury) { void reply.code(404).send({ error: "treasury_not_found" }); return null; }
    return treasury;
  }

  /** The address of the key Relay holds for this treasury, so it can be kept out of every vote. */
  async function executorAddress(organizationId: string, treasury: TreasuryRecord): Promise<string | null> {
    if (!treasury.executorSignerId) return null;
    const signers = await store.listSigners(organizationId);
    return signers.find((signer) => signer.id === treasury.executorSignerId)?.address ?? null;
  }

  /**
   * The caller's wallet for a chain. An EVM signature is bound to the wallet this
   * session signed in with, exactly as the approval path binds it; a Solana
   * member votes with the Solana wallet on their principal.
   */
  async function walletOf(organizationId: string, principalId: string, chainFamily: "evm" | "svm", walletId: string | null) {
    const wallets = (await store.listMembers(organizationId)).find((member) => member.id === principalId)?.wallets ?? [];
    return chainFamily === "evm"
      ? wallets.find((candidate) => candidate.chainFamily === "evm" && candidate.id === walletId) ?? null
      : wallets.find((candidate) => candidate.chainFamily === "svm") ?? null;
  }

  /** Resolves the Squads multisig behind a treasury and reads it from the chain. */
  async function squadsContext(reply: FastifyReply, treasury: TreasuryRecord) {
    const squads = adapters.squads;
    if (!squads || !adapters.solana || solanaNetwork !== treasury.network) { void reply.code(503).send({ error: "network_not_configured", network: treasury.network }); return null; }
    const multisigPda = typeof treasury.observedConfiguration.multisigPda === "string" ? treasury.observedConfiguration.multisigPda : null;
    if (!multisigPda) { void reply.code(422).send({ error: "treasury_missing_multisig", message: "This treasury has no multisig recorded, so Relay cannot read or change its time lock." }); return null; }
    try {
      return { squads, solana: adapters.solana, multisigPda, observed: await squads.observe(multisigPda) };
    } catch {
      void reply.code(422).send({ error: "multisig_not_found_on_chain" });
      return null;
    }
  }

  /** A versioned transaction for a wallet to sign, built the way the rest of the API builds them. */
  async function forWallet(solana: SolanaAdapter, payer: string, instructions: TransactionInstruction[]) {
    const { blockhash } = await solana.rpc.getLatestBlockhash("finalized");
    const message = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  }

  // Time locks

  app.get<{ Params: { id: string } }>("/v1/treasuries/:id/time-lock", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid treasury ID");
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    const observed = treasury.observedConfiguration;
    let reading = readTimeLock({ governance: treasury.governance, observed });
    const evidence: Record<string, unknown> = { source: "observed_configuration", observedAt: typeof observed.observedAt === "string" ? observed.observedAt : null };
    if (treasury.governance === "squads" && adapters.squads && solanaNetwork === treasury.network && typeof observed.multisigPda === "string") {
      const live = await adapters.squads.observe(observed.multisigPda).catch(() => null);
      if (live) {
        reading = readTimeLock({ governance: treasury.governance, observed: { timeLock: live.timeLock } });
        evidence.source = "chain";
        evidence.multisigPda = live.multisigPda;
        evidence.threshold = live.threshold;
        evidence.transactionIndex = live.transactionIndex.toString();
        evidence.observedAt = new Date().toISOString();
      } else {
        evidence.error = "multisig_not_readable";
      }
    }
    if (treasury.governance === "safe" && adapters.safe && evmNetwork === treasury.network) {
      const live = await adapters.safe.observe(treasury.address).catch(() => null);
      if (live) {
        const guard = live.guard && /[1-9a-f]/i.test(live.guard.slice(2)) ? live.guard : null;
        evidence.source = "chain";
        evidence.modules = live.modules;
        evidence.guard = guard;
        evidence.nonce = live.nonce;
        evidence.threshold = live.threshold;
        evidence.observedAt = new Date().toISOString();
        // A delay modifier would show up as a module, but Relay cannot read what a module does or how long it holds a transaction.
        if (live.modules.length > 0 || guard) evidence.note = "This Safe has a module or guard installed. Relay can see that it is there but cannot read what it does or how long it delays a transaction.";
      } else {
        evidence.error = "safe_not_readable";
      }
    }
    return { data: { treasuryId: treasury.id, governance: treasury.governance, chainFamily: treasury.chainFamily, network: treasury.network, ...reading, evidence } };
  });

  /** Prepares the time lock change for a voting member's wallet. The executor never creates or votes on it. */
  app.post<{ Params: { id: string } }>("/v1/treasuries/:id/time-lock", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = timeLockChangeSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, body.success ? "Invalid treasury ID" : body.error.flatten());
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    if (treasury.governance === "direct") return reply.code(422).send({ error: "treasury_not_governed", message: "A direct treasury has no governance, so there is nothing to delay." });
    if (treasury.governance === "safe") {
      return reply.code(422).send({
        error: "safe_time_lock_unavailable",
        message: "A Safe has no time lock of its own, and Relay does not enforce one in its place. A delay needs a Zodiac delay module or a guard installed on the Safe by its owners, outside Relay."
      });
    }
    const squads = await squadsContext(reply, treasury); if (!squads) return;
    if (squads.observed.timeLock === body.data.seconds) return reply.code(409).send({ error: "time_lock_unchanged", message: `The time lock is already ${body.data.seconds} seconds.` });
    const wallet = await walletOf(auth.organizationId, auth.principalId, "svm", auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_solana_wallet_bound" });
    const voter = squads.observed.members.find((member) => member.key === wallet.address);
    if (!voter?.canVote) return reply.code(403).send({ error: "wallet_is_not_a_voting_member" });
    const executor = await executorAddress(auth.organizationId, treasury);
    if (executor && executor === wallet.address) return reply.code(403).send({ error: "executor_must_not_vote" });
    // Executing a config transaction bumps the multisig's stale transaction index, which voids every proposal already waiting for votes.
    // The filter belongs in the query: an organisation's busiest days must not push this treasury's payment out of the window.
    const byStatus = await Promise.all(inFlightIntentStatuses.map((status) => store.listIntents(auth.organizationId, { status, treasuryAccountId: treasury.id, limit: 500 })));
    const inFlight = byStatus.flat();
    if (inFlight.length > 0) {
      return reply.code(409).send({ error: "treasury_busy", message: `${inFlight.length} payment${inFlight.length === 1 ? " is" : "s are"} in flight. A config change voids proposals that are already waiting for votes, so finish or reject them first.` });
    }
    const transactionIndex = squads.observed.transactionIndex + 1n;
    const memo = body.data.memo ?? `Relay time lock: ${body.data.seconds} seconds`;
    let prepared;
    try {
      prepared = prepareSquadsTimeLockChange(squads.multisigPda, wallet.address, transactionIndex, body.data.seconds, memo);
    } catch (error) {
      return invalid(reply, error instanceof Error ? error.message : "Invalid time lock");
    }
    return reply.code(201).send({
      data: {
        governance: "squads",
        treasuryId: treasury.id,
        multisigPda: squads.multisigPda,
        transactionIndex: transactionIndex.toString(),
        ref: prepared.ref,
        transactionBase64: await forWallet(squads.solana, wallet.address, prepared.instructions),
        member: wallet.address,
        seconds: body.data.seconds,
        previousSeconds: squads.observed.timeLock,
        requiredApprovals: squads.observed.threshold,
        note: "Send this from your wallet, then collect the same threshold of approvals a payment needs. The new delay applies once the config transaction is executed."
      }
    });
  });

  app.get<{ Params: { id: string; index: string } }>("/v1/treasuries/:id/time-lock/changes/:index", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const index = transactionIndexParam.safeParse(request.params.index);
    if (!id.success || !index.success) return invalid(reply, "Invalid treasury ID or transaction index");
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    if (treasury.governance !== "squads") return reply.code(422).send({ error: "treasury_not_governed", message: "Only a Squads vault has a time lock change to follow." });
    const squads = await squadsContext(reply, treasury); if (!squads) return;
    const transactionIndex = BigInt(index.data);
    // The executor's payments sit at indices on this same multisig, and their proposals read exactly like this one.
    const [isConfigChange, timing, votes] = await Promise.all([
      isSquadsConfigTransaction(squads.solana.rpc, squads.multisigPda, transactionIndex),
      observeSquadsProposalTiming(squads.solana.rpc, squads.multisigPda, transactionIndex),
      squads.squads.observeProposal(squads.multisigPda, transactionIndex)
    ]);
    if (!isConfigChange || !timing || !votes) return reply.code(404).send({ error: "time_lock_change_not_found" });
    const status = asTimeLockChangeStatus(timing.status);
    const reading = readTimeLock({ governance: treasury.governance, observed: { timeLock: squads.observed.timeLock } });
    const lock = timeLockChangeState({ reading, status, statusAt: timing.statusAt, now: new Date() });
    return {
      data: {
        treasuryId: treasury.id, multisigPda: squads.multisigPda, transactionIndex: index.data, proposalPda: timing.proposalPda,
        status: timing.status, statusAt: timing.statusAt, approved: votes.approved, rejected: votes.rejected, cancelled: votes.cancelled,
        requiredApprovals: squads.observed.threshold, timeLock: lock,
        executable: Boolean(status && nextTimeLockChangeStatus(status, "execute")) && !lock.locked
      }
    };
  });

  /** The approve, reject or cancel transaction for a member's own wallet. */
  app.get<{ Params: { id: string; index: string; decision: string } }>("/v1/treasuries/:id/time-lock/changes/:index/vote/:decision", async (request, reply) => {
    const auth = human(request, reply, ["owner", "approver"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const index = transactionIndexParam.safeParse(request.params.index);
    const decision = decisionParam.safeParse(request.params.decision);
    if (!id.success || !index.success || !decision.success) return invalid(reply, "Invalid treasury ID, transaction index or decision");
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    if (treasury.governance !== "squads") return reply.code(422).send({ error: "treasury_not_governed", message: "Only a Squads vault has a time lock change to vote on." });
    const squads = await squadsContext(reply, treasury); if (!squads) return;
    const transactionIndex = BigInt(index.data);
    // A vote is a vote wherever it is sent. The executor publishes payments at indices on this same multisig, and an
    // approve vote against one of those is an approval of that payment, taken outside everything decideIntent checks;
    // a cancel against one leaves Relay showing approved while the chain says cancelled. Only a config transaction is
    // a time lock change, so an index holding anything else has no change to vote on.
    if (!(await isSquadsConfigTransaction(squads.solana.rpc, squads.multisigPda, transactionIndex))) return reply.code(404).send({ error: "time_lock_change_not_found" });
    const timing = await observeSquadsProposalTiming(squads.solana.rpc, squads.multisigPda, transactionIndex);
    if (!timing) return reply.code(404).send({ error: "time_lock_change_not_found" });
    const status = asTimeLockChangeStatus(timing.status);
    const event = voteEvents[decision.data];
    if (!status || !nextTimeLockChangeStatus(status, event)) {
      return reply.code(409).send({ error: "time_lock_change_not_votable", message: `A ${timing.status} config change cannot be ${decision.data === "cancelled" ? "cancelled" : `voted ${decision.data}`}.` });
    }
    const wallet = await walletOf(auth.organizationId, auth.principalId, "svm", auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_solana_wallet_bound" });
    const voter = squads.observed.members.find((member) => member.key === wallet.address);
    if (!voter?.canVote) return reply.code(403).send({ error: "wallet_is_not_a_voting_member" });
    const executor = await executorAddress(auth.organizationId, treasury);
    if (executor && executor === wallet.address) return reply.code(403).send({ error: "executor_must_not_vote" });
    const instruction = decision.data === "cancelled"
      ? squadsProposalCancelInstruction(squads.multisigPda, transactionIndex, wallet.address, "Relay time lock change cancelled")
      : squads.squads.voteInstruction(squads.multisigPda, transactionIndex, wallet.address, decision.data);
    return {
      data: {
        treasuryId: treasury.id, transactionIndex: index.data, proposalPda: timing.proposalPda, decision: decision.data,
        transactionBase64: await forWallet(squads.solana, wallet.address, [instruction]), member: wallet.address, requiredApprovals: squads.observed.threshold
      }
    };
  });

  /** The execution of an approved change, for a member's wallet. Refused while the multisig's own time lock is still running. */
  app.post<{ Params: { id: string; index: string } }>("/v1/treasuries/:id/time-lock/changes/:index/execute", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const index = transactionIndexParam.safeParse(request.params.index);
    if (!id.success || !index.success) return invalid(reply, "Invalid treasury ID or transaction index");
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    if (treasury.governance !== "squads") return reply.code(422).send({ error: "treasury_not_governed", message: "Only a Squads vault has a time lock change to execute." });
    const squads = await squadsContext(reply, treasury); if (!squads) return;
    const transactionIndex = BigInt(index.data);
    // Same gate as the vote routes. The program refuses a config execute against a payment's account, so an ungated
    // index here ends as a signed transaction that fails on chain: refuse it while the refusal can still say why.
    if (!(await isSquadsConfigTransaction(squads.solana.rpc, squads.multisigPda, transactionIndex))) return reply.code(404).send({ error: "time_lock_change_not_found" });
    const timing = await observeSquadsProposalTiming(squads.solana.rpc, squads.multisigPda, transactionIndex);
    if (!timing) return reply.code(404).send({ error: "time_lock_change_not_found" });
    const status = asTimeLockChangeStatus(timing.status);
    if (!status || !nextTimeLockChangeStatus(status, "execute")) {
      return reply.code(409).send({ error: "time_lock_change_not_executable", message: `A ${timing.status} config change cannot be executed. It needs ${squads.observed.threshold} approvals first.` });
    }
    const reading = readTimeLock({ governance: treasury.governance, observed: { timeLock: squads.observed.timeLock } });
    const lock = timeLockChangeState({ reading, status, statusAt: timing.statusAt, now: new Date() });
    if (lock.locked) {
      return reply.code(409).send({
        error: "time_locked",
        message: lock.executableAt
          ? `The vault's current time lock holds this change until ${lock.executableAt}, ${lock.remainingSeconds} seconds from now.`
          : `The vault's current time lock holds this change for up to ${lock.remainingSeconds} seconds, counted from the moment it was approved.`
      });
    }
    const wallet = await walletOf(auth.organizationId, auth.principalId, "svm", auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_solana_wallet_bound" });
    const member = squads.observed.members.find((candidate) => candidate.key === wallet.address);
    if (!member?.canExecute) return reply.code(403).send({ error: "wallet_cannot_execute" });
    const executor = await executorAddress(auth.organizationId, treasury);
    if (executor && executor === wallet.address) return reply.code(403).send({ error: "executor_must_not_change_governance", message: "The key Relay holds executes payments. A governance change is signed by the owners." });
    const instruction = squads.squads.prepareConfigExecute(squads.multisigPda, transactionIndex, new PublicKey(wallet.address));
    return {
      data: {
        treasuryId: treasury.id, transactionIndex: index.data, proposalPda: timing.proposalPda,
        transactionBase64: await forWallet(squads.solana, wallet.address, [instruction]), member: wallet.address, timeLock: lock
      }
    };
  });

  /** Records an executed change: the multisig is read again and the treasury's observed configuration catches up. */
  app.post<{ Params: { id: string; index: string } }>("/v1/treasuries/:id/time-lock/changes/:index/confirm", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const index = transactionIndexParam.safeParse(request.params.index);
    const body = confirmSchema.safeParse(request.body);
    if (!id.success || !index.success || !body.success) return invalid(reply, "Invalid treasury ID, transaction index or signature");
    const treasury = await treasuryOf(reply, auth.organizationId, id.data); if (!treasury) return;
    if (treasury.governance !== "squads") return reply.code(422).send({ error: "treasury_not_governed", message: "Only a Squads vault has a time lock change to confirm." });
    const squads = await squadsContext(reply, treasury); if (!squads) return;
    const receipt = await squads.solana.waitForTransaction(body.data.transactionSignature).catch(() => null);
    if (!receipt || receipt.failed || receipt.pending) return reply.code(409).send({ error: "execution_not_confirmed", message: "That transaction has not confirmed on the cluster Relay is connected to." });
    const live = await squads.squads.observe(squads.multisigPda).catch(() => null);
    if (!live) return reply.code(422).send({ error: "multisig_not_found_on_chain" });
    await store.updateTreasuryObservation(auth.organizationId, treasury.id, {
      ...treasury.observedConfiguration,
      multisigPda: squads.multisigPda,
      threshold: live.threshold,
      timeLock: live.timeLock,
      members: live.members,
      observedAt: new Date().toISOString()
    });
    return { data: { treasuryId: treasury.id, transactionIndex: index.data, transactionSignature: body.data.transactionSignature, ...readTimeLock({ governance: treasury.governance, observed: { timeLock: live.timeLock } }) } };
  });

  // What a time lock means for one payment

  app.get<{ Params: { id: string } }>("/v1/intents/:id/time-lock", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid intent ID");
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail) return reply.code(404).send({ error: "intent_not_found" });
    const treasury = await treasuryOf(reply, auth.organizationId, detail.intent.treasuryAccountId); if (!treasury) return;
    const reading = readTimeLock({ governance: treasury.governance, observed: treasury.observedConfiguration });
    // Relay's own record of when quorum was reached; for Squads the chain's own timestamp wins, because the program counts from that one.
    let approvedAt = detail.events.filter((event) => event.eventType === "intent.approved").at(-1)?.createdAt ?? null;
    const ref = detail.approval?.externalRef as { multisigPda?: string; transactionIndex?: string } | null;
    if (treasury.governance === "squads" && reading.seconds > 0 && adapters.solana && solanaNetwork === treasury.network && ref?.multisigPda && ref.transactionIndex) {
      const timing = await observeSquadsProposalTiming(adapters.solana.rpc, ref.multisigPda, BigInt(ref.transactionIndex)).catch(() => null);
      if (timing?.status === "approved" && timing.statusAt) approvedAt = timing.statusAt;
    }
    const lock = timeLockState({ reading, approvedAt, now: new Date() });
    const status = asIntentStatus(detail.intent.status);
    const execution = status
      ? evaluateExecution({ intentStatus: status, timeLock: lock })
      : { allowed: false as const, code: "execution_not_approved" as const, message: `A payment is executed once it is approved. This one is ${describeIntentStatus(detail.intent.status)}.` };
    return { data: { intentId: detail.intent.id, status: detail.intent.status, source: reading.source, enforcedOnChain: reading.enforcedOnChain, note: reading.note, timeLock: lock, execution } };
  });

  // Rejection transactions

  /** What the owners sign to cancel a payment on chain, and why they cannot when they cannot. */
  app.get<{ Params: { id: string } }>("/v1/intents/:id/rejection-transaction", async (request, reply) => {
    const auth = human(request, reply, ["owner", "approver"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid intent ID");
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail) return reply.code(404).send({ error: "intent_not_found" });
    const treasury = await treasuryOf(reply, auth.organizationId, detail.intent.treasuryAccountId); if (!treasury) return;
    const status = asIntentStatus(detail.intent.status);
    if (!status) return reply.code(409).send({ error: "intent_not_pending", message: `A payment can only be rejected while it is collecting approvals; this one is ${detail.intent.status}.` });
    const plan = evaluateRejection({ intentStatus: status, governance: treasury.governance, approvalStatus: detail.approval?.status ?? null, approvalExpiresAt: detail.approval?.expiresAt ?? null, now: new Date() });
    if (!plan.allowed) return refused(reply, plan);
    const base = { intentId: detail.intent.id, expectedIntentVersion: detail.intent.version, compiledHash: detail.approval?.compiledHash ?? null, simulationHash: detail.approval?.simulationHash ?? null, endsAs: plan.endsAs };
    const ref = detail.approval?.externalRef as { safeTx?: CompiledSafeTransaction; safeAddress?: string; chainId?: number; owners?: string[]; multisigPda?: string; transactionIndex?: string; proposalPda?: string } | null;
    if (plan.kind === "safe_nonce_burn") {
      if (!ref?.safeTx || !ref.safeAddress || !ref.owners) return reply.code(409).send({ error: "approval_not_published", message: "This payment has no compiled Safe transaction yet, so there is no nonce to burn." });
      // The nonce only cancels the payment if it is burnt on the treasury's own Safe.
      if (ref.safeAddress.toLowerCase() !== treasury.address.toLowerCase()) return reply.code(409).send({ error: "approval_not_published", message: "The approval was published against a different Safe." });
      const chainId = ref.chainId ?? evmChainId ?? 1;
      const rejection = compileSafeRejection(chainId, ref.safeAddress, ref.safeTx.nonce);
      return {
        data: {
          ...base, kind: plan.kind, safeAddress: ref.safeAddress, chainId, nonce: ref.safeTx.nonce, owners: ref.owners,
          rejection, safeTxHash: rejection.safeTxHash, typedData: safeTypedDataJson(chainId, ref.safeAddress, rejection),
          note: `Signing this ends the payment in Relay. Executed on chain by the Safe's owners it consumes nonce ${ref.safeTx.nonce}, so the payment can never be executed afterwards.`
        }
      };
    }
    if (!ref?.multisigPda || !ref.transactionIndex) return reply.code(409).send({ error: "approval_not_published", message: "This payment has no Squads proposal yet, so there is nothing to vote against." });
    if (ref.multisigPda !== treasury.observedConfiguration.multisigPda) return reply.code(409).send({ error: "approval_not_published", message: "The approval was published against a different multisig." });
    if (!adapters.squads || !adapters.solana || solanaNetwork !== treasury.network) return reply.code(503).send({ error: "network_not_configured", network: treasury.network });
    const wallet = await walletOf(auth.organizationId, auth.principalId, "svm", auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_solana_wallet_bound" });
    const instruction = adapters.squads.voteInstruction(ref.multisigPda, BigInt(ref.transactionIndex), wallet.address, "rejected");
    return {
      data: {
        ...base, kind: plan.kind, multisigPda: ref.multisigPda, transactionIndex: ref.transactionIndex, proposalPda: ref.proposalPda ?? null,
        transactionBase64: await forWallet(adapters.solana, wallet.address, [instruction]), member: wallet.address,
        note: "Send this from your wallet. The proposal is rejected once enough members vote against it, and Relay follows the chain."
      }
    };
  });

  /**
   * Records the rejection. The decision goes through the same store call an
   * approval takes, so the version, the expiry, the freeze and the compiled and
   * simulation hashes are all checked against the approval request before the
   * payment moves anywhere.
   */
  app.post<{ Params: { id: string } }>("/v1/intents/:id/rejection-transaction", async (request, reply) => {
    const auth = human(request, reply, ["owner", "approver"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid intent ID");
    const body = rejectionSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail) return reply.code(404).send({ error: "intent_not_found" });
    const treasury = await treasuryOf(reply, auth.organizationId, detail.intent.treasuryAccountId); if (!treasury) return;
    const status = asIntentStatus(detail.intent.status);
    if (!status) return reply.code(409).send({ error: "intent_not_pending", message: `A payment can only be rejected while it is collecting approvals; this one is ${detail.intent.status}.` });
    const plan = evaluateRejection({ intentStatus: status, governance: treasury.governance, approvalStatus: detail.approval?.status ?? null, approvalExpiresAt: detail.approval?.expiresAt ?? null, now: new Date() });
    if (!plan.allowed) return refused(reply, plan);
    if (rejectionTransition(status) !== plan.endsAs) return reply.code(409).send({ error: "intent_not_pending", message: `A rejection cannot move a payment out of ${status}.` });
    const ref = detail.approval?.externalRef as { safeTx?: CompiledSafeTransaction; safeAddress?: string; chainId?: number; owners?: string[]; multisigPda?: string; transactionIndex?: string } | null;
    const executor = await executorAddress(auth.organizationId, treasury);

    if (plan.kind === "squads_proposal_reject") {
      // The chain decides: the worker mirrors the proposal's own votes into the approval request.
      if (!queue) return reply.code(503).send({ error: "queue_not_configured" });
      if (!body.data.transactionHash) return reply.code(400).send({ error: "vote_transaction_required", message: "Send the rejection vote from your wallet first, then give Relay its signature." });
      if (!adapters.solana || solanaNetwork !== treasury.network) return reply.code(503).send({ error: "network_not_configured", network: treasury.network });
      const receipt = await adapters.solana.waitForTransaction(body.data.transactionHash).catch(() => null);
      if (!receipt || receipt.failed) return reply.code(409).send({ error: "vote_transaction_not_confirmed" });
      await queue.sql`insert into outbox_events (organization_id, topic, aggregate_type, aggregate_id, payload) values (${auth.organizationId}, 'proposal.observe', 'intent', ${id.data}, ${queue.sql.json({ intentId: id.data })})`;
      return reply.code(202).send({ data: { intentId: id.data, kind: plan.kind, source: "on_chain", transactionHash: body.data.transactionHash, approval: detail.approval } });
    }

    if (!ref?.safeTx || !ref.safeAddress || !ref.owners) return reply.code(409).send({ error: "approval_not_published", message: "This payment has no compiled Safe transaction yet, so there is no nonce to burn." });
    if (ref.safeAddress.toLowerCase() !== treasury.address.toLowerCase()) return reply.code(409).send({ error: "approval_not_published", message: "The approval was published against a different Safe." });
    if (!body.data.signature) return reply.code(400).send({ error: "owner_signature_required" });
    const wallet = await walletOf(auth.organizationId, auth.principalId, "evm", auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_wallet_bound", message: "Sign in with the Safe owner wallet you want to reject from." });
    const chainId = ref.chainId ?? evmChainId ?? 1;
    const rejection = compileSafeRejection(chainId, ref.safeAddress, ref.safeTx.nonce);
    // The rejection is only a rejection if it burns this payment's nonce and moves nothing.
    if (!safeRejectionCancels(rejection, ref.safeTx, ref.safeAddress)) return reply.code(409).send({ error: "rejection_does_not_cancel_payment" });
    const recovered = await recoverSafeSigner(rejection.safeTxHash, body.data.signature).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== wallet.address.toLowerCase()) return reply.code(401).send({ error: "approval_signature_invalid" });
    if (!ref.owners.map((owner) => owner.toLowerCase()).includes(recovered.toLowerCase())) return reply.code(403).send({ error: "wallet_is_not_a_safe_owner" });
    if (executor && executor.toLowerCase() === recovered.toLowerCase()) return reply.code(403).send({ error: "executor_must_not_vote" });
    let burned: { transactionHash: string; confirmed: boolean } | null = null;
    if (body.data.transactionHash) {
      if (!adapters.evm || evmNetwork !== treasury.network) return reply.code(503).send({ error: "network_not_configured", network: treasury.network });
      const receipt = await adapters.evm.waitForTransaction(body.data.transactionHash).catch(() => null);
      if (!receipt || receipt.failed) return reply.code(409).send({ error: "rejection_transaction_not_confirmed" });
      burned = { transactionHash: body.data.transactionHash, confirmed: !receipt.pending };
    }
    const signedPayload = JSON.stringify({
      kind: plan.kind, safeAddress: ref.safeAddress, chainId, nonce: rejection.nonce, rejectionSafeTxHash: rejection.safeTxHash,
      cancels: ref.safeTx.safeTxHash, owner: recovered, signature: body.data.signature, onChain: burned
    });
    try {
      const result = await store.decideIntent(auth.organizationId, id.data, {
        principalId: auth.principalId, decision: "rejected", expectedIntentVersion: body.data.expectedIntentVersion,
        compiledHash: body.data.compiledHash, simulationHash: body.data.simulationHash, signedPayload, signerAddress: recovered
      });
      return reply.code(result.idempotentReplay ? 200 : 202).send({ data: { ...result, kind: plan.kind, rejectionSafeTxHash: rejection.safeTxHash, nonce: rejection.nonce, onChain: burned } });
    } catch (error) {
      return approvalFailure(reply, error);
    }
  });
}
