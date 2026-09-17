import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { MemoryControlPlaneStore } from "@ai-neobank/database";

const app = buildApp({ store: new MemoryControlPlaneStore() });
afterAll(async () => app.close());

describe("API", () => {
  it("reports integrations honestly", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().integrations.safe).toBe("disabled_pending_verification");
  });

  it("persists organizations and agents through the control-plane API", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: "Acme Labs", slug: "acme-labs" }
    });
    expect(created.statusCode).toBe(201);
    const organizationId = created.json().data.id as string;

    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { "x-organization-id": organizationId },
      payload: { displayName: "Research", purpose: "Purchase approved data and APIs" }
    });
    expect(agent.statusCode).toBe(201);

    const agents = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { "x-organization-id": organizationId }
    });
    expect(agents.json().data).toHaveLength(1);
  });

  it("refuses software signer generation unless explicitly configured", async () => {
    const organizations = await app.inject({ method: "GET", url: "/v1/organizations" });
    const organizationId = organizations.json().data[0].id as string;
    const response = await app.inject({
      method: "POST",
      url: "/v1/signers",
      headers: { "x-organization-id": organizationId },
      payload: { chainFamily: "evm" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("software_signers_disabled");
  });
});
