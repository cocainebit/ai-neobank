import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PostgresControlPlaneStore } from "@ai-neobank/database";
import {
  planVault,
  sameVaultAddress,
  squadsMembersFor,
  vaultChainFamilies,
  verifyVaultDeployment,
  type PrincipalRole,
  type VaultObservation,
  type VaultPlanResult
} from "@ai-neobank/domain";
import { canonicalAddress } from "@ai-neobank/auth";
import type { SafeGovernanceAdapter } from "@ai-neobank/safe-adapter";
import type { SolanaAdapter } from "@ai-neobank/solana-adapter";
import type { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";

interface HumanContext { organizationId: string; principalId: string; role: PrincipalRole }

export interface VaultRouteContext {
  store: PostgresControlPlaneStore;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
  /** Present only while the API is connected to the chain the vault would live on. */
  safe: { adapter: SafeGovernanceAdapter; network: string; chainId: number } | null;
  squads: { adapter: SquadsGovernanceAdapter; solana: SolanaAdapter; network: string } | null;
}

const uuid = z.string().uuid();
const network = z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/);
const governance = z.enum(["safe", "squads"]);
const owners = z.array(z.string().min(20)).min(1).max(20);
const threshold = z.number().int().min(1).max(20);

export const prepareVaultSchema = z.object({ governance, network, owners, threshold, executorSignerId: uuid });

export const recordVaultSchema = z.object({
  name: z.string().min(1).max(80),
  governance,
  network,
  /** The Safe itself, or vault 0 of the Squads multisig. */
  address: z.string().min(20),
  multisigPda: z.string().min(32).optional(),
  executorSignerId: uuid,
  owners,
  threshold,
  /** Safe only: re-derives the predicted address, so only the Safe this plan predicts can be recorded. */
  saltNonce: z.string().regex(/^\d+$/).optional()
}).superRefine((value, context) => {
  if (value.governance === "squads" && !value.multisigPda) context.addIssue({ code: "custom", message: "A Squads vault is recorded with its multisigPda" });
  if (value.governance === "squads" && value.saltNonce) context.addIssue({ code: "custom", message: "saltNonce is a Safe deployment detail" });
});

export const vaultStatusSchema = z.object({
  governance,
  network,
  address: z.string().min(20),
  multisigPda: z.string().min(32).optional()
}).superRefine((value, context) => {
  if (value.governance === "squads" && !value.multisigPda) context.addIssue({ code: "custom", message: "A Squads vault is read back by its multisigPda" });
});

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

/**
 * Canonicalises the addresses the wallet sent, then applies the shared plan
 * rules. An address that is not an address at all is reported the same way as
 * one that breaks a rule, so the console can mark the field either way.
 */
export function planFromRequest(input: { governance: "safe" | "squads"; network: string; owners: string[]; threshold: number; executor: string }): VaultPlanResult {
  const chainFamily = vaultChainFamilies[input.governance];
  let canonicalOwners: string[];
  try {
    canonicalOwners = input.owners.map((owner) => canonicalAddress(chainFamily, owner));
  } catch {
    return { ok: false, problems: ["owner_address_invalid"] };
  }
  let executor: string;
  try {
    executor = canonicalAddress(chainFamily, input.executor);
  } catch {
    return { ok: false, problems: ["executor_address_invalid"] };
  }
  return planVault({ governance: input.governance, network: input.network, owners: canonicalOwners, threshold: input.threshold, executor });
}

/**
 * Creating a vault, end to end. Relay never deploys or owns one: it hands the
 * owner's wallet the exact transaction to send, then reads the account back off
 * the chain and records a treasury only when what exists is what was asked for.
 *
 * A new vault is created with no time lock, which is all the Squads create
 * instruction allows; the lock is set afterwards, by a config transaction the
 * owners approve.
 */
export function registerVaultRoutes(app: FastifyInstance, context: VaultRouteContext): void {
  const { store, human } = context;

  const executorFor = async (organizationId: string, signerId: string, chainFamily: "evm" | "svm") => {
    const signer = (await store.listSigners(organizationId)).find((candidate) => candidate.id === signerId);
    return signer && signer.chainFamily === chainFamily && signer.status === "active" ? signer : null;
  };

  const walletsOf = async (auth: HumanContext, chainFamily: "evm" | "svm") => {
    const members = await store.listMembers(auth.organizationId);
    return members.find((member) => member.id === auth.principalId)?.wallets.filter((wallet) => wallet.chainFamily === chainFamily).map((wallet) => wallet.address) ?? [];
  };

  /** Everything the owner's wallet needs to deploy the vault itself. Nothing is recorded yet. */
  app.post("/v1/vaults/prepare", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = prepareVaultSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const chainFamily = vaultChainFamilies[body.data.governance];
    const signer = await executorFor(auth.organizationId, body.data.executorSignerId, chainFamily);
    if (!signer) return reply.code(422).send({ error: "executor_signer_invalid", message: "Create an executor key on this chain before preparing a vault." });
    const planned = planFromRequest({ ...body.data, executor: signer.address });
    if (!planned.ok) return reply.code(422).send({ error: "vault_plan_invalid", problems: planned.problems });
    const plan = planned.plan;

    if (plan.governance === "safe") {
      if (!context.safe || context.safe.network !== plan.network) return reply.code(503).send({ error: "network_not_configured", network: plan.network });
      let prepared;
      try {
        prepared = await context.safe.adapter.prepareDeployment(plan.owners, plan.threshold);
      } catch (error) {
        return reply.code(503).send({ error: "safe_contracts_unavailable", message: `Safe contracts are not available on ${plan.network}. On a local chain, run scripts/localnet.sh up to deploy them. (${error instanceof Error ? error.message : "unknown"})` });
      }
      return {
        data: {
          governance: "safe", chainFamily, network: plan.network, chainId: context.safe.chainId,
          predictedAddress: prepared.address,
          transaction: { to: prepared.to, data: prepared.data, value: prepared.value },
          // The predicted address covers the owners in this order, the threshold and this salt. Send all three back to record the vault.
          saltNonce: prepared.saltNonce,
          owners: plan.owners, threshold: plan.threshold, executor: plan.executor
        }
      };
    }

    if (!context.squads || context.squads.network !== plan.network) return reply.code(503).send({ error: "network_not_configured", network: plan.network });
    // The creator signs and pays for the multisig, so it has to be a wallet of
    // the person doing this, and it has to be one of the vault's owners.
    const wallets = await walletsOf(auth, chainFamily);
    const creatorAddress = plan.owners.find((owner) => wallets.some((wallet) => sameVaultAddress(chainFamily, wallet, owner)));
    if (!creatorAddress) return reply.code(422).send({ error: "creator_wallet_must_be_an_owner", message: "The wallet you are signed in with has to be one of the vault's owners: it signs and pays for the creation." });
    const creator = new PublicKey(creatorAddress);
    const prepared = await context.squads.adapter.prepareCreate(creator, squadsMembersFor(plan), plan.threshold);
    const { blockhash } = await context.squads.solana.rpc.getLatestBlockhash("finalized");
    const message = new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: [prepared.instruction] }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([prepared.createKey]);
    return {
      data: {
        governance: "squads", chainFamily, network: plan.network,
        multisigPda: prepared.multisigPda, vaultPda: prepared.vaultPda,
        transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
        feePayer: creator.toBase58(),
        owners: plan.owners, threshold: plan.threshold, executor: plan.executor,
        /** A new multisig has no time lock. Set one afterwards from the vault's controls. */
        timeLock: 0
      }
    };
  });

  /** Records the deployed vault as a treasury, but only after reading it back off the chain. */
  app.post("/v1/vaults", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = recordVaultSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const chainFamily = vaultChainFamilies[body.data.governance];
    const signer = await executorFor(auth.organizationId, body.data.executorSignerId, chainFamily);
    if (!signer) return reply.code(422).send({ error: "executor_signer_invalid", message: "That executor key is not an active signer on this chain." });
    const planned = planFromRequest({ ...body.data, executor: signer.address });
    if (!planned.ok) return reply.code(422).send({ error: "vault_plan_invalid", problems: planned.problems });
    const plan = planned.plan;
    let address: string;
    try { address = canonicalAddress(chainFamily, body.data.address); } catch { return invalid(reply, "Invalid vault address"); }
    const wallets = await walletsOf(auth, chainFamily);
    if (wallets.length === 0) return reply.code(403).send({ error: "no_wallet_bound", message: `Bind ${chainFamily === "evm" ? "an Ethereum" : "a Solana"} wallet to your account before recording a vault.` });

    let observed: VaultObservation;
    let observedConfiguration: Record<string, unknown>;
    if (plan.governance === "safe") {
      if (!context.safe || context.safe.network !== plan.network) return reply.code(503).send({ error: "network_not_configured", network: plan.network });
      let safe;
      try { safe = await context.safe.adapter.observe(address); } catch { return reply.code(422).send({ error: "safe_not_found_on_chain", message: "There is no Safe at that address yet. Wait for the deployment to confirm and try again." }); }
      if (body.data.saltNonce) {
        // The address only, never the deployment transaction: the Safe being
        // recorded is already on chain, and Protocol Kit refuses to build a
        // deployment for one that exists.
        let predicted;
        try { predicted = await context.safe.adapter.predictAddress(plan.owners, plan.threshold, body.data.saltNonce); } catch (error) {
          return reply.code(503).send({ error: "safe_contracts_unavailable", message: `Safe contracts are not available on ${plan.network}. (${error instanceof Error ? error.message : "unknown"})` });
        }
        if (!sameVaultAddress(chainFamily, predicted, address)) {
          return reply.code(422).send({ error: "vault_address_does_not_match_plan", message: "That Safe is not the one this plan predicts. The owners, their order, the threshold and the salt all have to be the ones that were prepared." });
        }
      }
      observed = { governance: "safe", owners: safe.owners, threshold: safe.threshold };
      observedConfiguration = { owners: safe.owners, threshold: safe.threshold, modules: safe.modules, guard: safe.guard, observedAt: new Date().toISOString() };
    } else {
      if (!context.squads || context.squads.network !== plan.network) return reply.code(503).send({ error: "network_not_configured", network: plan.network });
      let multisig;
      try { multisig = await context.squads.adapter.observe(body.data.multisigPda!); } catch { return reply.code(422).send({ error: "multisig_not_found_on_chain", message: "There is no Squads multisig at that address yet. Wait for the creation to confirm and try again." }); }
      observed = { governance: "squads", vaultPda: multisig.vaultPda, threshold: multisig.threshold, members: multisig.members };
      observedConfiguration = { multisigPda: body.data.multisigPda, threshold: multisig.threshold, timeLock: multisig.timeLock, members: multisig.members, observedAt: new Date().toISOString() };
    }

    const verified = verifyVaultDeployment({ plan, address, registeringWallets: wallets, observed });
    if (!verified.ok) return reply.code(verified.refusal.status).send({ error: verified.refusal.code, message: verified.refusal.message });

    await store.ensureNativeAsset(plan.network, chainFamily);
    try {
      const created = await store.createTreasury(auth.organizationId, {
        name: body.data.name, chainFamily, network: plan.network, address, governance: plan.governance,
        executorSignerId: body.data.executorSignerId, observedConfiguration
      }, auth.principalId);
      return reply.code(201).send({ data: created });
    } catch (error) {
      if (error instanceof Error && /duplicate key value/.test(error.message)) return reply.code(409).send({ error: "vault_already_registered", message: "This vault is already a treasury in this organisation." });
      throw error;
    }
  });

  /** Poll while a deployment confirms: what the chain has, and whether it is recorded here. */
  app.get("/v1/vaults/status", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const query = vaultStatusSchema.safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    const chainFamily = vaultChainFamilies[query.data.governance];
    let address: string;
    try { address = canonicalAddress(chainFamily, query.data.address); } catch { return invalid(reply, "Invalid vault address"); }
    const treasury = (await store.listTreasuries(auth.organizationId)).find((row) => row.network === query.data.network && sameVaultAddress(chainFamily, row.address, address)) ?? null;
    const recorded = treasury ? { id: treasury.id, name: treasury.name, status: treasury.status, governance: treasury.governance } : null;
    const base = { governance: query.data.governance, chainFamily, network: query.data.network, address, treasury: recorded };

    if (query.data.governance === "safe") {
      if (!context.safe || context.safe.network !== query.data.network) return reply.code(503).send({ error: "network_not_configured", network: query.data.network });
      const safe = await context.safe.adapter.observe(address).catch(() => null);
      return { data: { ...base, deployed: safe !== null, observed: safe ? { governance: "safe", owners: safe.owners, threshold: safe.threshold, nonce: safe.nonce } : null } };
    }
    if (!context.squads || context.squads.network !== query.data.network) return reply.code(503).send({ error: "network_not_configured", network: query.data.network });
    const multisig = await context.squads.adapter.observe(query.data.multisigPda!).catch(() => null);
    return {
      data: {
        ...base,
        deployed: multisig !== null,
        observed: multisig ? { governance: "squads", multisigPda: multisig.multisigPda, vaultPda: multisig.vaultPda, threshold: multisig.threshold, timeLock: multisig.timeLock, members: multisig.members } : null
      }
    };
  });
}
