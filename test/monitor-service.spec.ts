import { describe, expect, it } from "vitest";
import { fetchTimeSlots } from "../src/clients";
import { MonitorService, toStatusView } from "../src/monitor-service";
import { createInitialRecord } from "../src/schedule";
import type { MonitorRecord, NotificationIntent, SourceSlot } from "../src/types";

const ordinaryMinute = Date.parse("2026-08-20T11:56:00+08:00");

const sourceSlot = (overrides: Partial<SourceSlot> = {}): SourceSlot => ({
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

class MemoryStore {
  record: MonitorRecord;
  readonly saved: MonitorRecord[] = [];

  constructor(record = createInitialRecord()) {
    this.record = structuredClone(record);
  }

  async load(): Promise<MonitorRecord> {
    return structuredClone(this.record);
  }

  async save(record: MonitorRecord): Promise<void> {
    this.record = structuredClone(record);
    this.saved.push(structuredClone(record));
  }
}

function recordWatching(codes: string[]): MonitorRecord {
  const record = createInitialRecord();
  record.config.watchedCodes = codes;
  return record;
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe("MonitorService", () => {
  it("gives repeated Bark test notifications distinct timestamps", async () => {
    const pushed: NotificationIntent[] = [];
    const service = new MonitorService(new MemoryStore(), {
      now: sequenceClock(ordinaryMinute, ordinaryMinute + 1_000),
      fetchSlots: async () => [sourceSlot()],
      push: async (intent) => { pushed.push(intent); }
    });

    await service.testNotification();
    await service.testNotification();

    expect(pushed.map((intent) => intent.body)).toEqual([
      "Bark 推送配置成功。测试标识 2026-08-20T03:56:00.000Z。点击此通知测试打开微信。",
      "Bark 推送配置成功。测试标识 2026-08-20T03:56:01.000Z。点击此通知测试打开微信。"
    ]);
  });

  it("marks only active current catalog entries as active in the status view", () => {
    const record = createInitialRecord();
    record.config.watchedCodes = [];
    record.slots = {
      stale: {
        observedState: "sold_out",
        startsAt: "2026-08-21T18:00:00+08:00",
        displayTime: "18:00-20:00",
        lastRemaining: 0,
        lastCheckedAt: null,
        lastNotifiedAt: null,
        notificationPending: false
      }
    };
    record.catalog = [
      sourceSlot({ code: "active", is_active: true }),
      sourceSlot({ code: "inactive", is_active: false })
    ];

    const status = toStatusView(record, ordinaryMinute);
    const slots = new Map(status.slots.map((slot) => [slot.code, slot]));

    expect(slots.get("active")?.active).toBe(true);
    expect(slots.get("inactive")?.active).toBe(false);
    expect(slots.get("stale")?.active).toBe(false);
  });

  it("skips source traffic on an ordinary minute outside the fast window", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot()];
      },
      push: async () => undefined
    });

    await service.tick(ordinaryMinute);

    expect(sourceCalls).toBe(0);
  });

  it("checks the source when a tick is forced", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot()];
      },
      push: async () => undefined
    });

    await service.tick(ordinaryMinute, true);

    expect(sourceCalls).toBe(1);
  });

  it("expires a delayed tick using fresh execution time before fetching", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => Date.parse("2026-08-21T12:00:00+08:00"),
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot({ remaining: 2 })];
      },
      push: async () => undefined
    });

    await service.tick(Date.parse("2026-08-21T11:59:00+08:00"), true);

    expect(sourceCalls).toBe(0);
    expect(store.record.slots["D1-1200"].observedState).toBe("ended");
  });

  it("rechecks slot expiry after the pre-fetch save completes", async () => {
    const start = Date.parse("2026-08-21T12:00:00+08:00");
    let clock = start - 1;
    const record = recordWatching(["D1-1200"]);
    record.slots["D1-1200"].notificationPending = true;
    const store = new class extends MemoryStore {
      override async save(next: MonitorRecord): Promise<void> {
        await super.save(next);
        if (this.saved.length === 1) clock = start;
      }
    }(record);
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => clock,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot({ remaining: 2 })];
      },
      push: async () => undefined
    });

    await service.tick(start - 60_000, true);

    expect(sourceCalls).toBe(0);
    expect(store.record.slots["D1-1200"].observedState).toBe("ended");
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
    expect(store.record.slots["D1-1200"].pendingNotification).toBeNull();
  });

  it("uses nominal scheduled time for cadence after a queue delay", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => Date.parse("2026-08-20T11:56:00+08:00"),
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot()];
      },
      push: async () => undefined
    });

    await service.tick(Date.parse("2026-08-20T11:55:00+08:00"));

    expect(sourceCalls).toBe(1);
  });

  it("does not classify or alert when a source fetch crosses the slot start", async () => {
    const start = Date.parse("2026-08-21T12:00:00+08:00");
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const pushed: NotificationIntent[] = [];
    const service = new MonitorService(store, {
      now: sequenceClock(start - 1, start, start),
      fetchSlots: async () => [sourceSlot({ remaining: 2 })],
      push: async (intent) => { pushed.push(intent); }
    });

    await service.tick(start - 60_000, true);

    expect(pushed).toEqual([]);
    expect(store.record.slots["D1-1200"].observedState).toBe("ended");
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("cancels a pending availability alert when its slot starts before delivery", async () => {
    const start = Date.parse("2026-08-21T12:00:00+08:00");
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const pushed: NotificationIntent[] = [];
    const service = new MonitorService(store, {
      now: sequenceClock(start - 2, start - 1, start, start),
      fetchSlots: async () => [sourceSlot({ remaining: 2 })],
      push: async (intent) => { pushed.push(intent); }
    });

    await service.tick(start - 60_000, true);

    expect(pushed).toEqual([]);
    expect(store.record.slots["D1-1200"].observedState).toBe("ended");
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("persists a new availability notification before delivering it", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let wasPersistedBeforePush = false;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => [sourceSlot({ is_available: true, remaining: 2 })],
      push: async (intent) => {
        wasPersistedBeforePush =
          intent.id === "slot:D1-1200" && store.record.slots["D1-1200"].notificationPending;
      }
    });

    await service.tick(ordinaryMinute, true);

    expect(wasPersistedBeforePush).toBe(true);
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("keeps a failed Bark notification pending until the next actual check", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const pushed: NotificationIntent[] = [];
    let failuresRemaining = 1;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => [sourceSlot({ remaining: 2 })],
      push: async (intent) => {
        pushed.push(intent);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("Bark rejected");
        }
      }
    });

    await service.tick(ordinaryMinute, true);
    expect(store.record.slots["D1-1200"].notificationPending).toBe(true);

    await service.tick(ordinaryMinute, true);
    expect(pushed.map((intent) => intent.id)).toEqual(["slot:D1-1200", "slot:D1-1200"]);
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("retries the original positive snapshot after a failed alert and later sold-out result", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const pushed: NotificationIntent[] = [];
    let sourceCalls = 0;
    let pushCalls = 0;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute + sourceCalls * 60_000,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot({ remaining: sourceCalls === 1 ? 2 : 0 })];
      },
      push: async (intent) => {
        pushed.push(structuredClone(intent));
        pushCalls += 1;
        if (pushCalls === 1) throw new Error("Bark rejected");
      }
    });

    await service.tick(ordinaryMinute, true);
    await service.tick(ordinaryMinute + 60_000, true);

    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toEqual(pushed[0]);
    expect(pushed[1]?.body).toContain("剩余 2 个名额");
    expect(pushed[1]?.body).toContain("北京时间检测时间 2026-08-20 11:57:00");
    expect(store.record.slots["D1-1200"].lastRemaining).toBe(0);
    expect(store.record.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("sends one health notification after three source failures", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const pushed: NotificationIntent[] = [];
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => {
        throw new Error("network unavailable");
      },
      push: async (intent) => {
        pushed.push(intent);
      }
    });

    await service.tick(ordinaryMinute, true);
    await service.tick(ordinaryMinute, true);
    await service.tick(ordinaryMinute, true);

    expect(pushed.map((intent) => intent.id)).toEqual(["health:failure"]);
    expect(store.record.health.consecutiveSourceFailures).toBe(3);
  });

  it("records the source client's sanitized timeout classification", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const controller = new AbortController();
    controller.abort(new DOMException("sensitive deadline details", "TimeoutError"));
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: () => fetchTimeSlots(async (_input, init) => {
        throw init?.signal?.reason;
      }, controller.signal),
      push: async () => undefined
    });

    await service.tick(ordinaryMinute, true);

    expect(store.record.health.lastErrorSummary).toBe("source timeout");
  });

  it("cancels an undelivered stale health failure after source recovery", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    let shouldFail = true;
    const pushed: NotificationIntent[] = [];
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => {
        if (shouldFail) throw new Error("network unavailable");
        return [sourceSlot()];
      },
      push: async (intent) => {
        pushed.push(intent);
        throw new Error("Bark rejected");
      }
    });

    await service.tick(ordinaryMinute, true);
    await service.tick(ordinaryMinute, true);
    await service.tick(ordinaryMinute, true);
    shouldFail = false;
    await service.tick(ordinaryMinute, true);

    expect(pushed.map((intent) => intent.id)).toEqual(["health:failure"]);
    expect(store.record.health.sourceFailureNotificationPending).toBe(false);
    expect(store.record.health.recoveryNotificationPending).toBe(false);
  });

  it("returns a serializable validation result for unknown, inactive, and already-started codes", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const now = Date.parse("2026-08-20T11:56:00+08:00");
    const service = new MonitorService(store, {
      now: () => now,
      fetchSlots: async () => [
        sourceSlot(),
        sourceSlot({
          code: "D1-1400",
          starts_at: "2026-08-21T14:00:00+08:00",
          is_active: false,
          display_time: "14:00-16:00"
        }),
        sourceSlot({
          code: "D1-1600",
          starts_at: "2026-08-20T10:00:00+08:00",
          display_time: "16:00-18:00"
        })
      ],
      push: async () => undefined
    });
    await service.tick(now, true);

    expect(await service.setConfig(["missing"], now)).toEqual({ ok: false, error: "invalid configuration" });
    expect(await service.setConfig(["D1-1400"], now)).toEqual({ ok: false, error: "invalid configuration" });
    expect(await service.setConfig(["D1-1600"], now)).toEqual({ ok: false, error: "invalid configuration" });
  });

  it("validates configuration with fresh execution time instead of the stale RPC timestamp", async () => {
    const start = Date.parse("2026-08-21T12:00:00+08:00");
    const record = recordWatching([]);
    record.catalog = [sourceSlot()];
    const store = new MemoryStore(record);
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => start,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot()];
      },
      push: async () => undefined
    });

    const result = await service.setConfig(["D1-1200"], start - 60_000);

    expect(result).toEqual({ ok: false, error: "invalid configuration" });
    expect(sourceCalls).toBe(0);
    expect(store.record.config.watchedCodes).toEqual([]);
  });

  it("resets a newly selected slot before its forced check", async () => {
    const store = new MemoryStore(recordWatching(["D1-1200"]));
    const now = Date.parse("2026-08-20T11:56:00+08:00");
    let sourceCalls = 0;
    let wasUnknownAtForcedCheck = false;
    const service = new MonitorService(store, {
      now: () => now,
      fetchSlots: async () => {
        sourceCalls += 1;
        wasUnknownAtForcedCheck = store.record.slots["D1-1400"]?.observedState === "unknown";
        return [
          sourceSlot(),
          sourceSlot({ code: "D1-1400", starts_at: "2026-08-21T14:00:00+08:00" })
        ];
      },
      push: async () => undefined
    });
    await service.tick(now, true);
    sourceCalls = 0;

    const result = await service.setConfig(["D1-1200", "D1-1400"], now);

    expect(result.ok).toBe(true);
    expect(sourceCalls).toBe(1);
    expect(wasUnknownAtForcedCheck).toBe(true);
    expect(store.record.config.watchedCodes).toEqual(["D1-1200", "D1-1400"]);
  });

  it("stops all source traffic when no slots are selected", async () => {
    const store = new MemoryStore(recordWatching([]));
    let sourceCalls = 0;
    const service = new MonitorService(store, {
      now: () => ordinaryMinute,
      fetchSlots: async () => {
        sourceCalls += 1;
        return [sourceSlot()];
      },
      push: async () => undefined
    });

    await service.tick(ordinaryMinute, true);

    expect(sourceCalls).toBe(0);
  });
});
