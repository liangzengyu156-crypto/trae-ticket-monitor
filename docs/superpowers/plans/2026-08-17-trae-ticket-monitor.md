# TRAE Ticket Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a configurable Cloudflare Worker that monitors selected TRAE event time slots and sends transition-based Bark notifications to an iPhone.

**Architecture:** A Worker gateway handles Cron and authenticated mobile-management routes, while one SQLite-backed Durable Object serializes configuration, polling, state transitions, and Bark delivery. Pure scheduling and transition modules carry most logic so Vitest can verify behavior without hitting the official endpoint.

**Tech Stack:** TypeScript, Cloudflare Workers, SQLite-backed Durable Objects, Wrangler JSON configuration, Vitest 4.1+, Cloudflare Workers Vitest integration, plain HTML/CSS/JavaScript, Bark HTTP API.

## Global Constraints

- Read only GET https://trae-party-2026.siliconpear.cn/api/v1/time-slots.
- Never call reservation, order, queue, login, CAPTCHA, or anti-bot endpoints.
- Default watched codes are D1-1200 and D1-1400.
- Cron fires every minute; before the 24-hour fast window, actual source checks occur every five Beijing-time minutes.
- A slot stops being monitored at its own starts_at timestamp.
- Notify on initial available state and sold_out-to-available transitions; do not repeat while continuously available.
- ADMIN_TOKEN and BARK_DEVICE_KEY are Cloudflare Secrets and must never appear in source, persisted state, responses, or logs.
- The admin UI stores ADMIN_TOKEN only in sessionStorage and sends it in the Authorization header.
- All API responses use Cache-Control: no-store.
- No HAR file or HAR-derived credential may enter the repository.
- Follow test-driven development and commit after every independently testable task.

---

## File Map

- package.json — scripts and development dependencies.
- package-lock.json — reproducible dependency lock.
- .gitignore — excludes dependencies, local Wrangler state, coverage, and secret files.
- wrangler.jsonc — Worker entry point, minute Cron, Durable Object binding/export, and observability.
- tsconfig.json — strict TypeScript configuration.
- vitest.config.ts — current Cloudflare Vitest plugin configuration.
- test/tsconfig.json — test-only Workers types.
- src/types.ts — source payload, persisted state, notification, status, and environment interfaces.
- src/schedule.ts — Beijing-time adaptive polling and per-slot expiry.
- src/transitions.ts — pure slot and health state transitions.
- src/clients.ts — strict source parser/fetcher and Bark sender.
- src/monitor-service.ts — orchestration over storage and clients.
- src/monitor-do.ts — Durable Object adapter and persistent store.
- src/auth.ts — constant-time bearer-token validation.
- src/admin-html.ts — self-contained mobile management page.
- src/index.ts — HTTP routes, scheduled handler, and Durable Object export.
- test/schedule.spec.ts — schedule boundary tests.
- test/transitions.spec.ts — availability and health state-machine tests.
- test/clients.spec.ts — source and Bark client tests.
- test/monitor-service.spec.ts — orchestration, persistence, and retry tests.
- test/auth.spec.ts — bearer-token tests.
- test/worker.spec.ts — Worker routes, headers, Cron forwarding, and UI delivery.
- README.md — local verification, secret setup, deployment, iPhone use, and cleanup.

---

### Task 1: Project Scaffold and Adaptive Schedule

**Files:**
- Create: package.json
- Create: package-lock.json
- Create: .gitignore
- Create: wrangler.jsonc
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: test/tsconfig.json
- Create: src/types.ts
- Create: src/schedule.ts
- Create: test/schedule.spec.ts
- Generate: worker-configuration.d.ts

**Interfaces:**
- Produces: SourceSlot, ObservedState, SlotState, MonitorRecord, TickPlan, Env.
- Produces: planTick(record: MonitorRecord, nowMs: number): TickPlan.
- Produces: createInitialRecord(): MonitorRecord.

- [ ] **Step 1: Initialize the package and install the current supported toolchain**

Run:

~~~bash
npm init -y
npm pkg set name=trae-ticket-monitor type=module
npm pkg set private=true --json
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.typecheck="tsc --noEmit && tsc --noEmit -p test/tsconfig.json"
npm pkg set scripts.cf-typegen="wrangler types"
npm pkg set scripts.dev="wrangler dev"
npm pkg set scripts.deploy="wrangler deploy"
npm install -D typescript@latest wrangler@latest vitest@^4.1.0 @cloudflare/vitest-pool-workers@latest
~~~

Create .gitignore with:

~~~text
node_modules/
.wrangler/
coverage/
dist/
.dev.vars
.env
.env.*
!.env.example
~~~

Create wrangler.jsonc with the current declarative SQLite Durable Object export:

~~~jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "trae-ticket-monitor",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-17",
  "triggers": {
    "crons": ["* * * * *"]
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "MONITOR",
        "class_name": "Monitor"
      }
    ]
  },
  "exports": {
    "Monitor": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  },
  "observability": {
    "enabled": true
  }
}
~~~

Create vitest.config.ts using Cloudflare's current plugin:

~~~ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          BARK_DEVICE_KEY: "test-bark-key"
        }
      }
    })
  ]
});
~~~

Create tsconfig.json:

~~~json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": [
    "src/**/*.ts",
    "vitest.config.ts",
    "worker-configuration.d.ts"
  ]
}
~~~

Create test/tsconfig.json:

~~~json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": [
      "@cloudflare/vitest-pool-workers/types"
    ]
  },
  "include": [
    "./**/*.ts",
    "../src/**/*.ts",
    "../worker-configuration.d.ts"
  ]
}
~~~

- [ ] **Step 2: Write schedule tests before the implementation**

Create test/schedule.spec.ts with exact boundary cases:

~~~ts
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
});
~~~

- [ ] **Step 3: Run the schedule test and verify the expected failure**

Run: npm test -- test/schedule.spec.ts

Expected: FAIL because src/schedule.ts does not exist.

- [ ] **Step 4: Define the domain types and minimal schedule implementation**

Create src/types.ts with these exact public shapes:

~~~ts
export type ObservedState = "unknown" | "sold_out" | "available" | "ended";

export interface SourceSlot {
  code: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
  is_available: boolean;
  remaining: number;
  unavailable_reason: string;
  display_time: string;
  updated_at: string;
}

export interface SlotState {
  observedState: ObservedState;
  startsAt: string;
  displayTime: string;
  lastRemaining: number | null;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  notificationPending: boolean;
}

export interface HealthState {
  consecutiveSourceFailures: number;
  sourceFailureNotificationPending: boolean;
  sourceFailureNotified: boolean;
  recoveryNotificationPending: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
}

export interface MonitorRecord {
  config: {
    watchedCodes: string[];
    normalIntervalMinutes: number;
    fastWindowHours: number;
  };
  slots: Record<string, SlotState>;
  catalog: SourceSlot[];
  health: HealthState;
}

export interface TickPlan {
  shouldFetch: boolean;
  activeCodes: string[];
  endedCodes: string[];
}

export interface Env {
  MONITOR: DurableObjectNamespace;
  ADMIN_TOKEN: string;
  BARK_DEVICE_KEY: string;
}
~~~

Create src/schedule.ts. Use the source timestamps for expiry and Asia/Shanghai for the ordinary five-minute boundary:

~~~ts
import type { MonitorRecord, SlotState, TickPlan } from "./types";

const DEFAULT_STARTS: Record<string, string> = {
  "D1-1200": "2026-08-21T12:00:00+08:00",
  "D1-1400": "2026-08-21T14:00:00+08:00"
};

function unknownSlot(code: string): SlotState {
  return {
    observedState: "unknown",
    startsAt: DEFAULT_STARTS[code],
    displayTime: code === "D1-1200" ? "12:00-14:00" : "14:00-16:00",
    lastRemaining: null,
    lastCheckedAt: null,
    lastNotifiedAt: null,
    notificationPending: false
  };
}

export function createInitialRecord(): MonitorRecord {
  return {
    config: {
      watchedCodes: ["D1-1200", "D1-1400"],
      normalIntervalMinutes: 5,
      fastWindowHours: 24
    },
    slots: {
      "D1-1200": unknownSlot("D1-1200"),
      "D1-1400": unknownSlot("D1-1400")
    },
    catalog: [],
    health: {
      consecutiveSourceFailures: 0,
      sourceFailureNotificationPending: false,
      sourceFailureNotified: false,
      recoveryNotificationPending: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorSummary: null
    }
  };
}

export function planTick(record: MonitorRecord, nowMs: number): TickPlan {
  const activeCodes: string[] = [];
  const endedCodes: string[] = [];
  for (const code of record.config.watchedCodes) {
    const slot = record.slots[code];
    if (!slot || nowMs >= Date.parse(slot.startsAt)) endedCodes.push(code);
    else activeCodes.push(code);
  }
  if (activeCodes.length === 0) return { shouldFetch: false, activeCodes, endedCodes };

  const fastWindowMs = record.config.fastWindowHours * 60 * 60 * 1000;
  const inFastWindow = activeCodes.some(
    (code) => Date.parse(record.slots[code].startsAt) - nowMs <= fastWindowMs
  );
  const beijingMinute = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      minute: "2-digit"
    }).format(new Date(nowMs))
  );
  return {
    shouldFetch: inFastWindow || beijingMinute % record.config.normalIntervalMinutes === 0,
    activeCodes,
    endedCodes
  };
}
~~~

- [ ] **Step 5: Run schedule tests and type checking**

Run:

~~~bash
npm test -- test/schedule.spec.ts
npm run typecheck
~~~

Expected: schedule tests PASS; type checking may report the missing src/index.ts until Step 6 creates the temporary entry point.

- [ ] **Step 6: Add the minimal entry point, generate Workers types, and re-run checks**

Create src/index.ts:

~~~ts
export default {
  async fetch(): Promise<Response> {
    return new Response("TRAE ticket monitor is initializing", { status: 503 });
  }
} satisfies ExportedHandler;
~~~

Run:

~~~bash
npm run cf-typegen
npm run typecheck
npm test -- test/schedule.spec.ts
~~~

Expected: all commands PASS.

- [ ] **Step 7: Commit the scaffold and schedule**

~~~bash
git add .gitignore package.json package-lock.json wrangler.jsonc tsconfig.json vitest.config.ts test/tsconfig.json worker-configuration.d.ts src/types.ts src/schedule.ts src/index.ts test/schedule.spec.ts
git commit -m "feat: scaffold adaptive TRAE monitor"
~~~

---

### Task 2: Availability and Health State Machines

**Files:**
- Create: src/transitions.ts
- Create: test/transitions.spec.ts
- Modify: src/types.ts

**Interfaces:**
- Consumes: MonitorRecord, SourceSlot, SlotState from src/types.ts.
- Produces: classifyAvailability(slot: SourceSlot, nowMs: number): ObservedState.
- Produces: applyCatalogSuccess(record: MonitorRecord, catalog: SourceSlot[], nowMs: number): MonitorRecord.
- Produces: applySourceFailure(record: MonitorRecord, nowMs: number, summary: string): MonitorRecord.
- Produces: markNotificationDelivered(record: MonitorRecord, notificationId: string, nowMs: number): MonitorRecord.
- Produces: listPendingNotifications(record: MonitorRecord): NotificationIntent[].

- [ ] **Step 1: Add failing transition tests**

Create test/transitions.spec.ts. Cover these exact assertions:

~~~ts
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
});

describe("health transitions", () => {
  it("queues one source failure alert on the third failed round", () => {
    let record = createInitialRecord();
    for (let count = 0; count < 3; count += 1) {
      record = applySourceFailure(record, count, "source unavailable");
    }
    expect(listPendingNotifications(record).map((item) => item.id)).toContain("health:failure");
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
});
~~~

- [ ] **Step 2: Run the transition tests and verify failure**

Run: npm test -- test/transitions.spec.ts

Expected: FAIL because src/transitions.ts and NotificationIntent are not defined.

- [ ] **Step 3: Add NotificationIntent and implement pure transitions**

Add to src/types.ts:

~~~ts
export interface NotificationIntent {
  id: string;
  title: string;
  body: string;
  group: "trae-ticket-monitor";
  sound: "alarm";
  url: "weixin://";
}
~~~

Implement src/transitions.ts with immutable record copies. The key transition must be:

~~~ts
export function classifyAvailability(slot: SourceSlot, nowMs: number): ObservedState {
  if (nowMs >= Date.parse(slot.starts_at)) return "ended";
  if (slot.is_active && (slot.is_available || slot.remaining > 0)) return "available";
  return "sold_out";
}
~~~

Implement applyCatalogSuccess so it:

1. Replaces catalog with the validated source array.
2. Resets consecutiveSourceFailures and lastErrorSummary.
3. Cancels sourceFailureNotificationPending if the failure alert was never delivered.
4. Queues recoveryNotificationPending only when sourceFailureNotified is true.
5. Updates only watched slot codes.
6. Sets notificationPending on unknown-to-available and sold_out-to-available.
7. Clears notificationPending when a slot becomes ended.

Implement listPendingNotifications with stable IDs:

~~~ts
export function listPendingNotifications(record: MonitorRecord): NotificationIntent[] {
  const notifications: NotificationIntent[] = [];
  for (const code of record.config.watchedCodes) {
    const slot = record.slots[code];
    if (slot?.notificationPending) {
      notifications.push({
        id: "slot:" + code,
        title: "TRAE 有票：" + slot.displayTime,
        body:
          "剩余 " + String(slot.lastRemaining ?? "未知") +
          " 个名额；检测时间 " + String(slot.lastCheckedAt) +
          "。请打开微信手动预约。",
        group: "trae-ticket-monitor",
        sound: "alarm",
        url: "weixin://"
      });
    }
  }
  if (record.health.sourceFailureNotificationPending) {
    notifications.push({
      id: "health:failure",
      title: "TRAE 余票监测异常",
      body: "余票接口已连续 3 轮检查失败，监测器会继续重试。",
      group: "trae-ticket-monitor",
      sound: "alarm",
      url: "weixin://"
    });
  }
  if (record.health.recoveryNotificationPending) {
    notifications.push({
      id: "health:recovery",
      title: "TRAE 余票监测已恢复",
      body: "余票接口已经恢复，监测继续运行。",
      group: "trae-ticket-monitor",
      sound: "alarm",
      url: "weixin://"
    });
  }
  return notifications;
}
~~~

markNotificationDelivered must clear the matching pending flag, set lastNotifiedAt for slot alerts, mark sourceFailureNotified after a delivered failure alert, and clear sourceFailureNotified after a delivered recovery alert.

- [ ] **Step 4: Run transition tests**

Run:

~~~bash
npm test -- test/transitions.spec.ts
npm run typecheck
~~~

Expected: PASS.

- [ ] **Step 5: Commit the state machines**

~~~bash
git add src/types.ts src/transitions.ts test/transitions.spec.ts
git commit -m "feat: add availability and health transitions"
~~~

---

### Task 3: Strict Source and Bark Clients

**Files:**
- Create: src/clients.ts
- Create: test/clients.spec.ts

**Interfaces:**
- Consumes: SourceSlot and NotificationIntent from src/types.ts.
- Produces: fetchTimeSlots(fetcher: typeof fetch, signal?: AbortSignal): Promise<SourceSlot[]>.
- Produces: sendBark(fetcher: typeof fetch, deviceKey: string, intent: NotificationIntent): Promise<void>.
- Produces: SourceResponseError with a sanitized message.

- [ ] **Step 1: Write failing client tests**

Create test/clients.spec.ts with mocked fetch functions. Assert:

- fetchTimeSlots sends GET to the exact public URL.
- A 200 JSON array with valid fields returns SourceSlot[].
- Non-200, non-array JSON, non-finite remaining, and missing code throw SourceResponseError.
- Error messages never include response bodies or request headers.
- sendBark POSTs JSON to https://api.day.app/push.
- Bark payload includes device_key, title, body, group, sound, and url.
- Bark non-2xx throws without including the device key in the error.

Use a representative success test:

~~~ts
it("parses a valid source slot", async () => {
  const fetcher = vi.fn(async () =>
    Response.json([{
      code: "D1-1200",
      starts_at: "2026-08-21T12:00:00+08:00",
      ends_at: "2026-08-21T14:00:00+08:00",
      is_active: true,
      is_available: false,
      remaining: 0,
      unavailable_reason: "已满",
      display_time: "12:00-14:00",
      updated_at: "2026-08-17T12:00:00+08:00"
    }])
  );
  const result = await fetchTimeSlots(fetcher as typeof fetch);
  expect(result[0].code).toBe("D1-1200");
});
~~~

- [ ] **Step 2: Verify the client tests fail**

Run: npm test -- test/clients.spec.ts

Expected: FAIL because src/clients.ts does not exist.

- [ ] **Step 3: Implement strict parsing and fetch timeout**

In src/clients.ts define:

~~~ts
const SOURCE_URL = "https://trae-party-2026.siliconpear.cn/api/v1/time-slots";
const BARK_URL = "https://api.day.app/push";

export class SourceResponseError extends Error {}

export async function fetchTimeSlots(
  fetcher: typeof fetch,
  externalSignal?: AbortSignal
): Promise<SourceSlot[]> {
  const timeoutSignal = AbortSignal.timeout(8_000);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
  const response = await fetcher(SOURCE_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal
  });
  if (!response.ok) throw new SourceResponseError("source HTTP " + response.status);
  const value: unknown = await response.json();
  return parseSourceSlots(value);
}
~~~

Implement parseSourceSlots with explicit typeof checks for every field listed in the design. Reject invalid arrays with a short field name only; never append raw JSON.

Implement Bark with a JSON POST:

~~~ts
export async function sendBark(
  fetcher: typeof fetch,
  deviceKey: string,
  intent: NotificationIntent
): Promise<void> {
  const response = await fetcher(BARK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      device_key: deviceKey,
      title: intent.title,
      body: intent.body,
      group: intent.group,
      sound: intent.sound,
      url: intent.url
    })
  });
  if (!response.ok) throw new Error("Bark HTTP " + response.status);
}
~~~

- [ ] **Step 4: Run client tests and all existing tests**

Run:

~~~bash
npm test -- test/clients.spec.ts
npm test
npm run typecheck
~~~

Expected: PASS.

- [ ] **Step 5: Commit the clients**

~~~bash
git add src/clients.ts test/clients.spec.ts
git commit -m "feat: add safe source and Bark clients"
~~~

---

### Task 4: Monitor Service and Durable Object Persistence

**Files:**
- Create: src/monitor-service.ts
- Create: src/monitor-do.ts
- Create: test/monitor-service.spec.ts
- Modify: src/types.ts

**Interfaces:**
- Consumes: planTick, transition functions, fetchTimeSlots, sendBark.
- Produces: MonitorStore with load(): Promise<MonitorRecord> and save(record: MonitorRecord): Promise<void>.
- Produces: MonitorService.tick(nowMs: number, force?: boolean): Promise<StatusView>.
- Produces: MonitorService.getStatus(nowMs: number): Promise<StatusView>.
- Produces: MonitorService.setConfig(codes: string[], nowMs: number): Promise<StatusView>.
- Produces: MonitorService.testNotification(): Promise<void>.
- Produces: Monitor Durable Object RPC methods tick, getStatus, setConfig, and testNotification.
- Produces: markEndedSlots(record: MonitorRecord, codes: string[], nowMs: number): MonitorRecord.
- Produces: toStatusView(record: MonitorRecord, nowMs: number): StatusView.
- Produces: assertWatchedCodesPresent(catalog: SourceSlot[], activeCodes: string[]): void.
- Produces: sanitizeError(error: unknown): string.

- [ ] **Step 1: Add failing orchestration tests with an in-memory store**

Create test/monitor-service.spec.ts with a MemoryStore and injected client functions. Verify:

1. A skipped ordinary minute does not call the source.
2. A forced check calls the source.
3. A newly available slot is persisted as pending before Bark is called.
4. Bark success clears pending; Bark failure leaves it pending for the next actual check.
5. Three source failures create one health notification.
6. Source recovery cancels an undelivered stale health failure.
7. setConfig rejects unknown, inactive, and already-started codes.
8. setConfig resets newly selected codes to unknown and immediately forces a check.
9. An empty selection stops source traffic.

The injected dependency shape is:

~~~ts
interface MonitorDependencies {
  now: () => number;
  fetchSlots: () => Promise<SourceSlot[]>;
  push: (intent: NotificationIntent) => Promise<void>;
}
~~~

- [ ] **Step 2: Run the orchestration test and verify failure**

Run: npm test -- test/monitor-service.spec.ts

Expected: FAIL because MonitorService is not defined.

- [ ] **Step 3: Implement MonitorService with persist-before-send semantics**

Add the serializable API view types to src/types.ts:

~~~ts
export interface SlotStatusView {
  code: string;
  watched: boolean;
  observedState: ObservedState;
  startsAt: string;
  endsAt: string;
  displayTime: string;
  remaining: number | null;
  lastCheckedAt: string | null;
}

export interface StatusView {
  now: string;
  watchedCodes: string[];
  slots: SlotStatusView[];
  health: {
    consecutiveSourceFailures: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorSummary: string | null;
  };
}
~~~

Create src/monitor-service.ts. The tick method must follow this order:

~~~ts
async tick(nowMs: number, force = false): Promise<StatusView> {
  let record = await this.store.load();
  const plan = planTick(record, nowMs);
  record = markEndedSlots(record, plan.endedCodes, nowMs);
  await this.store.save(record);

  if (!force && !plan.shouldFetch) return toStatusView(record, nowMs);
  if (plan.activeCodes.length === 0) return toStatusView(record, nowMs);

  try {
    const catalog = await this.dependencies.fetchSlots();
    assertWatchedCodesPresent(catalog, plan.activeCodes);
    record = applyCatalogSuccess(record, catalog, nowMs);
  } catch (error) {
    record = applySourceFailure(record, nowMs, sanitizeError(error));
  }

  await this.store.save(record);
  record = await this.flushPending(record, nowMs);
  return toStatusView(record, nowMs);
}
~~~

flushPending must process listPendingNotifications(record) sequentially. After each successful Bark call, call markNotificationDelivered and save immediately. If Bark fails, log only notification ID plus a boolean failure and stop the flush so the flag remains pending.

setConfig must validate against the cached catalog, compare epoch timestamps, reset newly added states to unknown, retain removed state for display, save, then call tick(nowMs, true).

Implement the four local helpers with these exact rules:

- markEndedSlots clones the record, sets each named slot to ended, clears its notificationPending flag, and leaves historical remaining/check timestamps intact.
- toStatusView merges catalog entries and persisted slot states, sorts by startsAt then code, and returns no notification flags or secret-bearing fields.
- assertWatchedCodesPresent throws SourceResponseError("watched slot missing") if any active code is absent from the catalog.
- sanitizeError returns source timeout, source HTTP N, invalid source response, or source unavailable; it never returns error.stack, response bodies, URLs, or headers.

testNotification must call push exactly once with:

~~~ts
{
  id: "test",
  title: "TRAE 余票监测测试",
  body: "Bark 推送配置成功。点击此通知测试打开微信。",
  group: "trae-ticket-monitor",
  sound: "alarm",
  url: "weixin://"
}
~~~

- [ ] **Step 4: Implement the Durable Object adapter**

Create src/monitor-do.ts:

~~~ts
import { DurableObject } from "cloudflare:workers";
import { fetchTimeSlots, sendBark } from "./clients";
import { createInitialRecord } from "./schedule";
import { MonitorService } from "./monitor-service";
import type { Env, MonitorRecord } from "./types";

class DurableMonitorStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async load(): Promise<MonitorRecord> {
    return (await this.storage.get<MonitorRecord>("monitor")) ?? createInitialRecord();
  }

  async save(record: MonitorRecord): Promise<void> {
    await this.storage.put("monitor", record);
  }
}

export class Monitor extends DurableObject<Env> {
  private service(): MonitorService {
    return new MonitorService(
      new DurableMonitorStore(this.ctx.storage),
      {
        now: () => Date.now(),
        fetchSlots: () => fetchTimeSlots(fetch),
        push: (intent) => sendBark(fetch, this.env.BARK_DEVICE_KEY, intent)
      }
    );
  }

  tick(nowMs: number, force = false) {
    return this.service().tick(nowMs, force);
  }

  getStatus(nowMs: number) {
    return this.service().getStatus(nowMs);
  }

  setConfig(codes: string[], nowMs: number) {
    return this.service().setConfig(codes, nowMs);
  }

  testNotification() {
    return this.service().testNotification();
  }
}
~~~

- [ ] **Step 5: Run monitor tests and checks**

Run:

~~~bash
npm test -- test/monitor-service.spec.ts
npm test
npm run typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit orchestration and persistence**

~~~bash
git add src/types.ts src/monitor-service.ts src/monitor-do.ts test/monitor-service.spec.ts
git commit -m "feat: persist serialized monitor state"
~~~

---

### Task 5: Authenticated Worker API and Cron Gateway

**Files:**
- Create: src/auth.ts
- Create: test/auth.spec.ts
- Create: test/worker.spec.ts
- Modify: src/index.ts
- Modify: src/types.ts

**Interfaces:**
- Consumes: Monitor RPC methods from src/monitor-do.ts.
- Produces: isAuthorized(request: Request, expectedToken: string): Promise<boolean>.
- Produces: JSON routes GET /api/status, PUT /api/config, POST /api/check, POST /api/test-notification.
- Produces: scheduled handler forwarding scheduledTime to the primary Monitor instance.

- [ ] **Step 1: Write failing authentication tests**

Create test/auth.spec.ts:

~~~ts
import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";

describe("isAuthorized", () => {
  it("rejects missing and malformed bearer headers", async () => {
    expect(await isAuthorized(new Request("https://worker.test/api/status"), "secret")).toBe(false);
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Basic secret" }
    }), "secret")).toBe(false);
  });

  it("accepts only the exact bearer token", async () => {
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer secret" }
    }), "secret")).toBe(true);
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer Secret" }
    }), "secret")).toBe(false);
  });
});
~~~

- [ ] **Step 2: Verify auth tests fail**

Run: npm test -- test/auth.spec.ts

Expected: FAIL because src/auth.ts does not exist.

- [ ] **Step 3: Implement constant-time token comparison**

Create src/auth.ts. Parse only the Bearer scheme. SHA-256 both strings so the comparison loop always handles equal-length arrays:

~~~ts
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
}

export async function isAuthorized(
  request: Request,
  expectedToken: string
): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const actual = await digest(header.slice(7));
  const expected = await digest(expectedToken);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}
~~~

- [ ] **Step 4: Write failing Worker route tests**

In test/worker.spec.ts call an exported routeRequest function with a fake Monitor stub. Verify:

- Every /api route returns 401 without the correct token.
- GET /api/status calls getStatus.
- PUT /api/config rejects non-JSON, non-array watchedCodes, duplicate codes, and non-string codes with 400.
- POST /api/check calls tick with force=true.
- POST /api/test-notification calls testNotification.
- Successful and error JSON responses use Cache-Control: no-store.
- Unknown routes return 404 without leaking env values.
- The scheduled handler calls tick(controller.scheduledTime, false).

- [ ] **Step 5: Implement Worker routes and scheduled forwarding**

Replace src/index.ts with exports for Monitor and the Worker handler. Use one named object:

~~~ts
import { Monitor } from "./monitor-do";
import { isAuthorized } from "./auth";
import type { Env } from "./types";

export { Monitor };

function getMonitor(env: Env) {
  const id = env.MONITOR.idFromName("primary");
  return env.MONITOR.get(id) as DurableObjectStub<Monitor>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
~~~

routeRequest must authorize before parsing a body, use sanitized messages such as invalid configuration or internal error, and never stringify thrown error objects into HTTP responses.

The default export must be:

~~~ts
export default {
  fetch(request, env) {
    return routeRequest(request, env);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getMonitor(env).tick(controller.scheduledTime, false));
  }
} satisfies ExportedHandler<Env>;
~~~

- [ ] **Step 6: Run route tests and all checks**

Run:

~~~bash
npm test -- test/auth.spec.ts test/worker.spec.ts
npm test
npm run typecheck
~~~

Expected: PASS.

- [ ] **Step 7: Commit the gateway**

~~~bash
git add src/auth.ts src/index.ts src/types.ts test/auth.spec.ts test/worker.spec.ts
git commit -m "feat: expose authenticated monitor API"
~~~

---

### Task 6: Mobile Admin Page

**Files:**
- Create: src/admin-html.ts
- Modify: src/index.ts
- Modify: test/worker.spec.ts

**Interfaces:**
- Consumes: the four authenticated /api routes from Task 5.
- Produces: renderAdminPage(): string.
- Produces: public GET / HTML shell with no embedded state or secret.

- [ ] **Step 1: Add failing UI delivery tests**

Extend test/worker.spec.ts to assert:

~~~ts
it("serves a no-store mobile admin shell without secrets", async () => {
  const response = await routeRequest(new Request("https://worker.test/"), env);
  const body = await response.text();
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body).toContain("TRAE 余票监测");
  expect(body).toContain("sessionStorage");
  expect(body).not.toContain("test-admin-token");
  expect(body).not.toContain("test-bark-key");
});
~~~

Also assert the response includes a restrictive Content-Security-Policy with default-src 'none', connect-src 'self', and only inline script/style required by this single-file page.

- [ ] **Step 2: Run the UI test and verify failure**

Run: npm test -- test/worker.spec.ts

Expected: FAIL because GET / is not yet implemented.

- [ ] **Step 3: Build the mobile-first page**

Create src/admin-html.ts with a complete static document. The page must include:

- Password-type ADMIN_TOKEN input and login button.
- A status banner for last success, source health, and last error summary.
- A fieldset populated with active future catalog slots.
- Save watched slots, check now, test Bark, and log out buttons.
- Accessible labels, minimum 44px controls, and viewport metadata.
- No third-party scripts, fonts, images, analytics, or remote assets.

The script must:

~~~js
const tokenKey = "trae-admin-token";

async function api(path, init = {}) {
  const token = sessionStorage.getItem(tokenKey);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", "Bearer " + token);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  if (response.status === 401) {
    sessionStorage.removeItem(tokenKey);
    throw new Error("管理密钥无效，请重新输入");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
~~~

Render API text with document.createTextNode or textContent only. Never put source values into innerHTML. Store the token only after a successful GET /api/status. Log out removes the sessionStorage entry and clears the visible slot list.

- [ ] **Step 4: Serve the page with security headers**

Modify src/index.ts so GET / returns renderAdminPage() with:

~~~ts
{
  status: 200,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  }
}
~~~

- [ ] **Step 5: Run UI, full test, and type checks**

Run:

~~~bash
npm test -- test/worker.spec.ts
npm test
npm run typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit the admin UI**

~~~bash
git add src/admin-html.ts src/index.ts test/worker.spec.ts
git commit -m "feat: add mobile slot configuration page"
~~~

---

### Task 7: Integration Verification and Deployment Guide

**Files:**
- Create: README.md
- Modify: test/worker.spec.ts
- Modify: package.json

**Interfaces:**
- Consumes: the complete Worker, Durable Object, and admin UI.
- Produces: reproducible local verification and deployment instructions.
- Produces: a dry-run bundle proven not to contain user secrets.

- [ ] **Step 1: Add Durable Object integration cases**

Extend test/worker.spec.ts using the Workers Vitest runtime and mocked outbound fetch. Verify this end-to-end sequence through the Worker API:

1. Authenticate with test-admin-token.
2. Force an initial sold-out response.
3. Configure D1-1200 and D1-1400.
4. Return remaining=1 for D1-1200.
5. Confirm one Bark POST.
6. Return remaining=1 again.
7. Confirm no second Bark POST.
8. Return remaining=0, then remaining=1.
9. Confirm the second availability transition produces exactly one more Bark POST.
10. Read /api/status and confirm no secret value occurs in serialized output.

Reset the named Durable Object between test cases with the current Cloudflare test helper:

~~~ts
import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

afterEach(async () => {
  await reset();
});
~~~

Use exports.default.fetch() from cloudflare:workers for requests. Mock globalThis.fetch with vi.spyOn because the main Worker and test share one isolate; return source JSON for the TRAE hostname and record Bark POST bodies for api.day.app.

- [ ] **Step 2: Run the integration case and fix only contract mismatches**

Run: npm test -- test/worker.spec.ts

Expected: PASS. If a mismatch appears, change the smallest implementation surface and re-run this exact file before the full suite.

- [ ] **Step 3: Write README deployment and iPhone instructions**

README.md must include these exact commands:

~~~bash
npm install
npm test
npm run typecheck
npx wrangler deploy --dry-run --outdir dist
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put BARK_DEVICE_KEY
npm run deploy
~~~

Explain:

- ADMIN_TOKEN should be a newly generated random value of at least 24 characters.
- BARK_DEVICE_KEY is copied from the Bark app's personal push URL and entered only at the secret prompt.
- Open the deployed workers.dev URL in iPhone Safari, enter ADMIN_TOKEN, verify the two default slots, run one check, and send one Bark test.
- The Bark test must be tapped to verify weixin:// opens WeChat; if iOS blocks it, the notification still instructs the user to open WeChat manually.
- After the activity, leaving the Worker deployed creates no source traffic when no watched future slot remains.
- To reuse it, select future active slots from the page.
- To remove it, delete the Worker and both secrets in the Cloudflare dashboard.
- Remove or untrust the temporary Stream CA certificate if that cleanup was not already completed.

Link only primary documentation:

- Cloudflare Cron Triggers.
- Cloudflare Wrangler configuration and Secrets.
- Cloudflare Durable Objects.
- Cloudflare Workers Vitest integration.
- Bark push API.

- [ ] **Step 4: Add final verification scripts**

Add package scripts:

~~~json
{
  "scripts": {
    "verify": "npm run typecheck && npm test && wrangler deploy --dry-run --outdir dist",
    "check:secrets": "rg -n \"test-admin-token|test-bark-key|BARK_DEVICE_KEY=|ADMIN_TOKEN=\" src README.md wrangler.jsonc"
  }
}
~~~

The secret scan is expected to find test literals only under test/. Keep test/ outside the production scan. Run a second manual command over the bundle:

~~~bash
npm run verify
npm run check:secrets
rg -n "test-admin-token|test-bark-key|Stream-2026|\\.har" dist src README.md wrangler.jsonc
~~~

Expected:

- verify exits 0.
- check:secrets exits 1 because no match exists in production files.
- bundle scan exits 1 because no forbidden string exists.

- [ ] **Step 5: Inspect the dry-run deployment metadata**

Run:

~~~bash
npx wrangler deploy --dry-run --outdir dist
rg -n "\"crons\"|Monitor|sqlite|\\* \\* \\* \\* \\*" wrangler.jsonc dist
~~~

Expected: configuration shows the minute Cron, MONITOR binding, Monitor export, and SQLite storage. The bundle contains no Bark key or admin token value.

- [ ] **Step 6: Commit verification and operations documentation**

~~~bash
git add README.md package.json package-lock.json test/worker.spec.ts
git commit -m "docs: add deployment and verification workflow"
~~~

---

## Final Acceptance Checklist

- [ ] npm run verify passes from a clean install.
- [ ] The production bundle contains no real or test secret.
- [ ] The official source receives no requests during tests.
- [ ] The deployed Worker performs one real check and returns both default slot states.
- [ ] One Bark test arrives on the iPhone.
- [ ] Tapping the test opens WeChat or the documented fallback is confirmed.
- [ ] The admin page can add, remove, and persist watched future slots.
- [ ] A mocked sold_out-to-available transition produces exactly one alert.
- [ ] A stable available state produces no repeated alert.
- [ ] A later sold_out-to-available transition alerts again.
- [ ] Each slot stops at its own starts_at timestamp.
- [ ] Empty or fully ended selections produce no source traffic.
- [ ] Logs and status responses contain no token, Bark key, HAR data, or full source payload.
- [ ] git status --short is clean after the final commit.

## Primary References

- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/durable-objects/get-started/
- https://developers.cloudflare.com/workers/testing/vitest-integration/
- https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md
