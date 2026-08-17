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
    notificationPending: false,
    pendingNotification: null
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

export function planTick(
  record: MonitorRecord,
  cadenceMs: number,
  activeAtMs = cadenceMs
): TickPlan {
  const activeCodes: string[] = [];
  const endedCodes: string[] = [];
  for (const code of record.config.watchedCodes) {
    const slot = record.slots[code];
    const startsAtMs = slot ? Date.parse(slot.startsAt) : Number.NaN;
    if (!Number.isFinite(startsAtMs) || activeAtMs >= startsAtMs) endedCodes.push(code);
    else activeCodes.push(code);
  }
  if (activeCodes.length === 0) return { shouldFetch: false, activeCodes, endedCodes };

  const fastWindowMs = record.config.fastWindowHours * 60 * 60 * 1000;
  const inFastWindow = activeCodes.some(
    (code) => Date.parse(record.slots[code].startsAt) - cadenceMs <= fastWindowMs
  );
  const beijingMinute = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      minute: "2-digit"
    }).format(new Date(cadenceMs))
  );
  return {
    shouldFetch: inFastWindow || beijingMinute % record.config.normalIntervalMinutes === 0,
    activeCodes,
    endedCodes
  };
}
