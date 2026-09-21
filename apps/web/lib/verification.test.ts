import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  canTransitionVerification,
  decisionOptions,
  emptyProfile,
  fieldErrorsFrom,
  fieldProblem,
  formErrorsFrom,
  hydrateProfile,
  missingProfileFields,
  normalizeRequirements,
  pastedDocument,
  profileComplete,
  profileFields,
  profileForApi,
  profileProblems,
  readField,
  requirementFor,
  verificationLook,
  writeField,
  type VerificationProfile
} from "./verification";

/**
 * A draft the API would accept: the entity type is one of the values the API
 * states, and the jurisdiction and country are codes, because those are the
 * shapes `verificationProfileSchema` holds them to.
 */
function filled(): VerificationProfile {
  return {
    legalName: "Northwind Trading Ltd",
    entityType: "company",
    registrationNumber: "SC123456",
    jurisdiction: "GB-SCT",
    registeredAddress: { line1: "12 Bath Street", line2: "", city: "Glasgow", region: "", postalCode: "G2 1HY", country: "GB" },
    website: "",
    businessDescription: "We resell industrial fasteners to builders merchants."
  };
}

describe("the profile the console collects", () => {
  it("asks only about the entity, never about a person", () => {
    const paths = profileFields.map((field) => field.path).join(" ").toLowerCase();
    for (const forbidden of ["director", "owner", "birth", "dob", "passport", "ssn", "nationalid", "document", "photo", "person"]) {
      expect(paths).not.toContain(forbidden);
    }
  });

  it("reads and writes nested address fields without disturbing the rest", () => {
    const profile = writeField(filled(), "registeredAddress.city", "Edinburgh");
    expect(readField(profile, "registeredAddress.city")).toBe("Edinburgh");
    expect(readField(profile, "registeredAddress.line1")).toBe("12 Bath Street");
    expect(readField(profile, "legalName")).toBe("Northwind Trading Ltd");
  });

  it("loads a saved draft into the form without losing the fields the API left out", () => {
    const hydrated = hydrateProfile({ legalName: "Northwind Trading Ltd", registeredAddress: { line1: "12 Bath Street", city: "Glasgow", postalCode: "G2 1HY", country: "United Kingdom" } });
    expect(hydrated.legalName).toBe("Northwind Trading Ltd");
    expect(hydrated.registeredAddress.line2).toBe("");
    expect(hydrated.registeredAddress.city).toBe("Glasgow");
    expect(hydrated.businessDescription).toBe("");
    expect(hydrateProfile(null)).toEqual(emptyProfile());
  });

  it("returns an empty string for a field that has never been set", () => {
    expect(readField(emptyProfile(), "registeredAddress.region")).toBe("");
    expect(readField(emptyProfile(), "website")).toBe("");
  });

  it("names every required field still blank, and calls a full profile complete", () => {
    expect(missingProfileFields(emptyProfile())).toContain("legalName");
    expect(missingProfileFields(emptyProfile())).toContain("registeredAddress.postalCode");
    expect(missingProfileFields(emptyProfile())).not.toContain("website");
    expect(missingProfileFields(filled())).toEqual([]);
    expect(profileComplete(filled())).toBe(true);
    expect(profileComplete(emptyProfile())).toBe(false);
  });

  it("drops optional fields left blank and keeps the address nested", () => {
    const body = profileForApi(filled()) as { website?: string; registeredAddress: Record<string, string>; legalName: string };
    expect(body.website).toBeUndefined();
    expect(body.registeredAddress.line2).toBeUndefined();
    expect(body.registeredAddress.city).toBe("Glasgow");
    expect(body.legalName).toBe("Northwind Trading Ltd");
  });

  it("trims what it sends", () => {
    const body = profileForApi({ ...filled(), legalName: "  Northwind Trading Ltd  " }) as { legalName: string };
    expect(body.legalName).toBe("Northwind Trading Ltd");
  });
});

describe("what a free text field refuses", () => {
  it("refuses a pasted document anywhere", () => {
    expect(fieldProblem("legalName", "data:image/png;base64,iVBORw0KGgo=")).toMatch(/paste/i);
    expect(fieldProblem("businessDescription", "see data:application/pdf;base64,AAAA")).toMatch(/paste/i);
  });

  /**
   * The media type is optional in the data URL grammar, so `data:;base64,` and
   * `data:,` are whole working data URLs. Mirrors the same fix in the API's
   * schema: a rule written for `type/subtype` alone waved a scan through.
   */
  it("refuses a pasted document that names no media type", () => {
    for (const scan of ["data:;base64,iVBORw0KGgoAAAANSUhEUg=", "data:,scanned%20passport"]) {
      expect([scan, pastedDocument(scan)]).toEqual([scan, true]);
      expect(fieldProblem("legalName", scan)).toMatch(/paste/i);
      expect(fieldProblem("businessDescription", `We move freight ${scan}`)).toMatch(/paste/i);
      expect(fieldProblem("registeredAddress.line1", scan)).toMatch(/paste/i);
    }
  });

  /** The rule is about a pasted file, not the word. Prose that uses it keeps working. */
  it("still takes prose that uses the word data before a list", () => {
    expect(pastedDocument("We reconcile carrier data: rates, invoices and proof of delivery.")).toBe(false);
    expect(fieldProblem("businessDescription", "We reconcile carrier data: rates, invoices and proof of delivery.")).toBeNull();
  });

  it("refuses a document number where prose was asked for", () => {
    expect(fieldProblem("businessDescription", "Passport 1234567890 belongs to the director")).toMatch(/identifier numbers/i);
  });

  /**
   * Every field the API holds to its free-text rule, not just the description.
   * The console used to check only the description, so a long digit run in the
   * legal name or the address passed the form and came back as a 400.
   */
  it("refuses a document number in every field the API holds to the same rule", () => {
    for (const path of ["legalName", "registeredAddress.line1", "registeredAddress.line2", "registeredAddress.city", "registeredAddress.region", "businessDescription"]) {
      expect([path, fieldProblem(path, "Held on file under 1234567890")]).toEqual([path, expect.stringMatching(/identifier numbers/i)]);
    }
  });

  it("leaves the fields that are numbers alone", () => {
    expect(fieldProblem("registrationNumber", "12345678")).toBeNull();
    expect(fieldProblem("registeredAddress.postalCode", "560001")).toBeNull();
  });

  it("says nothing about an empty field", () => {
    expect(fieldProblem("businessDescription", "   ")).toBeNull();
  });

  /**
   * The console used to call a draft finished that the API refuses, so the
   * applicant clicked through to the statement and got a 400 back instead.
   */
  it("refuses a jurisdiction and a country the API would not take", () => {
    expect(fieldProblem("jurisdiction", "Scotland")).toMatch(/country code/i);
    expect(fieldProblem("registeredAddress.country", "United Kingdom")).toMatch(/two letter/i);
    expect(fieldProblem("jurisdiction", "GB-SCT")).toBeNull();
    expect(fieldProblem("jurisdiction", "gb")).toBeNull();
    expect(fieldProblem("registeredAddress.country", "GB")).toBeNull();
  });

  it("refuses a website that is not an http address, and lets a blank one through", () => {
    expect(fieldProblem("website", "northwind.example")).toMatch(/http/i);
    expect(fieldProblem("website", "https://northwind.example")).toBeNull();
    expect(fieldProblem("website", "")).toBeNull();
  });

  it("does not call a draft complete when a field cannot have the shape the API states", () => {
    expect(profileComplete({ ...filled(), jurisdiction: "Scotland" })).toBe(false);
    expect(missingProfileFields({ ...filled(), jurisdiction: "Scotland" })).toEqual([]);
  });

  it("collects the problems by field path", () => {
    const problems = profileProblems({ ...filled(), businessDescription: "Reference 99887766 on file" });
    expect(Object.keys(problems)).toEqual(["businessDescription"]);
    expect(profileComplete({ ...filled(), businessDescription: "Reference 99887766 on file" })).toBe(false);
  });
});

describe("the requirements list the API sends", () => {
  it("takes a plain line as the line itself", () => {
    expect(normalizeRequirements(["The legal name on the register"])).toEqual([
      { field: null, label: "The legal name on the register", why: null, optional: false, format: null, options: null }
    ]);
  });

  it("reads a label, the reason it is asked for, and a closed set of values", () => {
    const [entry] = normalizeRequirements([
      { field: "entityType", label: "Entity type", why: "It decides which register holds the entry.", options: ["llc", "plc"] }
    ]);
    expect(entry).toEqual({
      field: "entityType",
      label: "Entity type",
      why: "It decides which register holds the entry.",
      optional: false,
      format: null,
      options: [{ value: "llc", label: "llc" }, { value: "plc", label: "plc" }]
    });
  });

  /**
   * The shape the API actually sends for entityType. Reading only the strings
   * left the console with a free text box over a closed set, so an applicant
   * typed words the API then refused.
   */
  it("reads the value a choice sends and the words a person reads, and the stated format", () => {
    const [entry] = normalizeRequirements([
      {
        field: "entityType",
        label: "Entity type",
        why: "What kind of legal entity it is.",
        required: true,
        format: "One of the listed types",
        options: [{ value: "sole_trader", label: "Sole trader" }, { value: "company", label: "Company" }]
      }
    ]);
    expect(entry?.format).toBe("One of the listed types");
    expect(entry?.options).toEqual([{ value: "sole_trader", label: "Sole trader" }, { value: "company", label: "Company" }]);
  });

  it("drops a choice that names no value, because it could not be submitted", () => {
    const [entry] = normalizeRequirements([{ field: "entityType", label: "Entity type", options: [{ label: "Company" }, { value: "trust" }] }]);
    expect(entry?.options).toEqual([{ value: "trust", label: "trust" }]);
  });

  it("accepts the other names the same idea goes by", () => {
    const [entry] = normalizeRequirements([{ key: "website", title: "Website", reason: "So a reader can find the business.", required: false }]);
    expect(entry?.field).toBe("website");
    expect(entry?.label).toBe("Website");
    expect(entry?.why).toBe("So a reader can find the business.");
    expect(entry?.optional).toBe(true);
  });

  it("drops an entry with nothing readable in it, and a list that is not one", () => {
    expect(normalizeRequirements([{ why: "no label" }, "", null, 7])).toEqual([]);
    expect(normalizeRequirements(undefined)).toEqual([]);
    expect(normalizeRequirements({ legalName: "x" })).toEqual([]);
  });

  it("finds the requirement for a field by its whole path or its last segment", () => {
    const requirements = normalizeRequirements([
      { field: "legalName", label: "Legal name" },
      { field: "city", label: "City" }
    ]);
    expect(requirementFor(requirements, "legalName")?.label).toBe("Legal name");
    expect(requirementFor(requirements, "registeredAddress.city")?.label).toBe("City");
    expect(requirementFor(requirements, "businessDescription")).toBeNull();
  });
});

describe("what a reviewer may record from here", () => {
  it("mirrors the state machine", () => {
    expect(canTransitionVerification("started", "pending")).toBe(true);
    expect(canTransitionVerification("verified", "verified")).toBe(false);
    expect(canTransitionVerification("rejected", "verified")).toBe(false);
  });

  it("offers only the moves the API would accept", () => {
    expect(decisionOptions("pending").map((option) => option.value)).toEqual(["verified", "rejected", "expired"]);
    expect(decisionOptions("verified").map((option) => option.value)).toEqual(["expired"]);
    expect(decisionOptions("rejected")).toEqual([]);
    expect(decisionOptions("unstarted")).toEqual([]);
  });

  /**
   * The state machine has an edge from an open case into "with a reviewer", but
   * the decision route refuses that state by name: a case gets there when its
   * owner submits it and signs the attestation, never because a reviewer said
   * so. Offering it here put it first in the modal's list, which made it the
   * option selected by default, so the plainest thing a reviewer could do to an
   * open case was the one call the API always answers 409 to.
   */
  it("never offers a state the decision route refuses, on an open case or any other", () => {
    for (const from of ["unstarted", "started", "pending", "verified", "rejected", "expired"] as const) {
      const offered = decisionOptions(from).map((option) => option.value);
      expect([from, offered.includes("pending" as never)]).toEqual([from, false]);
      expect([from, offered.every((value) => ["verified", "rejected", "expired"].includes(value))]).toEqual([from, true]);
    }
    expect(decisionOptions("started").map((option) => option.value)).toEqual(["verified", "rejected", "expired"]);
    expect(decisionOptions("started")[0]?.value).toBe("verified");
  });

  /** Verified is necessary for a gated feature, never sufficient: cards need an issuer too. */
  it("does not promise that verified opens cards", () => {
    const verified = decisionOptions("started").find((option) => option.value === "verified");
    expect(verified?.body).toMatch(/cards/i);
    expect(verified?.body).not.toMatch(/unlocks the restricted parts/i);
  });

  it("never claims a decision was anything but a person's", () => {
    const verified = decisionOptions("pending").find((option) => option.value === "verified");
    expect(verified?.body).toMatch(/you, by name/i);
  });
});

describe("a refusal from the API", () => {
  it("puts each message beside its field", () => {
    const error = new ApiError(400, "invalid_request", "invalid request", {
      fieldErrors: { legalName: ["Required"], businessDescription: ["Do not paste documents"] },
      formErrors: []
    });
    expect(fieldErrorsFrom(error)).toEqual({ legalName: "Required", businessDescription: "Do not paste documents" });
    expect(formErrorsFrom(error)).toEqual([]);
  });

  it("keeps the messages that are about the body as a whole", () => {
    const error = new ApiError(400, "invalid_request", "invalid request", { fieldErrors: {}, formErrors: ["Unrecognized key: controlPerson"] });
    expect(formErrorsFrom(error)).toEqual(["Unrecognized key: controlPerson"]);
  });

  it("reads nothing out of a failure that is not a rejected body", () => {
    expect(fieldErrorsFrom(new ApiError(409, "verification_transition_not_allowed", "no"))).toEqual({});
    expect(fieldErrorsFrom(new Error("network"))).toEqual({});
    expect(formErrorsFrom(new ApiError(400, "invalid_request", "invalid request", "a string"))).toEqual([]);
  });
});

describe("how a state is shown", () => {
  it("never shows a decided case as neutral", () => {
    expect(verificationLook("verified")).toEqual({ tone: "positive", label: "Verified" });
    expect(verificationLook("rejected").tone).toBe("negative");
    expect(verificationLook("pending").label).toBe("With a reviewer");
  });
});
