import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrincipalRole } from "@ai-neobank/domain";
import type { EvmAdapter } from "@ai-neobank/evm-adapter";
import type { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { canonicalAddress } from "@ai-neobank/auth";
import { Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

interface HumanContext { organizationId: string; principalId: string }

export interface WalletRouteContext {
  environment: "development" | "test" | "production";
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
  evm: { adapter: EvmAdapter; rpcUrl: string; chainId: number } | null;
  solana: { adapter: SolanaAdapter; rpcUrl: string; network: string } | null;
}

/**
 * Helpers for browser wallets. A wallet signs; Relay submits to the cluster it
 * is configured for, so a wallet pointed at a different network still works.
 * Nothing here can move funds without a signature from the key that owns them.
 */
export function registerWalletRoutes(app: FastifyInstance, context: WalletRouteContext): void {
  app.get("/v1/networks", async () => ({
    data: {
      evm: context.evm ? { network: `eip155:${context.evm.chainId}`, chainId: context.evm.chainId, local: context.evm.chainId === 31337 } : null,
      solana: context.solana ? { network: context.solana.network, local: context.solana.network === "solana:localnet" } : null,
      environment: context.environment
    }
  }));

  app.post("/v1/relay/solana", async (request, reply) => {
    const auth = context.human(request, reply); if (!auth) return;
    const body = z.object({ transactionBase64: z.string().min(40).max(8_000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (!context.solana) return reply.code(503).send({ error: "network_not_configured" });
    let transaction: VersionedTransaction;
    try { transaction = VersionedTransaction.deserialize(Buffer.from(body.data.transactionBase64, "base64")); } catch { return reply.code(400).send({ error: "transaction_malformed" }); }
    const firstSignature = transaction.signatures[0];
    if (!firstSignature || firstSignature.every((byte) => byte === 0)) return reply.code(400).send({ error: "transaction_unsigned" });
    try {
      const signature = await context.solana.adapter.broadcast({ hash: bs58.encode(firstSignature), raw: body.data.transactionBase64, nonce: transaction.message.recentBlockhash, validUntil: "" });
      return { data: { signature: signature.hash } };
    } catch (error) {
      return reply.code(422).send({ error: "transaction_rejected", message: error instanceof Error ? error.message.slice(0, 500) : "rejected" });
    }
  });

  app.get<{ Params: { family: string; hash: string } }>("/v1/relay/:family/status/:hash", async (request, reply) => {
    const auth = context.human(request, reply); if (!auth) return;
    const family = request.params.family;
    const adapter = family === "evm" ? context.evm?.adapter : family === "solana" ? context.solana?.adapter : undefined;
    if (!adapter) return reply.code(503).send({ error: "network_not_configured" });
    const receipt = await adapter.waitForTransaction(request.params.hash).catch(() => null);
    return { data: receipt ? { found: true, failed: receipt.failed, confirmed: !receipt.pending || receipt.finalized } : { found: false, failed: false, confirmed: false } };
  });

  /** Local chains only: fund an address so a development workspace can be exercised end to end. */
  app.post("/v1/dev/fund", async (request, reply) => {
    const auth = context.human(request, reply); if (!auth) return;
    if (context.environment !== "development") return reply.code(404).send({ error: "not_found" });
    const body = z.object({ chainFamily: z.enum(["evm", "svm"]), address: z.string().min(20) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    let address: string;
    try { address = canonicalAddress(body.data.chainFamily, body.data.address); } catch { return reply.code(400).send({ error: "invalid_address" }); }
    if (body.data.chainFamily === "evm") {
      if (!context.evm || context.evm.chainId !== 31337) return reply.code(409).send({ error: "faucet_only_on_local_chains" });
      // A real transfer from Anvil's unlocked default account, so the treasury indexer sees and books it.
      const rpc = async (method: string, params: unknown[]) => {
        const response = await fetch(context.evm!.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const payload = await response.json() as { result?: unknown; error?: { message: string } };
        if (payload.error) throw new Error(payload.error.message);
        return payload.result;
      };
      try {
        const [funder] = await rpc("eth_accounts", []) as string[];
        const hash = await rpc("eth_sendTransaction", [{ from: funder, to: address, value: `0x${(10n * 10n ** 18n).toString(16)}` }]) as string;
        return { data: { chainFamily: "evm", address, transactionHash: hash } };
      } catch (error) {
        return reply.code(502).send({ error: "faucet_failed", message: error instanceof Error ? error.message : "faucet failed" });
      }
    }
    if (!context.solana || context.solana.network !== "solana:localnet") return reply.code(409).send({ error: "faucet_only_on_local_chains" });
    const connection = new Connection(context.solana.rpcUrl, "confirmed");
    const signature = await connection.requestAirdrop(new PublicKey(address), 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    return { data: { chainFamily: "svm", address, signature } };
  });
}
