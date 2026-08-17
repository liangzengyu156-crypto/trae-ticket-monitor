import { describe, expect, it, vi } from "vitest";
import { fetchTimeSlots, sendBark, SourceResponseError } from "../src/clients";
import type { NotificationIntent, SourceSlot } from "../src/types";

const sourceUrl = "https://trae-party-2026.siliconpear.cn/api/v1/time-slots";
const barkUrl = "https://api.day.app/push";

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

const intent: NotificationIntent = {
  id: "slot:D1-1200",
  title: "票务提醒",
  body: "D1-1200 有余票",
  group: "trae-ticket-monitor",
  sound: "alarm",
  url: "weixin://"
};

describe("fetchTimeSlots", () => {
  it("requests the public source with JSON acceptance", async () => {
    const fetcher = vi.fn(async () => Response.json([sourceSlot()]));

    await fetchTimeSlots(fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledWith(sourceUrl, expect.objectContaining({
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error"
    }));
  });

  it("parses a valid source slot", async () => {
    const fetcher = vi.fn(async () => Response.json([sourceSlot()]));

    const result = await fetchTimeSlots(fetcher as typeof fetch);

    expect(result).toEqual([sourceSlot()]);
  });

  it("accepts explicit UTC Z timestamps", async () => {
    const utcSlot = sourceSlot({
      starts_at: "2026-08-21T04:00:00Z",
      ends_at: "2026-08-21T06:00:00Z"
    });
    const fetcher = vi.fn(async () => Response.json([utcSlot]));

    expect(await fetchTimeSlots(fetcher as typeof fetch)).toEqual([utcSlot]);
  });

  it.each([
    ["HTTP failure", () => new Response("server says secret", { status: 503 })],
    ["non-array JSON", () => Response.json({ token: "secret" })],
    ["missing code", () => Response.json([{ ...sourceSlot(), code: undefined }])]
  ])("rejects %s with a sanitized source error", async (_caseName, response) => {
    const fetcher = vi.fn(async () => response());

    const failure = fetchTimeSlots(fetcher as typeof fetch);

    await expect(failure).rejects.toBeInstanceOf(SourceResponseError);
    await expect(failure).rejects.not.toThrow(/server says secret|token|secret|Accept/i);
  });

  it("rejects a non-finite remaining value from a source response", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [sourceSlot({ remaining: Infinity })]
    }));

    await expect(fetchTimeSlots(fetcher as unknown as typeof fetch)).rejects.toBeInstanceOf(SourceResponseError);
  });

  it.each([
    ["timezone-less start", { starts_at: "2026-08-21T12:00:00" }],
    ["invalid start", { starts_at: "not-a-date" }],
    ["timezone-less end", { ends_at: "2026-08-21T14:00:00" }],
    ["invalid end", { ends_at: "2026-02-30T14:00:00+08:00" }],
    ["equal bounds", { ends_at: "2026-08-21T12:00:00+08:00" }],
    ["reversed bounds", { ends_at: "2026-08-21T11:59:59+08:00" }]
  ])("rejects %s before schedule state can become non-expiring", async (_name, overrides) => {
    const fetcher = vi.fn(async () => Response.json([sourceSlot(overrides)]));

    await expect(fetchTimeSlots(fetcher as typeof fetch)).rejects.toBeInstanceOf(SourceResponseError);
  });

  it("rejects duplicate slot codes", async () => {
    const fetcher = vi.fn(async () => Response.json([sourceSlot(), sourceSlot()]));

    await expect(fetchTimeSlots(fetcher as typeof fetch)).rejects.toThrow("invalid source: duplicate code");
  });

  it("preserves a sanitized source timeout classification", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      throw init?.signal?.reason;
    });

    await expect(fetchTimeSlots(fetcher as typeof fetch, controller.signal)).rejects.toThrow("source timeout");
  });
});

describe("sendBark", () => {
  it("posts the complete Bark payload", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await sendBark(fetcher as typeof fetch, "device-secret", intent);

    expect(fetcher).toHaveBeenCalledWith(barkUrl, expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      redirect: "error",
      body: JSON.stringify({
        device_key: "device-secret",
        title: "票务提醒",
        body: "D1-1200 有余票",
        group: "trae-ticket-monitor",
        sound: "alarm",
        url: "weixin://"
      })
    }));
  });

  it("does not expose the device key when Bark rejects a request", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 }));

    const failure = sendBark(fetcher as typeof fetch, "device-secret", intent);

    await expect(failure).rejects.toThrow("Bark HTTP 500");
    await expect(failure).rejects.not.toThrow("device-secret");
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "]
  ])("rejects a %s Bark device key without making a request", async (_name, deviceKey) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(sendBark(fetcher as typeof fetch, deviceKey as string, intent)).rejects.toThrow("Bark configuration unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds Bark delivery time and reports a sanitized failure", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("device-secret deadline", "TimeoutError"));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      throw init?.signal?.reason;
    });

    const failure = sendBark(fetcher as typeof fetch, "device-secret", intent, controller.signal);

    await expect(failure).rejects.toThrow("Bark timeout");
    await expect(failure).rejects.not.toThrow("device-secret");
  });
});
