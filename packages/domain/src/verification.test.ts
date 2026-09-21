import { describe, expect, it } from "vitest";
import { principalRoles } from "./index.js";
import {
  attestationStatement,
  canPerformVerification,
  canSubmitVerification,
  canTransitionVerification,
  capabilityAccess,
  connectedProviders,
  describeVerification,
  emptyVerificationState,
  entityTypes,
  profileComplete,
  verificationAddressSchema,
  verificationDecisionSchema,
  verificationDecisionStatuses,
  verificationProfileExclusions,
  verificationProfileRequirements,
  verificationProfileSchema,
  verificationReasonSchema,
  verificationStartSchema,
  verificationStatuses,
  verificationStoredFields,
  verificationSubmitBlocks,
  verificationSubmitCheck,
  verificationTransitions,
  type VerificationProfileInput,
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

  /**
   * The one decision field that may hold digits, because a case reference is
   * usually a number. A narrow character set does the work the free-text rule
   * cannot do here: a data URL and a sentence about a person both fail it.
   */
  it("keeps a case reference that is an identifier and refuses one that is a document or a sentence", () => {
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "REV-2026-0091" }).success).toBe(true);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "900123456789" }).success).toBe(true);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "case/2026 #14" }).success).toBe(true);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "data:image/png;base64,iVBORw0KGgo=" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "Passport seen: number 9001234567" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "verified", reference: "" }).success).toBe(false);
  });

  /**
   * A decision is one of the three states a person can actually decide.
   * "pending" is not one of them: a case is with a reviewer because its owner
   * submitted it with a signed attestation, so a hand-recorded "pending" would
   * claim a submission that never happened.
   */
  it("only lets a decision move to a state a person decided", () => {
    expect([...verificationDecisionStatuses]).toEqual(["verified", "rejected", "expired"]);
    expect(verificationDecisionSchema.safeParse({ status: "started" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "unstarted" }).success).toBe(false);
    expect(verificationDecisionSchema.safeParse({ status: "pending" }).success).toBe(false);
    for (const status of verificationDecisionStatuses) {
      expect([status, verificationDecisionSchema.safeParse({ status }).success]).toEqual([status, true]);
      // Every one of them is a state the machine treats as decided: it needs a new case to leave.
      expect([status, verificationTransitions[status].includes("started")]).toEqual([status, status !== "verified"]);
    }
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

/** A filled-in application. Every value here is entity data a register publishes, or the applicant's own words. */
const application = (): VerificationProfileInput => ({
  legalName: "Northwind Widgets Ltd",
  entityType: "company",
  registrationNumber: "08122252",
  jurisdiction: "GB",
  registeredAddress: { line1: "12 Bartholomew Close", line2: "Second floor", city: "London", region: "Greater London", postalCode: "EC1A 7BL", country: "GB" },
  website: "https://northwind.example",
  businessDescription: "We sell warehouse shelving to other businesses and pay our suppliers from Relay."
});

/** Same profile, parsed, which is the form the statement and the store both hold. */
const parsedApplication = () => verificationProfileSchema.parse(application());

const requiredPaths = ["legalName", "entityType", "registrationNumber", "jurisdiction", "registeredAddress", "registeredAddress.line1", "registeredAddress.city", "registeredAddress.postalCode", "registeredAddress.country", "businessDescription"];
const optionalPaths = ["registeredAddress.line2", "registeredAddress.region", "website"];

/** The same application with one path missing. */
function without(path: string): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(application())) as Record<string, unknown>;
  const [head, tail] = path.split(".");
  if (!tail) delete copy[head as string];
  else delete (copy[head as string] as Record<string, unknown>)[tail];
  return copy;
}

const withFreeText = (path: string, value: string) => {
  const copy = JSON.parse(JSON.stringify(application())) as Record<string, unknown>;
  const [head, tail] = path.split(".");
  if (!tail) copy[head as string] = value;
  else (copy[head as string] as Record<string, unknown>)[tail] = value;
  return copy;
};

describe("the business profile the application collects", () => {
  it("accepts a filled-in application and normalises what it stores", () => {
    const parsed = verificationProfileSchema.safeParse({ ...application(), legalName: "  Northwind Widgets Ltd  ", jurisdiction: "gb", registeredAddress: { ...application().registeredAddress, country: "gb" } });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.legalName).toBe("Northwind Widgets Ltd");
    expect(parsed.data.jurisdiction).toBe("GB");
    expect(parsed.data.registeredAddress.country).toBe("GB");
    // Normalising twice has to change nothing, or the statement the server rebuilds would not match the one that was signed.
    expect(verificationProfileSchema.parse(parsed.data)).toEqual(parsed.data);
  });

  it("refuses a field it does not know, so no personal data can ride along", () => {
    for (const extra of [
      { directorName: "A Person" },
      { dateOfBirth: "1990-01-01" },
      { beneficialOwners: [{ name: "A Person" }] },
      { passportNumber: "X1234567" },
      { documents: ["incorporation.pdf"] },
      { photograph: "data:image/png;base64,iVBORw0KGgo" }
    ]) {
      expect(verificationProfileSchema.safeParse({ ...application(), ...extra }).success).toBe(false);
    }
    expect(verificationAddressSchema.safeParse({ ...application().registeredAddress, residentOf: "A Person" }).success).toBe(false);
  });

  it("refuses a long digit run in every free-text field", () => {
    for (const path of ["legalName", "businessDescription", "registeredAddress.line1", "registeredAddress.line2", "registeredAddress.city", "registeredAddress.region"]) {
      const prose = `Northwind, see identifier 123456789012 for the rest of the detail here`;
      expect(verificationProfileSchema.safeParse(withFreeText(path, prose)).success).toBe(false);
    }
  });

  it("refuses a data URL in every free-text field and in the website", () => {
    for (const path of ["legalName", "businessDescription", "registeredAddress.line1", "registeredAddress.line2", "registeredAddress.city", "registeredAddress.region"]) {
      const scan = `Scan attached data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB`;
      expect(verificationProfileSchema.safeParse(withFreeText(path, scan)).success).toBe(false);
    }
    expect(verificationProfileSchema.safeParse(withFreeText("website", "data:text/html;base64,PGh0bWw+")).success).toBe(false);
    expect(verificationProfileSchema.safeParse(withFreeText("website", "northwind.example")).success).toBe(false);
    expect(verificationProfileSchema.safeParse(withFreeText("website", "http://northwind.example")).success).toBe(true);
  });

  /**
   * The media type is optional in the data URL grammar: `data:;base64,` and
   * `data:,` are whole working data URLs. A rule written for `type/subtype`
   * alone took a scan pasted under either spelling and stored it in a field
   * whose whole promise is that it holds no document.
   */
  it("refuses a data URL that names no media type, which is still a data URL", () => {
    for (const path of ["legalName", "businessDescription", "registeredAddress.line1", "registeredAddress.line2", "registeredAddress.city", "registeredAddress.region"]) {
      for (const scan of ["Scan attached data:;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "Scan attached data:,scanned%20passport"]) {
        expect([path, scan, verificationProfileSchema.safeParse(withFreeText(path, scan)).success]).toEqual([path, scan, false]);
      }
    }
    for (const scan of ["data:;base64,iVBORw0KGgo", "data:,scan"]) {
      expect(verificationProfileSchema.safeParse(withFreeText("website", scan)).success).toBe(false);
      expect(verificationReasonSchema.safeParse(`The certificate is at ${scan}`).success).toBe(false);
    }
  });

  /**
   * The rule refuses a pasted file, not the word. A description that happens to
   * use "data:" as ordinary punctuation is exactly the prose this field is for.
   */
  it("still takes prose that uses the word data before a list", () => {
    const prose = "We reconcile carrier data: rates, invoices and proof of delivery, for small hauliers across the country.";
    expect(verificationProfileSchema.safeParse(withFreeText("businessDescription", prose)).success).toBe(true);
    expect(verificationReasonSchema.safeParse("Checked the register data: the name and number match").success).toBe(true);
  });

  /**
   * What these two rules do not do, stated so nobody reads more into them. They
   * refuse a pasted document, not a typed word: a separated identifier, a date
   * of birth and a person's name all read as ordinary prose and pass. What
   * keeps those out of Relay is that no field asks for one and the schema is
   * strict, not this filter, and the console's copy says so in those words.
   */
  it("does not pretend to catch a person's details typed into a sentence", () => {
    for (const typed of ["Our founder is Jane Doe", "Registered 1985-03-12 in Leith", "Reference 123-45-6789 on the file"]) {
      expect([typed, verificationProfileSchema.safeParse(withFreeText("businessDescription", `${typed}, and we move freight for hauliers.`)).success]).toEqual([typed, true]);
    }
  });

  /** A company number is a digit run by nature, so it is held to a character set instead of the free-text rule. */
  it("takes a register's own number as the register writes it, and nothing else", () => {
    for (const number of ["08122252", "HRB 12345", "LLC-2019/0001", "556036-0793"]) {
      expect(verificationProfileSchema.safeParse({ ...application(), registrationNumber: number }).success).toBe(true);
    }
    for (const notANumber of ["data:image/png;base64,iVBORw0KGgo", "see attached passport, number below", "A Person", "", "  "]) {
      expect(verificationProfileSchema.safeParse({ ...application(), registrationNumber: notANumber }).success).toBe(false);
    }
    expect(verificationProfileSchema.safeParse(withFreeText("registeredAddress.postalCode", "EC1A 7BL")).success).toBe(true);
    expect(verificationProfileSchema.safeParse(withFreeText("registeredAddress.postalCode", "data:image/png;base64,iVBOR")).success).toBe(false);
  });

  it("requires every required answer and lets the optional ones go missing", () => {
    for (const path of requiredPaths) {
      expect(verificationProfileSchema.safeParse(without(path)).success).toBe(false);
    }
    for (const path of optionalPaths) {
      expect(verificationProfileSchema.safeParse(without(path)).success).toBe(true);
    }
  });

  it("wants a jurisdiction, an entity type and a description a reviewer can read", () => {
    expect(verificationProfileSchema.safeParse({ ...application(), jurisdiction: "US-DE" }).success).toBe(true);
    expect(verificationProfileSchema.safeParse({ ...application(), jurisdiction: "United Kingdom" }).success).toBe(false);
    expect(verificationProfileSchema.safeParse({ ...application(), entityType: "llc" }).success).toBe(false);
    expect(verificationProfileSchema.safeParse({ ...application(), businessDescription: "Widgets" }).success).toBe(false);
  });

  it("holds no field that reads as a person", () => {
    const paths = [...Object.keys(verificationProfileSchema.shape), ...Object.keys(verificationAddressSchema.shape)];
    for (const path of paths) {
      expect(/birth|passport|document|photo|scan|nationalid|ssn|director|officer|beneficial|person/i.test(path)).toBe(false);
    }
  });
});

describe("what the application tells the applicant", () => {
  const schemaPaths = Object.keys(verificationProfileSchema.shape).flatMap((key) =>
    key === "registeredAddress" ? Object.keys(verificationAddressSchema.shape).map((inner) => `registeredAddress.${inner}`) : [key]
  );

  it("asks for exactly what the schema accepts, and says why for each one", () => {
    expect(verificationProfileRequirements.map((item) => item.field).sort()).toEqual([...schemaPaths].sort());
    for (const item of verificationProfileRequirements) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  it("marks a field required exactly when the schema does", () => {
    const shapes: Record<string, unknown> = { ...verificationProfileSchema.shape, ...Object.fromEntries(Object.entries(verificationAddressSchema.shape).map(([key, value]) => [`registeredAddress.${key}`, value])) };
    for (const item of verificationProfileRequirements) {
      const field = shapes[item.field] as { safeParse: (value: unknown) => { success: boolean } };
      expect(field.safeParse(undefined).success).toBe(!item.required);
    }
  });

  it("offers the entity types the schema knows and no others", () => {
    const entityType = verificationProfileRequirements.find((item) => item.field === "entityType");
    expect(entityType?.options?.map((option) => option.value)).toEqual([...entityTypes]);
  });

  it("reads in a sensible order, with the address together and the description last", () => {
    const fields = verificationProfileRequirements.map((item) => item.field);
    expect(fields[0]).toBe("legalName");
    expect(fields[fields.length - 1]).toBe("businessDescription");
    const addressAt = fields.map((field, index) => (field.startsWith("registeredAddress.") ? index : -1)).filter((index) => index >= 0);
    expect(addressAt.length).toBeGreaterThan(1);
    expect((addressAt.at(-1) ?? 0) - (addressAt.at(0) ?? 0)).toBe(addressAt.length - 1);
  });

  it("says that nothing is checked and that control persons are not collected here", () => {
    const text = verificationProfileExclusions.join(" ");
    expect(text).toMatch(/no verification provider connected/i);
    expect(text).toMatch(/control persons are disclosed to a verification provider/i);
    expect(text).toMatch(/no document, scan or photograph/i);
    expect(text).toMatch(/a named person/i);
    expect(verificationProfileExclusions.join("")).not.toMatch(/\u2014/);
  });
});

describe("the attestation the owner signs", () => {
  const at = "2026-09-21T10:00:00.000Z";
  const organizationId = "4f2c1f5a-1d3b-4c5e-9f7a-0b1c2d3e4f50";
  const principalId = "b2b9b2f2-9d27-4d1e-8a1f-1f9d0f2a7c11";
  const statement = () => attestationStatement({ profile: parsedApplication(), organizationId, principalId, at });

  it("names the business and what it is", () => {
    const text = statement();
    expect(text).toContain("Legal name: Northwind Widgets Ltd");
    expect(text).toContain("Entity type: Company");
    expect(text).toContain("Registration number: 08122252");
    expect(text).toContain("Jurisdiction: GB");
    expect(text).toContain("Registered address: 12 Bartholomew Close, Second floor, London, Greater London, EC1A 7BL, GB");
    expect(text).toContain("Website: https://northwind.example");
    expect(text).toContain("We sell warehouse shelving to other businesses");
  });

  it("says what the signer attests to", () => {
    const text = statement();
    expect(text).toMatch(/I am authorised to make this statement/i);
    expect(text).toMatch(/true and complete so far as I know/i);
    expect(text).toMatch(/match the\n?\s*public register/i);
  });

  it("says that nobody has checked it, that there is no licence, and what verified means", () => {
    const text = statement();
    expect(text).toMatch(/Floatlane has not checked any of these facts/i);
    expect(text).toMatch(/No verification provider is\n?\s*connected/i);
    expect(text).toMatch(/no document\n?\s*has been asked for, accepted or stored/i);
    expect(text).toMatch(/holds no banking, money transmission or e-money licence/i);
    expect(text).toMatch(/a named person at Floatlane reads this\n?\s*statement and records a decision under their own name/i);
    expect(text).toMatch(/Control persons are\n?\s*disclosed to a verification provider on the day one exists/i);
  });

  it("binds the signature to this organisation, this person and this moment", () => {
    const text = statement();
    expect(text).toContain(`Organisation: ${organizationId}`);
    expect(text).toContain(`Signed by principal: ${principalId}`);
    expect(text).toContain(`Signed at: ${at}`);
    expect(text).toMatch(/not valid for any other organisation/i);
  });

  it("is byte-identical for identical inputs, whatever shape the moment arrives in", () => {
    expect(statement()).toBe(statement());
    expect(attestationStatement({ profile: parsedApplication(), organizationId, principalId, at: new Date(at) })).toBe(statement());
    expect(attestationStatement({ profile: parsedApplication(), organizationId, principalId, at: "2026-09-21T10:00:00Z" })).toBe(statement());
    // The server reparses whatever came back out of storage, so stray whitespace and case cannot change the bytes.
    const untidy = verificationProfileSchema.parse({ ...application(), legalName: " Northwind Widgets Ltd ", jurisdiction: "gb" });
    expect(attestationStatement({ profile: untidy, organizationId, principalId, at })).toBe(statement());
  });

  it("differs when the organisation, the person, the business or the moment differs", () => {
    const base = statement();
    expect(attestationStatement({ profile: parsedApplication(), organizationId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", principalId, at })).not.toBe(base);
    expect(attestationStatement({ profile: parsedApplication(), organizationId, principalId: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", at })).not.toBe(base);
    expect(attestationStatement({ profile: verificationProfileSchema.parse({ ...application(), legalName: "Southwind Widgets Ltd" }), organizationId, principalId, at })).not.toBe(base);
    expect(attestationStatement({ profile: verificationProfileSchema.parse({ ...application(), registrationNumber: "08122253" }), organizationId, principalId, at })).not.toBe(base);
    expect(attestationStatement({ profile: parsedApplication(), organizationId, principalId, at: "2026-09-21T10:00:01.000Z" })).not.toBe(base);
  });

  it("says so when there is no website, rather than leaving a gap", () => {
    const noSite = verificationProfileSchema.parse(without("website"));
    expect(attestationStatement({ profile: noSite, organizationId, principalId, at })).toContain("Website: none given");
  });

  it("refuses to build a statement that could not be checked later", () => {
    const incomplete = without("legalName") as never;
    expect(() => attestationStatement({ profile: incomplete, organizationId, principalId, at })).toThrow(/not complete/i);
    expect(() => attestationStatement({ profile: parsedApplication(), organizationId: "  ", principalId, at })).toThrow(/names the organisation/i);
    expect(() => attestationStatement({ profile: parsedApplication(), organizationId, principalId: "", at })).toThrow(/names the organisation/i);
    expect(() => attestationStatement({ profile: parsedApplication(), organizationId, principalId, at: "not a date" })).toThrow(/moment/i);
  });

  it("carries no em dash, because a person signs these bytes", () => {
    expect(statement()).not.toMatch(/\u2014/);
  });
});

describe("submitting the application for review", () => {
  const started = (profile: unknown) => verificationSubmitCheck({ status: "started", profile });

  it("goes to a reviewer once the case is open and the application is finished", () => {
    expect(started(parsedApplication())).toEqual({ ok: true });
    expect(canSubmitVerification({ status: "started", profile: parsedApplication() })).toBe(true);
  });

  it("holds an unfinished application back and says which part is missing to fill in", () => {
    const check = started(without("businessDescription"));
    expect(check).toMatchObject({ ok: false, code: "verification_profile_incomplete" });
    expect(started(null)).toMatchObject({ ok: false, code: "verification_profile_incomplete" });
    expect(profileComplete(without("businessDescription"))).toBe(false);
    expect(profileComplete(parsedApplication())).toBe(true);
    expect(profileComplete(null)).toBe(false);
  });

  it("agrees with the state machine about which cases can be submitted", () => {
    for (const status of verificationStatuses) {
      const allowedByMachine = canTransitionVerification(status, "pending");
      expect(canSubmitVerification({ status, profile: parsedApplication() })).toBe(allowedByMachine);
    }
  });

  it("refuses to resubmit a case that is already with a reviewer or already decided", () => {
    expect(verificationSubmitCheck({ status: "pending", profile: parsedApplication() })).toMatchObject({ ok: false, code: "verification_already_submitted" });
    expect(verificationSubmitCheck({ status: "verified", profile: parsedApplication() })).toMatchObject({ ok: false, code: "verification_already_verified" });
    expect(verificationSubmitCheck({ status: "unstarted", profile: parsedApplication() })).toMatchObject({ ok: false, code: "verification_not_started" });
    expect(verificationSubmitCheck({ status: "rejected", profile: parsedApplication() })).toMatchObject({ ok: false, code: "verification_rejected" });
    expect(verificationSubmitCheck({ status: "expired", profile: parsedApplication() })).toMatchObject({ ok: false, code: "verification_expired" });
  });

  it("returns only codes the API can hand back as they are", () => {
    for (const status of verificationStatuses) {
      const check = verificationSubmitCheck({ status, profile: without("legalName") });
      if (check.ok) continue;
      expect(verificationSubmitBlocks).toContain(check.code);
      expect(check.code).toMatch(/^[a-z_]+$/);
      expect(check.reason.length).toBeGreaterThan(0);
    }
  });
});
