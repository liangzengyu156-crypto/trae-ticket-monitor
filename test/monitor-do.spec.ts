import { afterEach, describe, expect, it, vi } from "vitest";
import { Monitor } from "../src/monitor-do";
import { createInitialRecord } from "../src/schedule";
import type { MonitorRecord, SourceSlot } from "../src/types";

const now = Date.parse("2026-08-20T11:56:00+08:00");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async seed(record: MonitorRecord): Promise<void> {
    await this.put("monitor", record);
  }
}

async function nextTurn(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Monitor Durable Object", () => {
  it("does not begin a config tick while a prior tick is awaiting the source", async () => {
    const storage = new MemoryDurableStorage();
    const initial = createInitialRecord();
    initial.config.watchedCodes = ["D1-1200"];
    initial.catalog = [
      sourceSlot(),
      sourceSlot({ code: "D1-1400", starts_at: "2026-08-21T14:00:00+08:00" })
    ];
    await storage.seed(initial);

    const firstSourceResponse = deferred<Response>();
    const secondSourceResponse = deferred<Response>();
    let sourceCalls = 0;
    vi.stubGlobal("fetch", async () => {
      sourceCalls += 1;
      return sourceCalls === 1 ? firstSourceResponse.promise : secondSourceResponse.promise;
    });
    const monitor = Object.assign(Object.create(Monitor.prototype), {
      ctx: { storage },
      env: { BARK_DEVICE_KEY: "test-device-key-123456789" },
      operationQueue: Promise.resolve()
    }) as Monitor;

    const firstTick = monitor.tick(now, true);
    await nextTurn();
    expect(sourceCalls).toBe(1);

    const configChange = monitor.setConfig(["D1-1200", "D1-1400"], now);
    await nextTurn();
    expect(sourceCalls).toBe(1);

    firstSourceResponse.resolve(Response.json(initial.catalog));
    await firstTick;
    await nextTurn();
    expect(sourceCalls).toBe(2);

    secondSourceResponse.resolve(Response.json(initial.catalog));
    await configChange;
    expect((await monitor.getStatus(now)).watchedCodes).toEqual(["D1-1200", "D1-1400"]);
  });

  it("continues processing queued RPCs after a rejected notification", async () => {
    const storage = new MemoryDurableStorage();
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new DOMException("deadline", "TimeoutError");
      return new Response(null, { status: 204 });
    });
    const monitor = Object.assign(Object.create(Monitor.prototype), {
      ctx: { storage },
      env: { BARK_DEVICE_KEY: "test-device-key-123456789" },
      operationQueue: Promise.resolve()
    }) as Monitor;

    await expect(monitor.testNotification()).rejects.toThrow("Bark timeout");
    await monitor.testNotification();

    expect(fetchCalls).toBe(2);
  });

  it("rechecks the clock when a queued tick finally begins", async () => {
    const storage = new MemoryDurableStorage();
    const initial = createInitialRecord();
    initial.config.watchedCodes = ["D1-1200"];
    await storage.seed(initial);
    const start = Date.parse("2026-08-21T12:00:00+08:00");
    const response = deferred<Response>();
    let sourceCalls = 0;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(start - 60_000);
    vi.stubGlobal("fetch", async () => {
      sourceCalls += 1;
      return response.promise;
    });
    const monitor = Object.assign(Object.create(Monitor.prototype), {
      ctx: { storage },
      env: { BARK_DEVICE_KEY: "test-device-key-123456789" },
      operationQueue: Promise.resolve()
    }) as Monitor;

    const first = monitor.tick(start - 60_000, true);
    await nextTurn();
    const delayed = monitor.tick(start - 60_000, true);
    dateNow.mockReturnValue(start);
    response.resolve(Response.json([sourceSlot()]));

    await first;
    await delayed;

    expect(sourceCalls).toBe(1);
    expect((await storage.get<MonitorRecord>("monitor"))?.slots["D1-1200"].observedState).toBe("ended");
  });

  it("retains a timed-out availability alert and retries its original snapshot", async () => {
    const storage = new MemoryDurableStorage();
    const initial = createInitialRecord();
    initial.config.watchedCodes = ["D1-1200"];
    await storage.seed(initial);
    let sourceRound = 0;
    let barkRound = 0;
    const barkBodies: string[] = [];
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "trae-party-2026.siliconpear.cn") {
        sourceRound += 1;
        return Response.json([sourceSlot({ remaining: sourceRound === 1 ? 2 : 0 })]);
      }
      barkRound += 1;
      barkBodies.push(String(init?.body));
      if (barkRound === 1) throw new DOMException("deadline", "TimeoutError");
      return new Response(null, { status: 204 });
    });
    const monitor = Object.assign(Object.create(Monitor.prototype), {
      ctx: { storage },
      env: { BARK_DEVICE_KEY: "test-device-key-123456789" },
      operationQueue: Promise.resolve()
    }) as Monitor;

    await monitor.tick(now, true);
    expect((await storage.get<MonitorRecord>("monitor"))?.slots["D1-1200"].notificationPending).toBe(true);

    await monitor.tick(now + 60_000, true);

    expect(barkBodies).toHaveLength(2);
    expect(barkBodies[1]).toBe(barkBodies[0]);
    expect(barkBodies[1]).toContain("剩余 2 个名额");
    const saved = await storage.get<MonitorRecord>("monitor");
    expect(saved?.slots["D1-1200"].observedState).toBe("sold_out");
    expect(saved?.slots["D1-1200"].notificationPending).toBe(false);
  });

  it("serializes concurrent ticks so one availability transition emits one alert", async () => {
    const storage = new MemoryDurableStorage();
    const initial = createInitialRecord();
    initial.config.watchedCodes = ["D1-1200"];
    await storage.seed(initial);
    let sourceCalls = 0;
    let barkCalls = 0;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "trae-party-2026.siliconpear.cn") {
        sourceCalls += 1;
        return Response.json([sourceSlot({ remaining: 1 })]);
      }
      barkCalls += 1;
      return new Response(null, { status: 204 });
    });
    const monitor = Object.assign(Object.create(Monitor.prototype), {
      ctx: { storage },
      env: { BARK_DEVICE_KEY: "test-device-key-123456789" },
      operationQueue: Promise.resolve()
    }) as Monitor;

    await Promise.all([
      monitor.tick(now, true),
      monitor.tick(now, true)
    ]);

    expect(sourceCalls).toBe(2);
    expect(barkCalls).toBe(1);
  });
});
