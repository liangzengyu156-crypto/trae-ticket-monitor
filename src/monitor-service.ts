import { SourceResponseError } from "./clients";
import { planTick } from "./schedule";
import {
  availabilityCopy,
  applyCatalogSuccess,
  applySourceFailure,
  listPendingNotifications,
  markNotificationDelivered,
  shanghaiClock
} from "./transitions";
import type {
  MonitorRecord,
  ConfigUpdateResult,
  NotificationIntent,
  ObservedState,
  SlotState,
  SlotStatusView,
  SourceSlot,
  StatusView
} from "./types";

export interface MonitorStore {
  load(): Promise<MonitorRecord>;
  save(record: MonitorRecord): Promise<void>;
}

export interface MonitorDependencies {
  now: () => number;
  fetchSlots: () => Promise<SourceSlot[]>;
  push: (intent: NotificationIntent) => Promise<void>;
}

function timestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function unknownSlot(source: SourceSlot): SlotState {
  return {
    observedState: "unknown",
    startsAt: source.starts_at,
    displayTime: source.display_time,
    lastRemaining: null,
    lastCheckedAt: null,
    lastNotifiedAt: null,
    notificationPending: false,
    pendingNotification: null
  };
}

export function markEndedSlots(
  record: MonitorRecord,
  codes: string[],
  _nowMs: number
): MonitorRecord {
  const slots = { ...record.slots };
  for (const code of codes) {
    const slot = slots[code];
    if (!slot) continue;
    slots[code] = {
      ...slot,
      observedState: "ended",
      notificationPending: false,
      pendingNotification: null
    };
  }
  return { ...record, slots };
}

export function toStatusView(record: MonitorRecord, nowMs: number): StatusView {
  const catalogByCode = new Map(record.catalog.map((slot) => [slot.code, slot]));
  const codes = new Set([...catalogByCode.keys(), ...Object.keys(record.slots)]);
  const watched = new Set(record.config.watchedCodes);
  const slots: SlotStatusView[] = [...codes].map((code) => {
    const source = catalogByCode.get(code);
    const stored = record.slots[code];
    return {
      code,
      active: source?.is_active === true,
      watched: watched.has(code),
      observedState: stored?.observedState ?? "unknown",
      startsAt: stored?.startsAt ?? source?.starts_at ?? "",
      endsAt: source?.ends_at ?? "",
      displayTime: stored?.displayTime ?? source?.display_time ?? code,
      remaining: stored?.lastRemaining ?? null,
      lastCheckedAt: stored?.lastCheckedAt ?? null
    };
  });
  slots.sort((left, right) => {
    const startDifference = Date.parse(left.startsAt) - Date.parse(right.startsAt);
    return Number.isFinite(startDifference) && startDifference !== 0
      ? startDifference
      : left.code.localeCompare(right.code);
  });

  return {
    now: timestamp(nowMs),
    watchedCodes: [...record.config.watchedCodes],
    slots,
    health: {
      consecutiveSourceFailures: record.health.consecutiveSourceFailures,
      lastSuccessAt: record.health.lastSuccessAt,
      lastErrorAt: record.health.lastErrorAt,
      lastErrorSummary: record.health.lastErrorSummary
    }
  };
}

export function assertWatchedCodesPresent(catalog: SourceSlot[], activeCodes: string[]): void {
  const codes = new Set(catalog.map((slot) => slot.code));
  if (activeCodes.some((code) => !codes.has(code))) {
    throw new SourceResponseError("watched slot missing");
  }
}

export function sanitizeError(error: unknown): string {
  if (error instanceof SourceResponseError) {
    if (/^source HTTP \d+$/.test(error.message)) return error.message;
    if (error.message.startsWith("invalid source") || error.message === "watched slot missing") {
      return "invalid source response";
    }
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || /timeout/i.test(error.message))
  ) {
    return "source timeout";
  }
  return "source unavailable";
}

export class MonitorService {
  constructor(
    private readonly store: MonitorStore,
    private readonly dependencies: MonitorDependencies
  ) {}

  async tick(nominalMs: number, force = false): Promise<StatusView> {
    let record = await this.store.load();
    const executionNowMs = this.dependencies.now();
    const plan = planTick(record, nominalMs, executionNowMs);
    record = markEndedSlots(record, plan.endedCodes, executionNowMs);
    await this.store.save(record);

    const eligibleActiveCodes = new Set(plan.activeCodes);
    let preFetchNowMs = executionNowMs;
    let preFetchPlan = plan;
    while (true) {
      preFetchNowMs = this.dependencies.now();
      preFetchPlan = planTick(record, nominalMs, preFetchNowMs);
      const newlyEndedCodes = [...eligibleActiveCodes].filter(
        (code) => !preFetchPlan.activeCodes.includes(code)
      );
      if (newlyEndedCodes.length === 0) break;

      record = markEndedSlots(record, newlyEndedCodes, preFetchNowMs);
      for (const code of newlyEndedCodes) eligibleActiveCodes.delete(code);
      await this.store.save(record);
    }

    if (!force && !preFetchPlan.shouldFetch) return toStatusView(record, preFetchNowMs);
    if (eligibleActiveCodes.size === 0) return toStatusView(record, preFetchNowMs);

    try {
      const catalog = await this.dependencies.fetchSlots();
      const observationNowMs = this.dependencies.now();
      const observationPlan = planTick(record, nominalMs, observationNowMs);
      record = markEndedSlots(record, observationPlan.endedCodes, observationNowMs);
      assertWatchedCodesPresent(catalog, observationPlan.activeCodes);
      record = applyCatalogSuccess(record, catalog, observationNowMs);
    } catch (error) {
      record = applySourceFailure(record, this.dependencies.now(), sanitizeError(error));
    }

    await this.store.save(record);
    record = await this.flushPending(record);
    return toStatusView(record, this.dependencies.now());
  }

  async getStatus(_nominalMs: number): Promise<StatusView> {
    return toStatusView(await this.store.load(), this.dependencies.now());
  }

  async setConfig(codes: string[], nominalMs: number): Promise<ConfigUpdateResult> {
    const record = await this.store.load();
    const uniqueCodes = [...new Set(codes)];
    if (uniqueCodes.length !== codes.length) {
      return { ok: false, error: "invalid configuration" };
    }

    const catalogByCode = new Map(record.catalog.map((slot) => [slot.code, slot]));
    const validationNowMs = this.dependencies.now();
    for (const code of uniqueCodes) {
      const source = catalogByCode.get(code);
      if (
        !source ||
        !source.is_active ||
        Date.parse(source.starts_at) <= validationNowMs
      ) return { ok: false, error: "invalid configuration" };
    }

    const previousCodes = new Set(record.config.watchedCodes);
    const slots = { ...record.slots };
    for (const code of uniqueCodes) {
      if (!previousCodes.has(code)) {
        const source = catalogByCode.get(code);
        if (source) slots[code] = unknownSlot(source);
      }
    }
    await this.store.save({
      ...record,
      config: { ...record.config, watchedCodes: uniqueCodes },
      slots
    });
    return { ok: true, status: await this.tick(nominalMs, true) };
  }

  async testCopyNotification(): Promise<void> {
    const checkedAt = timestamp(this.dependencies.now());
    await this.dependencies.push({
      id: "test:copy",
      ...availabilityCopy({
        startsAt: "2026-08-21T12:00:00+08:00",
        displayTime: "12:00-14:00",
        lastRemaining: 2,
        lastCheckedAt: checkedAt
      }),
      group: "trae-ticket-monitor",
      sound: "alarm",
      url: "weixin://"
    });
  }

  async testCriticalNotification(): Promise<void> {
    const testTime = shanghaiClock(timestamp(this.dependencies.now()));
    await this.dependencies.push({
      id: "test:critical",
      title: "🚨 TRAE 强提醒铃声测试",
      body: `这是一条铃声测试，不代表有票。将以最大音量每 30 秒重复提醒。测试时间 ${testTime}。`,
      group: "trae-ticket-monitor",
      sound: "alarm",
      url: "weixin://",
      level: "critical",
      call: "1",
      volume: "10"
    });
  }

  private async flushPending(record: MonitorRecord): Promise<MonitorRecord> {
    const beforeFlushMs = this.dependencies.now();
    const expirationPlan = planTick(record, beforeFlushMs, beforeFlushMs);
    if (expirationPlan.endedCodes.length > 0) {
      record = markEndedSlots(record, expirationPlan.endedCodes, beforeFlushMs);
      await this.store.save(record);
    }

    for (const intent of listPendingNotifications(record)) {
      const beforePushMs = this.dependencies.now();
      if (intent.id.startsWith("slot:")) {
        const code = intent.id.slice("slot:".length);
        const slot = record.slots[code];
        if (!slot || beforePushMs >= Date.parse(slot.startsAt)) {
          record = markEndedSlots(record, [code], beforePushMs);
          await this.store.save(record);
          continue;
        }
      }
      try {
        await this.dependencies.push(intent);
      } catch {
        console.warn("notification delivery failed", { id: intent.id, failed: true });
        break;
      }
      record = markNotificationDelivered(record, intent.id, this.dependencies.now());
      await this.store.save(record);
    }
    return record;
  }
}
