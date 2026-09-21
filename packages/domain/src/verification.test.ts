import { describe, expect, it } from "vitest";
import { principalRoles } from "./index.js";
import {
  canPerformVerification,
  canTransitionVerification,
  capabilityAccess,
  connectedProviders,
  describeVerification,
  emptyVerificationState,
  verificationDecisionSchema,
  verificationStartSchema,
  verificationStatuses,
  verificationStoredFields,
  type VerificationState,
  type VerificationStatus
} from "./verification.js";

const decided = (status: VerificationStatus): VerificationState => ({
  ...emptyVerificationState(),
  status,
  method: "manual",
  startedAt: "2026-09-21T09:00:00.000Z",
  decidedAt: "2026-09-21T10:00:00.000Z",
  decidedBy: "b2b9b2f2-9d27-4d1e-8a1f-1f9d0f2a7c11"
});

describe("verification roles", () => {
  it("lets only an owner start verification or record a decision", () => {
    expect(canPerformVerification("start", "owner")).toBe(true);
    expect(canPerformVerification("decide", "owner")).toBe(true);
    for (const role of principalRoles.filter((candidate) => candidate !== "owner")) {
      expect(canPerformVerification("start", role)).toBe(false);
      expect(canPerformVerification("decide", role)).toBe(false);
    }
  });
});

describe("verification transitions", () => {
  it("walks a case from unstarted to a recorded decision", () => {
    expect(canTransitionVerification("unstarted", "started")).toBe(true);
    expect(canTransitionVerification("started", "pending")).toBe(true);
    expect(canTransitionVerification("pending", "verified")).toBe(true);
    expect(canTransitionVerification("pending", "rejected")).toBe(true);
    expect(canTransitionVerification("verified", "expired")).toBe(true);
    expect(canTransitionVerification("expired", "started")).toBe(true);
    expect(canTransitionVerification("rejected", "started")).toBe(true);
  });

  it("refuses a jump straight to verified and other illegal moves", () => {
    expect(canTransitionVerification("unstarted", "verified")).toBe(false);
    expect(canTransitionVerification("unstarted", "pending")).toBe(false);
    expect(canTransitionVerification("rejected", "verified")).toBe(false);
    expect(canTransitionVerification("expired", "verified")).toBe(false);
    expect(canTransitionVerification("verified", "verified")).toBe(false);
    expect(canTransitionVerification("verified", "rejected")).toBe(false);
    expect(canTransitionVerification("started", "started")).toBe(false);
  });

  it("leaves no state without a way out except through a new case", () => {
    for (const status of verificationStatuses) {
      const next = verificationStatuses.filter((candidate) => canTransitionVerification(status, candidate));
      expect(next.length).toBeGreaterThan(0);
    }
  });
});

describe("the capability gate", () => {
  it("refuses cards for an unverified organisation and says why", () => {
    const decision = capabilityAccess("cards", { frozen: false, verification: emptyVerificationState() });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("verification_required");
    expect(decision.reason).toMatch(/verification has not been started/i);
  });

  it("distinguishes a case in review, a rejection and an expiry", () => {
    const reasons = (status: VerificationStatus) => capabilityAccess("cards", { frozen: false, verification: { ...emptyVerificationState(), status } });
    expect(reasons("started")).toMatchObject({ allowed: false, code: "verification_in_review" });
    expect(reasons("pending")).toMatchObject({ allowed: false, code: "verification_in_review" });
    expect(reasons("rejected")).toMatchObject({ allowed: false, code: "verification_rejected" });
    expect(reasons("expired")).toMatchObject({ allowed: false, code: "verification_expired" });
  });

  it("puts a frozen organisation before anything else", () => {
    expect(capabilityAccess("cards", { frozen: true, verification: decided("verified") })).toMatchObject({ allowed: false, code: "organization_frozen" });
  });

  /** Verification is not a card. Floatlane has no issuer, so a verified organisation still has nothing to show. */
  it("still refuses cards once verified, because no card issuer is connected", () => {
    expect(connectedProviders).toHaveLength(0);
    const decision = capabilityAccess("cards", { frozen: false, verification: decided("verified") });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.code).toBe("provider_not_connected");
    expect(decision.reason).toMatch(/no card issuer connected/i);
  });
});

describe("what verification stores", () => {
  it("keeps a state, a case reference, timestamps and a reason, and nothing identity-like", () => {
    expect([...verificationStoredFields]).toEqual(["status", "provider", "reference", "method", "startedAt", "decidedAt", "decidedBy", "reason", "expiresAt"]);
    const state = emptyVerificationState();
    expect(Object.keys(state).sort()).toEqual([...verificationStoredFields].sort());
    for (const field of verificationStoredFields) {
      expect(/name|address|birth|passport|document|tax|registration|photo|file|owner/i.test(field)).toBe(false);
    }
  });

  it("refuses identity fields smuggled into a start or a decision", () => {
    expect(verificationStartSchema.safeParse({}).success).toBe(true);
    expect(verificationStartSchema.safeParse({ passportNumber: "X1234567" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", documents: ["passport.pdf"] }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", taxId: "GB123456789" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", beneficialOwners: [{ dateOfBirth: "1990-01-01" }] }).success).toBe(false);
  });

  it("refuses a reason that carries a document number or a scan", () => {
    expect(verificationDecisionSchema.safeParse({ status: "verified", reason: "Company register checked by hand" }).success).toBe(true);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reason: "Passport 123456789 seen" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reason: "Scan: data:image/png;base64,iVBORw0KGgo" }).success).toBe(false);
  });

  it("only lets a decision move to a decided state", () => {
    expect(verificationDecisionSchema.safeParse({ status: "started" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "unstarted" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "pending" }).success).toBe(true);
  });
});

describe("what the console is told", () => {
  it("says plainly that no provider is connected and that a decision was made by hand", () => {
    const unstarted = describeVerification(emptyVerificationState());
    expect(unstarted.providerConnected).toBe(false);
    expect(unstarted.canStart).toBe(true);
    expect(unstarted.detail).toMatch(/no verification provider connected/i);

    const verified = describeVerification(decided("verified"));
    expect(verified.headline).toMatch(/recorded decision/i);
    expect(verified.detail).toMatch(/by a person, not by a provider/i);
    expect(verified.canStart).toBe(false);
  });

  it("offers a restart after a rejection or an expiry", () => {
    expect(describeVerification(decided("rejected")).canStart).toBe(true);
    expect(describeVerification(decided("expired")).canStart).toBe(true);
  });
});
