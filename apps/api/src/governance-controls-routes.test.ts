import { describe, expect, it } from "vitest";
import { readTimeLock } from "@ai-neobank/domain";
import { timeLockChangeState } from "./governance-controls-routes.js";

const now = new Date("2026-09-21T12:00:00.000Z");
const reading = readTimeLock({ governance: "squads", observed: { timeLock: 3600 } });

describe("a time lock change against the vault's own delay", () => {
  it("counts the delay from the moment the members approved it", () => {
    const lock = timeLockChangeState({ reading, status: "approved", statusAt: "2026-09-21T11:50:00.000Z", now });
    expect(lock).toMatchObject({ startedAt: "2026-09-21T11:50:00.000Z", executableAt: "2026-09-21T12:50:00.000Z", remainingSeconds: 3000, locked: true });
  });

  it("releases the change once the delay has run", () => {
    expect(timeLockChangeState({ reading, status: "approved", statusAt: "2026-09-21T10:00:00.000Z", now }).locked).toBe(false);
  });

  it("holds a change whose start the chain does not carry: an executing proposal has no timestamp", () => {
    const lock = timeLockChangeState({ reading, status: "executing", statusAt: null, now });
    expect(lock).toMatchObject({ startedAt: null, executableAt: null, remainingSeconds: 3600, locked: true });
  });

  it("holds an approved proposal with no instant for the same reason", () => {
    expect(timeLockChangeState({ reading, status: "approved", statusAt: null, now }).locked).toBe(true);
  });

  it("leaves a change that is still collecting votes unlocked: nothing has started yet", () => {
    expect(timeLockChangeState({ reading, status: "active", statusAt: "2026-09-21T11:59:00.000Z", now })).toMatchObject({ startedAt: null, executableAt: null, remainingSeconds: 3600, locked: false });
    expect(timeLockChangeState({ reading, status: null, statusAt: null, now }).locked).toBe(false);
  });

  it("has nothing to hold when the vault has no delay", () => {
    const none = readTimeLock({ governance: "squads", observed: { timeLock: 0 } });
    expect(timeLockChangeState({ reading: none, status: "executing", statusAt: null, now })).toMatchObject({ seconds: 0, remainingSeconds: 0, locked: false });
  });
});
