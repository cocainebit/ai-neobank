import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signSolanaMessage } from "@ai-neobank/auth";
import type { PostgresControlPlaneStore, SqlRunner, VerificationCaseRecord } from "@ai-neobank/database";
import {
  attestationStatement,
  canTransitionVerification,
  emptyVerificationState,
  type PrincipalRole,
  type VerificationProfile,
  type VerificationStatus
} from "@ai-neobank/domain";
import {
  capabilityDecision,
  capabilityGuard,
  capabilityStatusCode,
  registerVerificationRoutes,
  VerificationError,
  verificationView,
  type VerificationCaseGateway,
  type VerificationStateGateway,
  type VerificationSubject,
  type VerificationTransitionInput
} from "./verification-routes.js";

const subject = (overrides: Partial<VerificationSubject> = {}): VerificationSubject => ({ ...emptyVerificationState(), frozen: false, ...overrides });

const organizationId = "3b7f0f1c-3d0b-4a5e-9a2f-4d3c2b1a0e99";
const principalId = "b2b9b2f2-9d27-4d1e-8a1f-1f9d0f2a7c11";
const otherPrincipalId = "c7c2d1e0-5a44-4b1e-9f22-0b4a7d6c5e33";
const startedAt = "2026-09-21T10:00:00.000Z";

const profile: VerificationProfile = {
  legalName: "Harbour Freight Systems Ltd",
  entityType: "company",
  registrationNumber: "SC-44192",
  jurisdiction: "GB-SCT",
  registeredAddress: { line1: "12 Commercial Quay", city: "Edinburgh", postalCode: "EH6 6LX", country: "GB" },
  businessDescription: "We route freight bookings for small hauliers and settle the carrier leg for them. Relay would hold the float and pay carriers."
};

/** The draft as it comes back out of storage, which is where the routes read it from. */
const storedProfile = () => JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;

/**
 * The status half of the storage, in memory. It mirrors what the Postgres
 * statements do, including the part that matters: submitting is not deciding,
 * so it moves the status and leaves every decision column alone.
 */
class MemoryState implements VerificationStateGateway {
  constructor(public current: VerificationSubject) {}

  async read(): Promise<VerificationSubject | null> {
    return this.current;
  }

  async transition(_organizationId: string, to: VerificationStatus, actorPrincipalId: string, input: VerificationTransitionInput = {}): Promise<VerificationSubject> {
    if (!canTransitionVerification(this.current.status, to)) throw new VerificationError("verification_transition_not_allowed", `Verification cannot go from ${this.current.status} to ${to}`);
    await input.alsoInTransaction?.(undefined as unknown as SqlRunner);
    // A start clears the previous decision; every other move records one. The
    // reference and the expiry are written exactly as the statements write them.
    this.current = to === "started"
      ? { ...this.current, status: to, startedAt, decidedAt: null, decidedBy: null, method: null, reason: null, reference: input.reference ?? null, expiresAt: null }
      : {
          ...this.current,
          status: to,
          method: "manual",
          decidedAt: "2026-09-21T12:00:00.000Z",
          decidedBy: actorPrincipalId,
          reason: input.reason ?? null,
          reference: input.reference ?? this.current.reference,
          expiresAt: input.expiresAt ?? null
        };
    return this.current;
  }

  async submitForReview(_organizationId: string, _actorPrincipalId: string, write: (tx: SqlRunner) => Promise<void>): Promise<VerificationSubject> {
    if (!canTransitionVerification(this.current.status, "pending")) throw new VerificationError("verification_transition_not_allowed", `Verification cannot go from ${this.current.status} to pending`);
    await write(undefined as unknown as SqlRunner);
    this.current = { ...this.current, status: "pending" };
    return this.current;
  }
}

/** The application half of the storage, in memory. */
class MemoryCases implements VerificationCaseGateway {
  constructor(public record: VerificationCaseRecord | null = null, public wallets: { id: string; chainFamily: "evm" | "svm"; address: string }[] = []) {}

  async read(): Promise<VerificationCaseRecord | null> {
    return this.record;
  }

  async saveProfile(id: string, saved: VerificationProfile): Promise<VerificationCaseRecord> {
    this.record = { organizationId: id, profile: JSON.parse(JSON.stringify(saved)) as Record<string, unknown>, submission: this.record?.submission ?? null, updatedAt: "2026-09-21T11:00:00.000Z" };
    return this.record;
  }

  async recordSubmission(_id: string, input: { statement: string; signature: string; address: string; chainFamily: "evm" | "svm"; submittedBy: string }): Promise<VerificationCaseRecord | null> {
    if (!this.record) return null;
    this.record = {
      ...this.record,
      submission: { submittedAt: "2026-09-21T11:30:00.000Z", submittedBy: input.submittedBy, attestationAddress: input.address, attestationChainFamily: input.chainFamily, statement: input.statement, signature: input.signature }
    };
    return this.record;
  }

  async clearSubmission(): Promise<void> {
    if (this.record) this.record = { ...this.record, submission: null };
  }

  async walletsForPrincipal(): Promise<{ id: string; chainFamily: "evm" | "svm"; address: string }[]> {
    return this.wallets;
  }
}

function buildHarness(options: { state?: VerificationSubject; record?: VerificationCaseRecord | null; wallets?: { id: string; chainFamily: "evm" | "svm"; address: string }[]; role?: PrincipalRole } = {}) {
  const state = new MemoryState(options.state ?? subject({ status: "started", startedAt }));
  const cases = new MemoryCases(options.record ?? null, options.wallets ?? []);
  const app = Fastify();
  registerVerificationRoutes(app, {
    // Never read: both gateways are supplied, so nothing here reaches Postgres.
    store: undefined as unknown as PostgresControlPlaneStore,
    human: (_request, reply, roles) => {
      const role = options.role ?? "owner";
      if (roles && !roles.includes(role)) { void reply.code(403).send({ error: "forbidden" }); return null; }
      return { organizationId, principalId, role };
    },
    gateways: { state, cases }
  });
  return { app, state, cases };
}

const evmWallet = () => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, bound: { id: "w-evm", chainFamily: "evm" as const, address: account.address } };
};

const svmWallet = () => {
  const keypair = Keypair.generate();
  return { keypair, bound: { id: "w-svm", chainFamily: "svm" as const, address: keypair.publicKey.toBase58() } };
};

/** The statement the server builds for this case: profile, organisation, principal, and the case's own start. */
const serverStatement = () => attestationStatement({ profile, organizationId, principalId, at: startedAt });

describe("the application draft", () => {
  it("round-trips: what an owner saves is what the next read gives back", async () => {
    const { app } = buildHarness();
    const saved = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: profile });
    expect(saved.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: "/v1/verification" });
    expect(read.json().data.profile).toEqual(profile);
    expect(saved.json().data.profile).toEqual(profile);
    await app.close();
  });

  it("normalises the jurisdiction on the way in, so the same facts always sign as the same bytes", async () => {
    const { app } = buildHarness();
    await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, jurisdiction: "gb-sct" } });
    const read = await app.inject({ method: "GET", url: "/v1/verification" });
    expect(read.json().data.profile.jurisdiction).toBe("GB-SCT");
    await app.close();
  });

  it("refuses anything that is not an entity fact, including a field that could carry a document", async () => {
    const { app } = buildHarness();
    const person = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, controlPersonName: "A Person" } });
    expect(person.statusCode).toBe(400);
    const document = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, businessDescription: `Freight for hauliers, see data:image/png;base64,AAAA and more words here` } });
    expect(document.statusCode).toBe(400);
    await app.close();
  });

  it("is frozen once the case is with a reviewer: the signature covers those exact facts", async () => {
    const { app } = buildHarness({ state: subject({ status: "pending", startedAt }), record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt } });
    const edit = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, legalName: "Some Other Ltd" } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("verification_profile_locked");
    await app.close();
  });

  it("is frozen once a decision is on file", async () => {
    const { app } = buildHarness({ state: subject({ status: "verified", startedAt, method: "manual", decidedBy: otherPrincipalId, decidedAt: "2026-09-21T12:00:00.000Z" }) });
    const edit = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: profile });
    expect(edit.statusCode).toBe(409);
    await app.close();
  });
});

describe("the statement the owner signs", () => {
  it("is built by the server, from the case's own moment", async () => {
    const { app } = buildHarness({ record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt } });
    const response = await app.inject({ method: "GET", url: "/v1/verification/attestation" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.statement).toBe(serverStatement());
    await app.close();
  });

  it("says in the text that nobody has checked any of it", async () => {
    const statement = serverStatement();
    expect(statement).toContain("Floatlane has not checked any of these facts");
    expect(statement).toContain("Harbour Freight Systems Ltd");
  });

  it("has nothing to hand out while the application is unfinished", async () => {
    const { app } = buildHarness({ record: { organizationId, profile: { legalName: "Harbour Freight Systems Ltd" }, submission: null, updatedAt: startedAt } });
    const response = await app.inject({ method: "GET", url: "/v1/verification/attestation" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("verification_profile_incomplete");
    await app.close();
  });
});

describe("submitting the application", () => {
  const openCase = (wallets: { id: string; chainFamily: "evm" | "svm"; address: string }[]) => buildHarness({
    state: subject({ status: "started", startedAt }),
    record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt },
    wallets
  });

  it("moves started to pending and records who signed it and when, without recording a decision", async () => {
    const { account, bound } = evmWallet();
    const { app, state, cases } = openCase([bound]);
    const signature = await account.signMessage({ message: serverStatement() });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(200);
    expect(state.current.status).toBe("pending");
    expect(response.json().data.status).toBe("pending");
    expect(response.json().data.submission).toEqual({ submittedAt: "2026-09-21T11:30:00.000Z", submittedBy: principalId, attestationAddress: bound.address, statement: serverStatement() });
    expect(cases.record?.submission?.statement).toBe(serverStatement());
    // The words are handed back so a reviewer decides on what was signed; the signature is not.
    expect(JSON.stringify(response.json())).not.toContain(signature);
    // Nobody has decided anything by submitting, so nothing says anybody has.
    expect(response.json().data.decidedBy).toBeNull();
    expect(response.json().data.reviewedAt).toBeNull();
    await app.close();
  });

  it("works the same for a Solana wallet, through the same check as sign-in", async () => {
    const { keypair, bound } = svmWallet();
    const { app, state } = openCase([bound]);
    const signature = signSolanaMessage(serverStatement(), keypair.secretKey);
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(200);
    expect(state.current.status).toBe("pending");
    await app.close();
  });

  it("refuses a signature over a statement the server did not build", async () => {
    const { account, bound } = evmWallet();
    const { app, state, cases } = openCase([bound]);
    const theirOwn = serverStatement().replace("Harbour Freight Systems Ltd", "Harbour Freight Systems PLC");
    const signature = await account.signMessage({ message: theirOwn });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("attestation_signature_invalid");
    expect(state.current.status).toBe("started");
    expect(cases.record?.submission).toBeNull();
    await app.close();
  });

  /**
   * The draft may still be edited while the case is open, so the facts can move
   * between reading the statement and signing it. The server rebuilds the
   * statement from the draft as it stands at submit time, so a signature over
   * the earlier facts no longer covers it and is refused. Nothing is stored,
   * which is what keeps a submission from ever showing a signature beside words
   * it does not cover.
   */
  it("refuses a signature over the facts as they were before the draft was edited", async () => {
    const { account, bound } = evmWallet();
    const { app, state, cases } = openCase([bound]);
    const signature = await account.signMessage({ message: serverStatement() });

    const edited = { ...profile, businessDescription: "We now also factor the carrier invoices ourselves, which is a different business to the one signed for." };
    expect((await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: edited })).statusCode).toBe(200);

    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("attestation_signature_invalid");
    expect(state.current.status).toBe("started");
    expect(cases.record?.submission).toBeNull();

    // Signing the facts as they now stand is what goes through, and what is
    // stored is those words, so the two can never drift apart.
    const now = attestationStatement({ profile: edited, organizationId, principalId, at: startedAt });
    const resigned = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature: await account.signMessage({ message: now }) } });
    expect(resigned.statusCode).toBe(200);
    expect(cases.record?.submission?.statement).toBe(now);
    await app.close();
  });

  it("refuses a signature over the right facts at the wrong moment", async () => {
    const { account, bound } = evmWallet();
    const { app, state } = openCase([bound]);
    const signature = await account.signMessage({ message: attestationStatement({ profile, organizationId, principalId, at: "2026-09-20T10:00:00.000Z" }) });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(401);
    expect(state.current.status).toBe("started");
    await app.close();
  });

  it("refuses a signature from a wallet that is not bound to the principal", async () => {
    const { bound } = evmWallet();
    const stranger = evmWallet();
    const { app, state } = openCase([bound]);
    const signature = await stranger.account.signMessage({ message: serverStatement() });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: stranger.bound.address, signature } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("wallet_not_bound_to_principal");
    expect(state.current.status).toBe("started");
    await app.close();
  });

  it("refuses a bound address with somebody else's signature on it", async () => {
    const { bound } = evmWallet();
    const stranger = evmWallet();
    const { app } = openCase([bound]);
    const signature = await stranger.account.signMessage({ message: serverStatement() });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("will not take a statement from the caller at all", async () => {
    const { account, bound } = evmWallet();
    const { app } = openCase([bound]);
    const signature = await account.signMessage({ message: serverStatement() });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature, statement: "I am verified" } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("refuses an unfinished application, whatever is signed", async () => {
    const { account, bound } = evmWallet();
    const { app, state } = buildHarness({
      state: subject({ status: "started", startedAt }),
      record: { organizationId, profile: { legalName: "Harbour Freight Systems Ltd", entityType: "company" }, submission: null, updatedAt: startedAt },
      wallets: [bound]
    });
    const signature = await account.signMessage({ message: "anything at all" });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("verification_profile_incomplete");
    expect(state.current.status).toBe("started");
    await app.close();
  });

  it("refuses a second submission of a case that is already with a reviewer", async () => {
    const { account, bound } = evmWallet();
    const { app } = buildHarness({
      state: subject({ status: "pending", startedAt }),
      record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt },
      wallets: [bound]
    });
    const signature = await account.signMessage({ message: serverStatement() });
    const response = await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("verification_already_submitted");
    await app.close();
  });
});

describe("what /v1/verification returns", () => {
  it("returns the profile, the requirements and the submission together", async () => {
    const { account, bound } = evmWallet();
    const { app } = buildHarness({
      state: subject({ status: "started", startedAt }),
      record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt },
      wallets: [bound]
    });
    await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature: await account.signMessage({ message: serverStatement() }) } });
    const view = (await app.inject({ method: "GET", url: "/v1/verification" })).json().data;
    expect(view.profile).toEqual(profile);
    expect(view.submission).toEqual({ submittedAt: "2026-09-21T11:30:00.000Z", submittedBy: principalId, attestationAddress: bound.address, statement: serverStatement() });
    expect(view.requirements.map((requirement: { field: string }) => requirement.field)).toContain("businessDescription");
    expect(view.requirements.every((requirement: { why: string }) => requirement.why.length > 0)).toBe(true);
    // The entity type is a closed set, and the console renders what the API states rather than a free text box.
    const entityType = view.requirements.find((requirement: { field: string }) => requirement.field === "entityType");
    expect(entityType.options.map((option: { value: string }) => option.value)).toContain("sole_trader");
    expect(entityType.options.every((option: { label: string }) => option.label.length > 0)).toBe(true);
    // What the application is not, in the domain's words, so the console does not keep its own version of it.
    expect(view.exclusions.join(" ")).toContain("no verification provider connected");
    expect(view.exclusions.join(" ")).toContain("Control persons are disclosed to a verification provider");
    // The signature and the statement are the server's record, not part of the view.
    expect(JSON.stringify(view)).not.toContain("attestationSignature");
    await app.close();
  });

  it("starting again after a rejection drops the old signature and keeps the facts as a draft", async () => {
    const { app, state, cases } = buildHarness({
      state: subject({ status: "rejected", startedAt, method: "manual", decidedBy: otherPrincipalId, decidedAt: "2026-09-21T12:00:00.000Z", reason: "Not enough detail about the business" }),
      record: { organizationId, profile: storedProfile(), submission: { submittedAt: "2026-09-21T11:30:00.000Z", submittedBy: principalId, attestationAddress: "0x0000000000000000000000000000000000000001", attestationChainFamily: "evm", statement: "old", signature: "0xold" }, updatedAt: startedAt }
    });
    const response = await app.inject({ method: "POST", url: "/v1/verification/start" });
    expect(response.statusCode).toBe(201);
    expect(state.current.status).toBe("started");
    expect(cases.record?.submission).toBeNull();
    expect(response.json().data.profile).toEqual(profile);
    expect(response.json().data.submission).toBeNull();
    await app.close();
  });

  it("shows an unstarted organisation with cards locked and says why", () => {
    const view = verificationView(subject());
    expect(view.status).toBe("unstarted");
    expect(view.verification.status).toBe("unstarted");
    expect(view.verification.provider).toBeNull();
    expect(view.provider).toBeNull();
    expect(view.profile).toBeNull();
    expect(view.submission).toBeNull();
    expect(view.requirements.length).toBeGreaterThan(0);
    expect(view.banner.providerConnected).toBe(false);
    expect(view.capabilities.cards).toMatchObject({ allowed: false, code: "verification_required" });
  });

  /** A verified organisation is not a card: there is no issuer, so the tab stays locked and says so. */
  it("keeps cards locked once verified, with the missing issuer as the reason", () => {
    const view = verificationView(subject({ status: "verified", method: "manual", decidedAt: "2026-09-21T10:00:00.000Z", decidedBy: principalId }));
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

describe("who may do what", () => {
  const writes = (payloadProfile: VerificationProfile) => [
    { method: "POST" as const, url: "/v1/verification", payload: {} },
    { method: "POST" as const, url: "/v1/verification/start", payload: {} },
    { method: "PUT" as const, url: "/v1/verification/profile", payload: payloadProfile },
    { method: "POST" as const, url: "/v1/verification/submit", payload: { address: "0x1234567890123456789012345678901234567890", signature: "0x00000000000000000000" } },
    { method: "POST" as const, url: "/v1/verification/decision", payload: { status: "verified" } }
  ];

  for (const role of ["approver", "operator", "auditor", "developer"] as const) {
    it(`lets ${role} read the case and refuses every route that writes to it, including the decision`, async () => {
      const { app, state } = buildHarness({ role, record: { organizationId, profile: storedProfile(), submission: null, updatedAt: startedAt } });
      for (const write of writes(profile)) {
        const response = await app.inject(write);
        expect([write.url, response.statusCode]).toEqual([write.url, 403]);
      }
      // The statement is the application itself, so it is the owner's to read.
      expect((await app.inject({ method: "GET", url: "/v1/verification/attestation" })).statusCode).toBe(403);
      const read = await app.inject({ method: "GET", url: "/v1/verification" });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.status).toBe("started");
      expect(state.current.status).toBe("started");
      await app.close();
    });
  }
});

describe("reaching verified", () => {
  /**
   * The whole applicant-side flow, walked end to end. Everything an owner can
   * do on their own gets the case to "with a reviewer" and no further: opening
   * it, filling it in, reading the statement and signing it. Verified is a
   * decision somebody records, and the decision route is the only thing in this
   * build that writes it.
   */
  it("cannot be reached by any call an applicant makes, however far the flow is walked", async () => {
    const { account, bound } = evmWallet();
    const { app, state } = buildHarness({ state: subject({ status: "unstarted" }), wallets: [bound] });

    expect((await app.inject({ method: "POST", url: "/v1/verification", payload: {} })).statusCode).toBe(201);
    expect((await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: profile })).statusCode).toBe(200);
    const statement = (await app.inject({ method: "GET", url: "/v1/verification/attestation" })).json().data.statement as string;
    const signature = await account.signMessage({ message: statement });
    expect((await app.inject({ method: "POST", url: "/v1/verification/submit", payload: { address: bound.address, signature } })).statusCode).toBe(200);

    expect(state.current.status).toBe("pending");
    expect(state.current.decidedBy).toBeNull();
    expect(state.current.decidedAt).toBeNull();
    expect(state.current.method).toBeNull();

    // Only now, and only through the decision, and it carries the decider's name.
    const decided = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified" } });
    expect(decided.statusCode).toBe(200);
    expect(state.current.status).toBe("verified");
    expect(state.current.decidedBy).toBe(principalId);
    await app.close();
  });

  it("has no route to it but the decision, and that refuses a move the state machine does not allow", async () => {
    const { app, state } = buildHarness({ state: subject({ status: "unstarted" }) });
    const response = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("verification_transition_not_allowed");
    expect(state.current.status).toBe("unstarted");
    await app.close();
  });

  /**
   * An owner may decide a case they submitted themselves: nothing here requires
   * a second person, and the console says so. What the record must never do is
   * claim anybody but that person decided it.
   */
  it("records the person who decided, as a manual decision with no provider on it", async () => {
    const { app } = buildHarness({
      state: subject({ status: "pending", startedAt }),
      record: { organizationId, profile: storedProfile(), submission: { submittedAt: "2026-09-21T11:30:00.000Z", submittedBy: principalId, attestationAddress: "0x0000000000000000000000000000000000000001", attestationChainFamily: "evm", statement: serverStatement(), signature: "0xsigned" }, updatedAt: startedAt }
    });
    const response = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified", reason: "Read the attestation and the register entry matches the name given" } });
    expect(response.statusCode).toBe(200);
    const view = response.json().data;
    expect(view.status).toBe("verified");
    expect(view.decidedBy).toBe(principalId);
    expect(view.method).toBe("manual");
    expect(view.provider).toBeNull();
    // Verified is not a card: the issuer is still missing, so the gate stays shut.
    expect(view.capabilities.cards).toMatchObject({ allowed: false, code: "provider_not_connected" });
    expect(view.capabilities.cards.reason).toContain("no card issuer connected");
    await app.close();
  });

  it("will not take a provider, a method or a decider from the caller", async () => {
    const { app } = buildHarness({ state: subject({ status: "pending", startedAt }) });
    for (const payload of [{ status: "verified", provider: "Acme KYB" }, { status: "verified", method: "provider" }, { status: "verified", decidedBy: otherPrincipalId }]) {
      const response = await app.inject({ method: "POST", url: "/v1/verification/decision", payload });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  /** A case reference is an identifier, so it may hold digits. It may not hold a pasted file. */
  it("refuses a pasted document in the case reference and keeps a reference that is a number", async () => {
    const { app } = buildHarness({ state: subject({ status: "pending", startedAt }) });
    const pasted = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified", reference: "data:image/png;base64,iVBORw0KGgo=" } });
    expect(pasted.statusCode).toBe(400);
    const sentence = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified", reference: "Signed off by the director, see attached: passport" } });
    expect(sentence.statusCode).toBe(400);
    const kept = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "verified", reference: "REV-2026-0091" } });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().data.reference).toBe("REV-2026-0091");
    await app.close();
  });

  it("refuses a pasted document and a document number in the reason", async () => {
    const { app } = buildHarness({ state: subject({ status: "pending", startedAt }) });
    for (const reason of [
      "See data:application/pdf;base64,AAAA for the certificate",
      "Checked against document 9001234567",
      // The same two data URLs with no media type in them, which the reason
      // field took while the rule insisted on a type and a subtype.
      "See data:;base64,JVBERi0xLjQK for the certificate",
      "See data:,the%20certificate"
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "rejected", reason } });
      expect([reason, response.statusCode]).toEqual([reason, 400]);
    }
    await app.close();
  });

  /**
   * "With a reviewer" is a state the owner reaches by submitting and signing,
   * never a decision somebody records. The route refuses it by name, and the
   * console must not offer it: see `decisionCopy` in apps/web/lib/verification.ts,
   * which used to list it first and so had it selected by default.
   */
  it("refuses to be told a case is with a reviewer, because that is a submission and not a decision", async () => {
    for (const from of ["started", "pending"] as const) {
      const { app, state } = buildHarness({ state: subject({ status: from, startedAt }) });
      const response = await app.inject({ method: "POST", url: "/v1/verification/decision", payload: { status: "pending" } });
      expect([from, response.statusCode]).toEqual([from, 409]);
      expect(response.json().error).toBe("verification_not_submitted");
      expect(state.current.status).toBe(from);
      // Nobody is recorded as having decided anything.
      expect(state.current.decidedBy).toBeNull();
      expect(state.current.decidedAt).toBeNull();
      await app.close();
    }
  });
});

/**
 * The draft may only be edited while the case is open. Everywhere else there is
 * a signature or a decision standing against those exact facts, and editing the
 * facts underneath one would leave the console showing an attestation beside
 * words it does not cover.
 */
describe("editing the facts after they were signed for", () => {
  const submitted = {
    submittedAt: "2026-09-21T11:30:00.000Z",
    submittedBy: principalId,
    attestationAddress: "0x0000000000000000000000000000000000000001",
    attestationChainFamily: "evm" as const,
    statement: "the words that were signed",
    signature: "0xsigned"
  };

  for (const status of ["rejected", "expired"] as const) {
    it(`is refused on a ${status} case, whose signature is still on file`, async () => {
      const { app, cases } = buildHarness({
        state: subject({ status, startedAt, method: "manual", decidedBy: otherPrincipalId, decidedAt: "2026-09-21T12:00:00.000Z" }),
        record: { organizationId, profile: storedProfile(), submission: submitted, updatedAt: startedAt }
      });
      const edit = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, legalName: "Somebody Else Holdings Ltd" } });
      expect(edit.statusCode).toBe(409);
      expect(edit.json().error).toBe("verification_profile_locked");
      expect((cases.record?.profile as { legalName: string }).legalName).toBe(profile.legalName);
      // The way to change them: a new case, which drops the signature and keeps the draft.
      const again = await app.inject({ method: "POST", url: "/v1/verification/start" });
      expect(again.statusCode).toBe(201);
      expect(again.json().data.submission).toBeNull();
      const edited = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, legalName: "Somebody Else Holdings Ltd" } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().data.submission).toBeNull();
      await app.close();
    });
  }

  it("is refused before a case is open at all", async () => {
    const { app } = buildHarness({ state: subject({ status: "unstarted" }) });
    const edit = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: profile });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("verification_not_started");
    await app.close();
  });

  /** Whatever is on file, the words shown beside a submission are the words that were signed. */
  it("hands back the stored statement, never a rebuild of the current facts", async () => {
    const { app } = buildHarness({
      state: subject({ status: "pending", startedAt }),
      record: { organizationId, profile: storedProfile(), submission: submitted, updatedAt: startedAt }
    });
    const view = (await app.inject({ method: "GET", url: "/v1/verification" })).json().data;
    expect(view.submission.statement).toBe("the words that were signed");
    expect(JSON.stringify(view)).not.toContain("0xsigned");
    await app.close();
  });
});

describe("what a field will not take", () => {
  const pasted = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=";
  const documentNumber = "Passport 9001234567 held on file";

  async function put(patch: Record<string, unknown>) {
    const { app } = buildHarness();
    const response = await app.inject({ method: "PUT", url: "/v1/verification/profile", payload: { ...profile, ...patch } });
    await app.close();
    return response.statusCode;
  }

  const address = (patch: Record<string, unknown>) => put({ registeredAddress: { ...profile.registeredAddress, ...patch } });

  it("refuses a pasted document in every field an applicant types into", async () => {
    expect(await put({ legalName: pasted })).toBe(400);
    expect(await put({ businessDescription: `We move freight ${pasted} for hauliers` })).toBe(400);
    expect(await put({ website: pasted })).toBe(400);
    expect(await put({ jurisdiction: pasted })).toBe(400);
    expect(await put({ registrationNumber: pasted })).toBe(400);
    expect(await address({ line1: pasted })).toBe(400);
    expect(await address({ line2: pasted })).toBe(400);
    expect(await address({ city: pasted })).toBe(400);
    expect(await address({ region: pasted })).toBe(400);
    expect(await address({ postalCode: pasted })).toBe(400);
    expect(await address({ country: pasted })).toBe(400);
  });

  it("refuses a document number in every field that takes typed words", async () => {
    expect(await put({ legalName: documentNumber })).toBe(400);
    expect(await put({ businessDescription: `${documentNumber}. We move freight for hauliers.` })).toBe(400);
    expect(await address({ line1: documentNumber })).toBe(400);
    expect(await address({ line2: documentNumber })).toBe(400);
    expect(await address({ city: documentNumber })).toBe(400);
    expect(await address({ region: documentNumber })).toBe(400);
  });

  /**
   * The media type is optional in the data URL grammar, so `data:;base64,` and
   * `data:,` are whole working data URLs with nothing between the scheme and
   * the payload. A rule that insisted on a `type/subtype` took both, which
   * meant a scan pasted under either spelling was stored in a field whose whole
   * promise is that it holds no document.
   */
  it("refuses a pasted document that names no media type, in every field an applicant types into", async () => {
    for (const scan of ["data:;base64,iVBORw0KGgoAAAANSUhEUg=", "data:,scanned%20passport"]) {
      expect([scan, await put({ legalName: scan })]).toEqual([scan, 400]);
      expect([scan, await put({ businessDescription: `We move freight for hauliers ${scan}` })]).toEqual([scan, 400]);
      expect([scan, await put({ website: scan })]).toEqual([scan, 400]);
      expect([scan, await address({ line1: scan })]).toEqual([scan, 400]);
      expect([scan, await address({ line2: scan })]).toEqual([scan, 400]);
      expect([scan, await address({ city: scan })]).toEqual([scan, 400]);
      expect([scan, await address({ region: scan })]).toEqual([scan, 400]);
    }
  });

  /** The rule is about a pasted file, not about the word. Ordinary prose keeps working. */
  it("still takes a sentence that merely uses the word data", async () => {
    expect(await put({ businessDescription: "We reconcile carrier data: rates, invoices and proof of delivery, for small hauliers." })).toBe(200);
  });

  it("refuses a control person wherever it is hidden, including inside the address", async () => {
    expect(await put({ controlPerson: "A Person" })).toBe(400);
    expect(await put({ dateOfBirth: "1980-01-01" })).toBe(400);
    expect(await address({ occupant: "A Person" })).toBe(400);
    expect(await put({ registrationNumber: "Jane Doe" })).toBe(400);
  });

  /**
   * The two fields that are register identifiers keep their digits, because
   * digits are what they are. The postal code is the one place a short run of
   * digits is not refused, which is what a postal code is: it is held to 16
   * characters of the register's own character set and nothing else.
   */
  it("keeps the numbers the register issued", async () => {
    expect(await put({ registrationNumber: "SC123456789012" })).toBe(200);
    expect(await address({ postalCode: "560001" })).toBe(200);
    expect(await address({ postalCode: "12345678901234567" })).toBe(400);
  });
});

/**
 * The gate the restricted routes actually call, against a database that answers
 * with one organisation. Cards are shut while the case is undecided, and shut
 * after it is decided too, because a decision is not a card issuer.
 */
describe("the gate a restricted route reads", () => {
  const storeFor = (row: VerificationSubject | undefined) => ({
    sql: { unsafe: async () => (row ? [row] : []) }
  }) as unknown as PostgresControlPlaneStore;

  it("shuts cards for every state but a decided one, and shuts them then for want of an issuer", async () => {
    for (const status of ["unstarted", "started", "pending", "rejected", "expired"] as const) {
      const decision = await capabilityDecision(storeFor(subject({ status })), organizationId, "cards");
      expect([status, decision.allowed]).toEqual([status, false]);
      expect(capabilityStatusCode((decision as { code: Parameters<typeof capabilityStatusCode>[0] }).code)).toBe(403);
    }
    const verified = await capabilityDecision(storeFor(subject({ status: "verified", method: "manual", decidedBy: principalId })), organizationId, "cards");
    expect(verified).toMatchObject({ allowed: false, code: "provider_not_connected" });
    expect(capabilityStatusCode("provider_not_connected")).toBe(503);
  });

  it("refuses the caller with the reason, and says nothing was unlocked when the organisation cannot be read", async () => {
    const replies: { code: number; body: unknown }[] = [];
    const reply = {
      code(code: number) { replies.push({ code, body: null }); return this; },
      send(body: unknown) { const last = replies[replies.length - 1]; if (last) last.body = body; return this; }
    } as unknown as Parameters<typeof capabilityGuard>[0];

    expect(await capabilityGuard(reply, storeFor(subject({ status: "started" })), organizationId, "cards")).toBe(true);
    expect(replies[0]?.code).toBe(403);
    expect((replies[0]?.body as { message: string }).message).toMatch(/has not been decided/);

    const missing = await capabilityDecision(storeFor(undefined), organizationId, "cards");
    expect(missing).toMatchObject({ allowed: false, code: "organization_not_found" });
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
