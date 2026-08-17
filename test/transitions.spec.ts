import { describe, expect, it } from "vitest";
import { createInitialRecord } from "../src/schedule";
import {
  applyCatalogSuccess,
  applySourceFailure,
  classifyAvailability,
  listPendingNotifications,
  markNotificationDelivered
} from "../src/transitions";
import type { SourceSlot } from "../src/types";

const slot = (overrides: Partial<SourceSlot> = {}): SourceSlot => ({
  code: "D1-1200",
  starts_at: "2026-08-21T12:00:00+08:00",
  ends_at: "2026-08-21T14:00:00+08:00",
  is_active: true,
  is_available: false,
  remaining: 0,
  unavailable_reason: "已满",
  display_time: "12:00-14:00",
  updated_at: "2026-08-17T12:00:00+08:00",
  ...overrides
});

describe("availability transitions", () => {
  const now = Date.parse("2026-08-20T13:00:00+08:00");

  it("treats either positive availability signal as available", () => {
    expect(classifyAvailability(slot({ is_available: true }), now)).toBe("available");
    expect(classifyAvailability(slot({ remaining: 1 }), now)).toBe("available");
  });

  it("queues an alert when the first observation is available", () => {
    const next = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 1 })], now);
    expect(next.slots["D1-1200"].notificationPending).toBe(true);
  });

  it("snapshots Shanghai slot and detection times when availability is detected", () => {
    const next = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 2 })], now);
    const intent = listPendingNotifications(next)[0];

    expect(intent).toEqual({
      id: "slot:D1-1200",
      title: "🚨 TRAE 放票：12:00-14:00",
      body: "剩余 2 个名额｜8月21日 13:00:00 检测到。立即打开微信 → 最近使用 → TRAE AI创造力大赛",
      group: "trae-ticket-monitor",
      sound: "alarm",
      url: "weixin://",
      level: "critical",
      call: "1",
      volume: "10"
    });
    expect(next.slots["D1-1200"].pendingNotification).toEqual(intent);
  });

  it("retries the immutable original availability intent after a later sold-out observation", () => {
    let record = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 2 })], now);
    const original = listPendingNotifications(record)[0];

    record = applyCatalogSuccess(record, [slot({ remaining: 0 })], now + 60_000);

    expect(record.slots["D1-1200"].observedState).toBe("sold_out");
    expect(record.slots["D1-1200"].lastRemaining).toBe(0);
    expect(listPendingNotifications(record)).toEqual([original]);

    record = markNotificationDelivered(record, "slot:D1-1200", now + 120_000);
    record = applyCatalogSuccess(record, [slot({ remaining: 3 })], now + 180_000);
    expect(listPendingNotifications(record)[0]?.body).toContain("剩余 3 个名额");
  });

  it("does not repeat while availability remains continuous", () => {
    let record = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 1 })], now);
    record = markNotificationDelivered(record, "slot:D1-1200", now);
    record = applyCatalogSuccess(record, [slot({ remaining: 1 })], now + 60_000);
    expect(listPendingNotifications(record)).toHaveLength(0);
  });

  it("re-arms after sold out and alerts on the next release", () => {
    let record = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 1 })], now);
    record = markNotificationDelivered(record, "slot:D1-1200", now);
    record = applyCatalogSuccess(record, [slot()], now + 60_000);
    record = applyCatalogSuccess(record, [slot({ remaining: 2 })], now + 120_000);
    expect(listPendingNotifications(record).map((item) => item.id)).toContain("slot:D1-1200");
  });

  it("ends a watched slot missing from a catalog after its stored start time", () => {
    let record = applyCatalogSuccess(createInitialRecord(), [slot({ remaining: 1 })], now);
    record = applyCatalogSuccess(record, [], Date.parse("2026-08-21T12:00:00+08:00"));
    expect(record.slots["D1-1200"].observedState).toBe("ended");
    expect(record.slots["D1-1200"].notificationPending).toBe(false);
  });
});

describe("health transitions", () => {
  it("queues one source failure alert on the third failed round", () => {
    let record = createInitialRecord();
    for (let count = 0; count < 3; count += 1) {
      record = applySourceFailure(record, count, "source unavailable");
    }
    expect(listPendingNotifications(record).map((item) => item.id)).toContain("health:failure");
    const failure = listPendingNotifications(record).find((item) => item.id === "health:failure");
    expect(failure).toBeDefined();
    expect(failure).not.toHaveProperty("level");
    expect(failure).not.toHaveProperty("call");
    expect(failure).not.toHaveProperty("volume");
  });

  it("cancels an undelivered stale failure alert on recovery", () => {
    let record = createInitialRecord();
    for (let count = 0; count < 3; count += 1) {
      record = applySourceFailure(record, count, "source unavailable");
    }
    record = applyCatalogSuccess(record, [slot()], 10_000);
    expect(listPendingNotifications(record).map((item) => item.id)).not.toContain("health:failure");
    expect(listPendingNotifications(record).map((item) => item.id)).not.toContain("health:recovery");
  });

  it("cancels a stale recovery alert when the source fails again", () => {
    let record = createInitialRecord();
    for (let count = 0; count < 3; count += 1) {
      record = applySourceFailure(record, count, "source unavailable");
    }
    record = markNotificationDelivered(record, "health:failure", 3);
    record = applyCatalogSuccess(record, [slot()], 4);
    const recovery = listPendingNotifications(record).find((item) => item.id === "health:recovery");
    expect(recovery).toBeDefined();
    expect(recovery).not.toHaveProperty("level");
    expect(recovery).not.toHaveProperty("call");
    expect(recovery).not.toHaveProperty("volume");
    record = applySourceFailure(record, 5, "source unavailable");
    expect(listPendingNotifications(record).map((item) => item.id)).not.toContain("health:recovery");
  });
});
