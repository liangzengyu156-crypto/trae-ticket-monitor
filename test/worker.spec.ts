import { exports as workerExports } from "cloudflare:workers";
import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeRequest } from "../src/index";
import type { Monitor } from "../src/monitor-do";
import type { ConfigUpdateResult, Env, StatusView } from "../src/types";

const now = Date.parse("2026-08-20T11:56:00+08:00");
const adminToken = "test-admin-token-123456789";
const barkKey = "test-bark-key-123456789012";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const status: StatusView = {
  now: "2026-08-20T03:56:00.000Z",
  watchedCodes: ["D1-1200"],
  slots: [],
  health: {
    consecutiveSourceFailures: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorSummary: null
  }
};

class FakeMonitor {
  getStatusCalls: number[] = [];
  setConfigCalls: Array<{ codes: string[]; nowMs: number }> = [];
  tickCalls: Array<{ nowMs: number; force: boolean }> = [];
  testCopyNotificationCalls = 0;
  testCriticalNotificationCalls = 0;
  configResult: ConfigUpdateResult = { ok: true, status };
  configFailure = false;

  async getStatus(nowMs: number): Promise<StatusView> {
    this.getStatusCalls.push(nowMs);
    return status;
  }

  async setConfig(codes: string[], nowMs: number): Promise<ConfigUpdateResult> {
    this.setConfigCalls.push({ codes, nowMs });
    if (this.configFailure) throw new Error("storage failed with sensitive details");
    return this.configResult;
  }

  async tick(nowMs: number, force = false): Promise<StatusView> {
    this.tickCalls.push({ nowMs, force });
    return status;
  }

  async testCopyNotification(): Promise<void> {
    this.testCopyNotificationCalls += 1;
  }

  async testCriticalNotification(): Promise<void> {
    this.testCriticalNotificationCalls += 1;
  }
}

function workerEnv(monitor: FakeMonitor, token = adminToken): Env {
  return {
    ADMIN_TOKEN: token,
    BARK_DEVICE_KEY: barkKey,
    MONITOR: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => monitor
    } as unknown as DurableObjectNamespace<Monitor>
  };
}

function authorizedRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + adminToken);
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

async function executeInlineAdminScript(page: string): Promise<Response> {
  const match = page.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("inline admin script missing");
  const evaluator = (env as unknown as { SCRIPT_EVALUATOR: Fetcher }).SCRIPT_EVALUATOR;
  return evaluator.fetch("https://script-evaluator.test/", {
    method: "POST",
    body: match[1]
  });
}

async function exerciseInlineAdminScript(page: string, scenario: string): Promise<Record<string, unknown>> {
  const match = page.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("inline admin script missing");
  const evaluator = (env as unknown as { SCRIPT_EVALUATOR: Fetcher }).SCRIPT_EVALUATOR;
  const response = await evaluator.fetch("https://script-evaluator.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: match[1], scenario })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Record<string, unknown>>;
}

describe("worker routes", () => {
  it("serves a no-store mobile admin shell without secrets", async () => {
    const response = await routeRequest(
      new Request("https://worker.test/"),
      workerEnv(new FakeMonitor())
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(body).toContain("TRAE 余票监测");
    expect(body).toContain("sessionStorage");
    expect(body).toContain('type="password"');
    expect(body).toContain("activeFutureSlots");
    expect(body).toContain("createSessionGate");
    expect(body).toContain("resetAuthenticatedUi");
    expect(body).toContain("throw new UnauthorizedError");
    expect(body).toContain('id="action-feedback"');
    expect(body).toContain("setActionFeedback");
    expect(body).toContain('.action-feedback[data-state="error"]');
    expect(body).toContain("loginButton.disabled = authenticatedBusy");
    expect(body).toContain("authenticatedBusy = true;\n        updateAuthenticatedControls();\n        setLoginBusy(true);");
    const loginBusySection = body.slice(
      body.indexOf("function setLoginBusy"),
      body.indexOf("function setAuthenticatedBusy")
    );
    expect(loginBusySection).toContain("loginButton.dataset.label");
    expect(loginBusySection).not.toContain("button.");
    expect(body).toContain("healthPresentation(data.health, formatTime)");
    expect(body).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(body).toContain("min-height: 44px");
    expect(body).toContain("touch-action: manipulation");
    expect(body).toContain("overflow-wrap: anywhere");
    expect(body).not.toContain("innerHTML");
    expect(body).not.toContain("<script src=");
    expect(body).not.toContain("<link");
    expect(body).not.toContain("http://");
    expect(body).not.toContain("https://");
    expect(body).not.toContain("test-admin-token");
    expect(body).not.toContain("test-bark-key");
  });

  it("rejects every API route before invoking the Monitor", async () => {
    const monitor = new FakeMonitor();
    const env = workerEnv(monitor);

    for (const request of [
      new Request("https://worker.test/api"),
      new Request("https://worker.test/api/status"),
      new Request("https://worker.test/api/config", { method: "PUT", body: "not json" }),
      new Request("https://worker.test/api/check", { method: "POST" }),
      new Request("https://worker.test/api/test-notification", { method: "POST" }),
      new Request("https://worker.test/api/test-critical-notification", { method: "POST" })
    ]) {
      const response = await routeRequest(request, env);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }

    expect(monitor.getStatusCalls).toEqual([]);
    expect(monitor.setConfigCalls).toEqual([]);
    expect(monitor.tickCalls).toEqual([]);
    expect(monitor.testCopyNotificationCalls).toBe(0);
    expect(monitor.testCriticalNotificationCalls).toBe(0);
  });

  it.each([
    ["leading", " " + adminToken],
    ["trailing", adminToken + " "]
  ])("fails closed when ADMIN_TOKEN has %s whitespace", async (_name, configuredToken) => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer " + configuredToken }
    }), workerEnv(monitor, configuredToken));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(monitor.getStatusCalls).toEqual([]);
  });

  it("returns the primary Monitor status", async () => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(authorizedRequest("/api/status"), workerEnv(monitor));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expect(monitor.getStatusCalls).toHaveLength(1);
  });

  it("rejects invalid configurations without calling the Monitor", async () => {
    const monitor = new FakeMonitor();
    const env = workerEnv(monitor);
    const requests = [
      authorizedRequest("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: '{"watchedCodes":['
      }),
      authorizedRequest("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchedCodes: "D1-1200" })
      }),
      authorizedRequest("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchedCodes: ["D1-1200", "D1-1200"] })
      }),
      authorizedRequest("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchedCodes: ["D1-1200", 1200] })
      })
    ];

    for (const request of requests) {
      const response = await routeRequest(request, env);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "invalid configuration" });
    }

    expect(monitor.setConfigCalls).toEqual([]);
  });

  it("updates valid watched codes", async () => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(authorizedRequest("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchedCodes: ["D1-1200"] })
    }), workerEnv(monitor));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expect(monitor.setConfigCalls).toHaveLength(1);
    expect(monitor.setConfigCalls[0]?.codes).toEqual(["D1-1200"]);
  });

  it("returns 400 only for a serializable configuration validation result", async () => {
    const monitor = new FakeMonitor();
    monitor.configResult = { ok: false, error: "invalid configuration" };
    const response = await routeRequest(authorizedRequest("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchedCodes: ["missing"] })
    }), workerEnv(monitor));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid configuration" });
  });

  it("returns a sanitized 500 when configuration storage fails unexpectedly", async () => {
    const monitor = new FakeMonitor();
    monitor.configFailure = true;
    const response = await routeRequest(authorizedRequest("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchedCodes: ["D1-1200"] })
    }), workerEnv(monitor));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
  });

  it("forces an immediate Monitor check", async () => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(authorizedRequest("/api/check", { method: "POST" }), workerEnv(monitor));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expect(monitor.tickCalls).toHaveLength(1);
    expect(monitor.tickCalls[0]?.force).toBe(true);
  });

  it("sends a production-copy preview through the primary Monitor", async () => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(
      authorizedRequest("/api/test-notification", { method: "POST" }),
      workerEnv(monitor)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(monitor.testCopyNotificationCalls).toBe(1);
    expect(monitor.testCriticalNotificationCalls).toBe(0);
  });

  it("sends a critical ringtone test through the primary Monitor", async () => {
    const monitor = new FakeMonitor();
    const response = await routeRequest(
      authorizedRequest("/api/test-critical-notification", { method: "POST" }),
      workerEnv(monitor)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(monitor.testCopyNotificationCalls).toBe(0);
    expect(monitor.testCriticalNotificationCalls).toBe(1);
  });

  it("hides environment values on unknown routes", async () => {
    const response = await routeRequest(
      new Request("https://worker.test/not-real?token=should-not-appear"),
      workerEnv(new FakeMonitor(), "sensitive-admin-token-123456")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("sensitive-admin-token-123456");
  });
});

describe("worker Durable Object integration", () => {
  it("initializes the inline admin script returned by the bundled Worker", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const page = await response.text();
    const evaluation = await executeInlineAdminScript(page);

    expect(response.status).toBe(200);
    expect(await evaluation.text()).toBe("");
    expect(evaluation.status).toBe(204);
  });

  it("clears the token input after login and resets health state on logout", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const result = await exerciseInlineAdminScript(await response.text(), "login-logout");

    expect(result).toEqual({
      tokenAfterLogin: "",
      storedAfterLogin: adminToken,
      statusAfterLogout: "请输入管理密钥以加载状态。",
      healthAfterLogout: "",
      lastErrorAfterLogout: "",
      tokenErrorAfterLogout: "",
      actionAfterLogout: "已退出登录。"
    });
  });

  it("announces a failed login in only the token error region", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const result = await exerciseInlineAdminScript(await response.text(), "login-failure");

    expect(result).toEqual({
      tokenError: "暂时无法读取状态",
      actionFeedback: ""
    });
  });

  it("resets the health banner and avoids duplicate announcements after a 401", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const result = await exerciseInlineAdminScript(await response.text(), "login-unauthorized");

    expect(result).toEqual({
      statusSummary: "请输入管理密钥以加载状态。",
      healthSummary: "",
      lastError: "",
      tokenError: "管理密钥无效，请重新输入",
      actionFeedback: ""
    });
  });

  it("wires separate production-copy and confirmed critical test actions", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const result = await exerciseInlineAdminScript(await response.text(), "notification-tests");

    expect(result).toEqual({
      fetchPaths: ["/api/test-notification", "/api/test-critical-notification"],
      confirmCalls: ["将触发最大音量并每 30 秒重复响铃。确认发送强提醒测试吗？"],
      actionFeedback: "强提醒铃声测试已发送。"
    });
  });

  it("does not send a critical test when the confirmation is cancelled", async () => {
    const response = await workerExports.default.fetch(new Request("https://worker.test/"));
    const result = await exerciseInlineAdminScript(await response.text(), "critical-cancel");

    expect(result).toEqual({
      fetchPaths: [],
      confirmCalls: ["将触发最大音量并每 30 秒重复响铃。确认发送强提醒测试吗？"]
    });
  });

  it("persists transition state and emits exactly one Bark POST per availability transition", async () => {
    let d1Remaining = 0;
    const barkRequests: Array<{
      method: string | undefined;
      contentType: string | null;
      body: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === "https://trae-party-2026.siliconpear.cn/api/v1/time-slots") {
        if (init?.method !== "GET") throw new Error("source request must use GET");
        return Response.json([
          {
            code: "D1-1200",
            starts_at: "2026-08-21T12:00:00+08:00",
            ends_at: "2026-08-21T14:00:00+08:00",
            is_active: true,
            is_available: d1Remaining > 0,
            remaining: d1Remaining,
            unavailable_reason: d1Remaining > 0 ? "" : "已满",
            display_time: "12:00-14:00",
            updated_at: "2026-08-17T12:00:00+08:00"
          },
          {
            code: "D1-1400",
            starts_at: "2026-08-21T14:00:00+08:00",
            ends_at: "2026-08-21T16:00:00+08:00",
            is_active: true,
            is_available: false,
            remaining: 0,
            unavailable_reason: "已满",
            display_time: "14:00-16:00",
            updated_at: "2026-08-17T12:00:00+08:00"
          }
        ]);
      }
      if (url.href === "https://api.day.app/push") {
        barkRequests.push({
          method: init?.method,
          contentType: new Headers(init?.headers).get("Content-Type"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>
        });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected outbound request to ${url.href}`);
    });

    const runtimeRequest = (path: string, init: RequestInit = {}) =>
      workerExports.default.fetch(authorizedRequest(path, init));

    expect((await runtimeRequest("/api/check", { method: "POST" })).status).toBe(200);
    const pausedConfig = await runtimeRequest("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchedCodes: [] })
    });
    expect(pausedConfig.status).toBe(200);
    expect((await pausedConfig.json() as StatusView).watchedCodes).toEqual([]);

    const restoredConfig = await runtimeRequest("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchedCodes: ["D1-1200", "D1-1400"] })
    });
    expect(restoredConfig.status).toBe(200);
    expect((await restoredConfig.json() as StatusView).watchedCodes).toEqual(["D1-1200", "D1-1400"]);
    const persistedConfig = await runtimeRequest("/api/status");
    expect((await persistedConfig.json() as StatusView).watchedCodes).toEqual(["D1-1200", "D1-1400"]);

    d1Remaining = 1;
    expect((await runtimeRequest("/api/check", { method: "POST" })).status).toBe(200);
    expect(barkRequests).toHaveLength(1);
    expect(barkRequests[0]).toMatchObject({
      method: "POST",
      contentType: "application/json; charset=utf-8",
      body: {
        device_key: barkKey,
        title: "🚨 TRAE 放票：12:00-14:00",
        group: "trae-ticket-monitor",
        url: "weixin://"
      }
    });

    expect((await runtimeRequest("/api/check", { method: "POST" })).status).toBe(200);
    expect(barkRequests).toHaveLength(1);

    d1Remaining = 0;
    expect((await runtimeRequest("/api/check", { method: "POST" })).status).toBe(200);
    d1Remaining = 1;
    expect((await runtimeRequest("/api/check", { method: "POST" })).status).toBe(200);
    expect(barkRequests).toHaveLength(2);

    const statusResponse = await runtimeRequest("/api/status");
    expect(statusResponse.status).toBe(200);
    const serializedStatus = await statusResponse.text();
    expect(serializedStatus).not.toContain(adminToken);
    expect(serializedStatus).not.toContain(barkKey);
  });
});

describe("scheduled worker", () => {
  it("forwards the scheduled time to a non-forced Monitor tick", async () => {
    const monitor = new FakeMonitor();
    const pending: Promise<unknown>[] = [];
    const worker = (await import("../src/index")).default;

    await worker.scheduled?.(
      { scheduledTime: now, cron: "* * * * *", noRetry: () => undefined },
      workerEnv(monitor),
      {
        waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
        passThroughOnException: () => undefined
      } as unknown as ExecutionContext
    );
    await Promise.all(pending);

    expect(monitor.tickCalls).toEqual([{ nowMs: now, force: false }]);
  });
});
