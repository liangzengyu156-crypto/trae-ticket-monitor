import type { Monitor } from "./monitor-do";

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
  pendingNotification?: NotificationIntent | null;
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

export interface NotificationIntent {
  id: string;
  title: string;
  body: string;
  group: "trae-ticket-monitor";
  sound: "alarm";
  url: "weixin://";
  level?: "critical" | "active" | "timeSensitive" | "passive";
  call?: "1";
  volume?: "10";
}

export interface SlotStatusView {
  code: string;
  active: boolean;
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

export type ConfigUpdateResult =
  | { ok: true; status: StatusView }
  | { ok: false; error: "invalid configuration" };

export interface Env {
  MONITOR: DurableObjectNamespace<Monitor>;
  ADMIN_TOKEN: string;
  BARK_DEVICE_KEY: string;
}
