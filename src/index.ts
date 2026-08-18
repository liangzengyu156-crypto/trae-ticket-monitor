import { isAuthorized } from "./auth";
import { renderAdminPage } from "./admin-html";
import { Monitor } from "./monitor-do";
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

function isWatchedCodeConfig(value: unknown): value is { watchedCodes: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const watchedCodes = (value as { watchedCodes?: unknown }).watchedCodes;
  return Array.isArray(watchedCodes)
    && watchedCodes.every((code) => typeof code === "string")
    && new Set(watchedCodes).size === watchedCodes.length;
}

async function readConfig(request: Request): Promise<string[] | null> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;

  try {
    const value: unknown = await request.json();
    return isWatchedCodeConfig(value) ? value.watchedCodes : null;
  } catch {
    return null;
  }
}

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderAdminPage(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!await isAuthorized(request, env.ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return json(await getMonitor(env).getStatus(Date.now()));
    }

    if (request.method === "PUT" && url.pathname === "/api/config") {
      const watchedCodes = await readConfig(request);
      if (watchedCodes === null) return json({ error: "invalid configuration" }, 400);
      const result = await getMonitor(env).setConfig(watchedCodes, Date.now());
      return result.ok
        ? json(result.status)
        : json({ error: result.error }, 400);
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      return json(await getMonitor(env).tick(Date.now(), true));
    }

    if (request.method === "POST" && url.pathname === "/api/test-notification") {
      await getMonitor(env).testCopyNotification();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/test-critical-notification") {
      await getMonitor(env).testCriticalNotification();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch {
    return json({ error: "internal error" }, 500);
  }
}

export default {
  fetch(request, env) {
    return routeRequest(request, env);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getMonitor(env).tick(controller.scheduledTime, false));
  }
} satisfies ExportedHandler<Env>;
