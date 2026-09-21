import { describe, expect, it } from "vitest";
import { emptyVerificationState } from "@ai-neobank/domain";
import { capabilityStatusCode, verificationView, type VerificationSubject } from "./verification-routes.js";

const subject = (overrides: Partial<VerificationSubject> = {}): VerificationSubject => ({ ...emptyVerificationState(), frozen: false, ...overrides });

describe("what /v1/verification returns", () => {
  it("shows an unstarted organisation with cards locked and says why", () => {
    const view = verificationView(subject());
    expect(view.status).toBe("unstarted");
    expect(view.verification.status).toBe("unstarted");
    expect(view.verification.provider).toBeNull();
    expect(view.provider).toBeNull();
    expect("requirements" in view).toBe(false);
    expect(view.banner.providerConnected).toBe(false);
    expect(view.capabilities.cards).toMatchObject({ allowed: false, code: "verification_required" });
  });

  /** A verified organisation is not a card: there is no issuer, so the tab stays locked and says so. */
  it("keeps cards locked once verified, with the missing issuer as the reason", () => {
    const view = verificationView(subject({ status: "verified", method: "manual", decidedAt: "2026-09-21T10:00:00.000Z", decidedBy: "b2b9b2f2-9d27-4d1e-8a1f-1f9d0f2a7c11" }));
    expect(view.verification.method).toBe("manual");
    expect(view.reviewedAt).toBe("2026-09-21T10:00:00.000Z");
    expect(view.capabilities.cards).toMatchObject({ allowed: false, code: "provider_not_connected" });
  });

  it("never carries the freeze flag into the verification record", () => {
    const view = verificationView(subject({ frozen: true }));
    expect("frozen" in view.verification).toBe(false);
    expect(view.capabilities.cards).toMatchObject({ allowed: false, code: "organization_frozen" });
  });
});

describe("capabilityStatusCode", () => {
  it("uses the repo's code for each kind of refusal", () => {
    expect(capabilityStatusCode("organization_not_found")).toBe(404);
    expect(capabilityStatusCode("organization_frozen")).toBe(423);
    expect(capabilityStatusCode("provider_not_connected")).toBe(503);
    expect(capabilityStatusCode("verification_required")).toBe(403);
    expect(capabilityStatusCode("verification_in_review")).toBe(403);
    expect(capabilityStatusCode("verification_rejected")).toBe(403);
    expect(capabilityStatusCode("verification_expired")).toBe(403);
  });
});
