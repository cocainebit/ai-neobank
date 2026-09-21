import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PostgresControlPlaneStore } from "@ai-neobank/database";
import type { PrincipalRole } from "@ai-neobank/domain";
import { capabilityDecision, capabilityGuard } from "./verification-routes.js";

interface HumanContext { organizationId: string; principalId: string; role: PrincipalRole }

export interface CardsRouteContext {
  store: PostgresControlPlaneStore;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
}

/**
 * Cards.
 *
 * Floatlane has no card issuer, no licence, and no verification provider behind
 * it, so there is nothing to issue and nothing to list. This route exists so the
 * console reads that from the server rather than guessing it from a missing
 * route, and so the gate is enforced here and not only in a browser.
 *
 * It never invents a card. The list is empty because none exists, the provider
 * is null because none is connected, and ordering one is refused with the
 * reason, whether that reason is verification or the missing issuer.
 */
export function registerCardsRoutes(app: FastifyInstance, context: CardsRouteContext): void {
  const { store, human } = context;

  /**
   * What this organisation has: nothing, and why it cannot have any yet. A
   * locked feature answers rather than failing, so the console can say what is
   * missing instead of showing an error where a card list would be.
   */
  app.get("/v1/cards", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const capability = await capabilityDecision(store, auth.organizationId, "cards");
    return { data: { provider: null, cards: [], capability } };
  });

  /** Ordering one. Refused with the reason, because no issuer could fulfil it. */
  app.post("/v1/cards", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    if (await capabilityGuard(reply, store, auth.organizationId, "cards")) return;
    return reply.code(503).send({
      error: "provider_not_connected",
      capability: "cards",
      message: "Floatlane has no card issuer connected, so no card can be ordered."
    });
  });
}
