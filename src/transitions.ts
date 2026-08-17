import type {
  MonitorRecord,
  NotificationIntent,
  ObservedState,
  SlotState,
  SourceSlot
} from "./types";

function timestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function shanghaiDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")} ${byType.get("hour")}:${byType.get("minute")}:${byType.get("second")}`;
}

function shanghaiMonthDay(value: string): string {
  const date = shanghaiDateTime(value).slice(0, 10);
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function shanghaiClock(value: string): string {
  return shanghaiDateTime(value).slice(11);
}

function availabilityIntent(
  code: string,
  slot: Pick<SlotState, "startsAt" | "displayTime" | "lastRemaining" | "lastCheckedAt">
): NotificationIntent {
  return {
    id: "slot:" + code,
    title: "🚨 TRAE 放票：" + slot.displayTime,
    body:
      "剩余 " + String(slot.lastRemaining ?? "未知") +
      " 个名额｜" + shanghaiMonthDay(slot.startsAt) +
      " " + shanghaiClock(String(slot.lastCheckedAt)) +
      " 检测到。立即打开微信 → 最近使用 → TRAE AI创造力大赛",
    group: "trae-ticket-monitor",
    sound: "alarm",
    url: "weixin://",
    level: "critical",
    call: "1",
    volume: "10"
  };
}

export function classifyAvailability(slot: SourceSlot, nowMs: number): ObservedState {
  if (nowMs >= Date.parse(slot.starts_at)) return "ended";
  if (slot.is_active && (slot.is_available || slot.remaining > 0)) return "available";
  return "sold_out";
}

function updateSlot(code: string, previous: SlotState, source: SourceSlot, nowMs: number): SlotState {
  const observedState = classifyAvailability(source, nowMs);
  const becameAvailable =
    observedState === "available" &&
    (previous.observedState === "unknown" || previous.observedState === "sold_out");
  const nextObservation = {
    startsAt: source.starts_at,
    displayTime: source.display_time,
    lastRemaining: source.remaining,
    lastCheckedAt: timestamp(nowMs)
  };
  const pendingNotification = previous.notificationPending
    ? previous.pendingNotification ?? availabilityIntent(code, previous)
    : becameAvailable
      ? availabilityIntent(code, nextObservation)
      : null;

  return {
    ...previous,
    observedState,
    ...nextObservation,
    notificationPending: observedState === "ended" ? false : becameAvailable || previous.notificationPending,
    pendingNotification: observedState === "ended" ? null : pendingNotification
  };
}

function endSlotIfStarted(previous: SlotState, nowMs: number): SlotState {
  if (nowMs < Date.parse(previous.startsAt)) return previous;
  return {
    ...previous,
    observedState: "ended",
    notificationPending: false,
    pendingNotification: null
  };
}

export function applyCatalogSuccess(
  record: MonitorRecord,
  catalog: SourceSlot[],
  nowMs: number
): MonitorRecord {
  const byCode = new Map(catalog.map((slot) => [slot.code, slot]));
  const slots = { ...record.slots };

  for (const code of record.config.watchedCodes) {
    const source = byCode.get(code);
    const previous = slots[code];
    if (!previous) continue;
    slots[code] = source ? updateSlot(code, previous, source, nowMs) : endSlotIfStarted(previous, nowMs);
  }

  const recoveredFromDeliveredFailure = record.health.sourceFailureNotified;
  return {
    ...record,
    catalog: catalog.map((slot) => ({ ...slot })),
    slots,
    health: {
      ...record.health,
      consecutiveSourceFailures: 0,
      sourceFailureNotificationPending: false,
      recoveryNotificationPending:
        recoveredFromDeliveredFailure || record.health.recoveryNotificationPending,
      lastSuccessAt: timestamp(nowMs),
      lastErrorSummary: null
    }
  };
}

export function applySourceFailure(
  record: MonitorRecord,
  nowMs: number,
  summary: string
): MonitorRecord {
  const consecutiveSourceFailures = record.health.consecutiveSourceFailures + 1;
  const shouldQueueFailureAlert =
    consecutiveSourceFailures >= 3 &&
    !record.health.sourceFailureNotified &&
    !record.health.sourceFailureNotificationPending;

  return {
    ...record,
    health: {
      ...record.health,
      consecutiveSourceFailures,
      sourceFailureNotificationPending:
        record.health.sourceFailureNotificationPending || shouldQueueFailureAlert,
      recoveryNotificationPending: false,
      lastErrorAt: timestamp(nowMs),
      lastErrorSummary: summary
    }
  };
}

export function markNotificationDelivered(
  record: MonitorRecord,
  notificationId: string,
  nowMs: number
): MonitorRecord {
  if (notificationId.startsWith("slot:")) {
    const code = notificationId.slice("slot:".length);
    const slot = record.slots[code];
    if (!slot) return record;
    return {
      ...record,
      slots: {
        ...record.slots,
        [code]: {
          ...slot,
          notificationPending: false,
          pendingNotification: null,
          lastNotifiedAt: timestamp(nowMs)
        }
      }
    };
  }

  if (notificationId === "health:failure") {
    return {
      ...record,
      health: {
        ...record.health,
        sourceFailureNotificationPending: false,
        sourceFailureNotified: true
      }
    };
  }

  if (notificationId === "health:recovery") {
    return {
      ...record,
      health: {
        ...record.health,
        recoveryNotificationPending: false,
        sourceFailureNotified: false
      }
    };
  }

  return record;
}

export function listPendingNotifications(record: MonitorRecord): NotificationIntent[] {
  const notifications: NotificationIntent[] = [];
  for (const code of record.config.watchedCodes) {
    const slot = record.slots[code];
    if (slot?.notificationPending) {
      notifications.push(slot.pendingNotification ?? availabilityIntent(code, slot));
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
