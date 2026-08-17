import { describe, expect, it } from "vitest";
import { createInitialRecord, planTick } from "../src/schedule";

describe("planTick", () => {
  it("checks only on five-minute boundaries before the fast window", () => {
    const record = createInitialRecord();
    expect(planTick(record, Date.parse("2026-08-20T11:55:00+08:00")).shouldFetch).toBe(true);
    expect(planTick(record, Date.parse("2026-08-20T11:56:00+08:00")).shouldFetch).toBe(false);
  });

  it("checks every minute when any watched slot is within 24 hours", () => {
    const record = createInitialRecord();
    expect(planTick(record, Date.parse("2026-08-20T12:01:00+08:00")).shouldFetch).toBe(true);
  });

  it("ends each watched slot at its own start time", () => {
    const record = createInitialRecord();
    const plan = planTick(record, Date.parse("2026-08-21T12:30:00+08:00"));
    expect(plan.endedCodes).toEqual(["D1-1200"]);
    expect(plan.activeCodes).toEqual(["D1-1400"]);
  });

  it("skips the source when every watched slot has ended", () => {
    const record = createInitialRecord();
    const plan = planTick(record, Date.parse("2026-08-21T14:00:00+08:00"));
    expect(plan.shouldFetch).toBe(false);
    expect(plan.activeCodes).toEqual([]);
  });

  it("fails closed when legacy persisted state has a non-finite start time", () => {
    const record = createInitialRecord();
    record.config.watchedCodes = ["D1-1200"];
    record.slots["D1-1200"].startsAt = "not-a-date";

    const plan = planTick(record, Date.parse("2026-08-20T11:55:00+08:00"));

    expect(plan.shouldFetch).toBe(false);
    expect(plan.activeCodes).toEqual([]);
    expect(plan.endedCodes).toEqual(["D1-1200"]);
  });
});
