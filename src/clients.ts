import type { NotificationIntent, SourceSlot } from "./types";

const SOURCE_URL = "https://trae-party-2026.siliconpear.cn/api/v1/time-slots";
const BARK_URL = "https://api.day.app/push";
const REQUEST_TIMEOUT_MS = 8_000;
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export class SourceResponseError extends Error {}

export async function fetchTimeSlots(
  fetcher: typeof fetch,
  externalSignal?: AbortSignal
): Promise<SourceSlot[]> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetcher(SOURCE_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal
    });
    if (!response.ok) throw new SourceResponseError(`source HTTP ${response.status}`);
    return parseSourceSlots(await response.json());
  } catch (error) {
    if (error instanceof SourceResponseError) throw error;
    if (isTimeout(error)) throw new SourceResponseError("source timeout");
    throw new SourceResponseError("source request failed");
  }
}

export async function sendBark(
  fetcher: typeof fetch,
  deviceKey: string | undefined,
  intent: NotificationIntent,
  externalSignal?: AbortSignal
): Promise<void> {
  if (typeof deviceKey !== "string" || deviceKey.trim() === "") {
    throw new Error("Bark configuration unavailable");
  }
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetcher(BARK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      redirect: "manual",
      signal,
      body: JSON.stringify({
        device_key: deviceKey,
        title: intent.title,
        body: intent.body,
        group: intent.group,
        sound: intent.sound,
        url: intent.url,
        level: intent.level,
        call: intent.call,
        volume: intent.volume
      })
    });
    if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
  } catch (error) {
    if (error instanceof Error && /^Bark HTTP \d+$/.test(error.message)) throw error;
    if (isTimeout(error)) throw new Error("Bark timeout");
    throw new Error("Bark request failed");
  }
}

function parseSourceSlots(value: unknown): SourceSlot[] {
  if (!Array.isArray(value)) throw invalidSource("array");
  const slots = value.map(parseSourceSlot);
  const codes = new Set<string>();
  for (const slot of slots) {
    if (codes.has(slot.code)) throw invalidSource("duplicate code");
    codes.add(slot.code);
  }
  return slots;
}

function parseSourceSlot(value: unknown): SourceSlot {
  if (!isRecord(value)) throw invalidSource("slot");
  const slot = {
    code: stringField(value, "code"),
    starts_at: rfc3339Field(value, "starts_at"),
    ends_at: rfc3339Field(value, "ends_at"),
    is_active: booleanField(value, "is_active"),
    is_available: booleanField(value, "is_available"),
    remaining: finiteNumberField(value, "remaining"),
    unavailable_reason: stringField(value, "unavailable_reason"),
    display_time: stringField(value, "display_time"),
    updated_at: stringField(value, "updated_at")
  };
  if (Date.parse(slot.ends_at) <= Date.parse(slot.starts_at)) throw invalidSource("ends_at");
  return slot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string") throw invalidSource(field);
  return value[field];
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  if (typeof value[field] !== "boolean") throw invalidSource(field);
  return value[field];
}

function finiteNumberField(value: Record<string, unknown>, field: string): number {
  if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
    throw invalidSource(field);
  }
  return value[field];
}

function rfc3339Field(value: Record<string, unknown>, field: string): string {
  const result = stringField(value, field);
  const match = RFC3339_DATE_TIME.exec(result);
  if (!match) throw invalidSource(field);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const validComponents =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  const validOffset = offsetHour === undefined || (
    Number(offsetHour) <= 23 && Number(offsetMinute) <= 59
  );
  if (!validComponents || !validOffset || !Number.isFinite(Date.parse(result))) {
    throw invalidSource(field);
  }
  return result;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timeout/i.test(error.message)
  );
}

function invalidSource(field: string): SourceResponseError {
  return new SourceResponseError(`invalid source: ${field}`);
}
