import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token-123456789",
          BARK_DEVICE_KEY: "test-bark-key-123456789012"
        },
        serviceBindings: {
          SCRIPT_EVALUATOR: "script-evaluator"
        },
        workers: [{
          name: "script-evaluator",
          unsafeEvalBinding: "UNSAFE_EVAL",
          modules: [{
            type: "ESModule",
            path: "script-evaluator.mjs",
            contents: `
              const createElement = () => {
                const listeners = new Map();
                return {
                  listeners,
                  addEventListener(type, listener) { listeners.set(type, listener); },
                  append() {}, checked: false, className: "", dataset: {}, disabled: false,
                  focus() {}, name: "", replaceChildren() {}, textContent: "", type: "", value: ""
                };
              };
              export default {
                async fetch(request, env) {
                  const isScenario = request.headers.get("Content-Type") === "application/json";
                  const input = isScenario
                    ? await request.json()
                    : { script: await request.text(), scenario: "initialize" };
                  const elements = new Map();
                  globalThis.document = {
                    createElement,
                    getElementById(id) {
                      if (!elements.has(id)) elements.set(id, createElement());
                      return elements.get(id);
                    },
                    querySelectorAll() { return []; }
                  };
                  const values = new Map();
                  globalThis.sessionStorage = {
                    getItem(key) { return values.get(key) ?? null; },
                    removeItem(key) { values.delete(key); },
                    setItem(key, value) { values.set(key, value); }
                  };
                  const originalFetch = globalThis.fetch;
                  const originalConfirm = globalThis.confirm;
                  const fetchPaths = [];
                  const confirmCalls = [];
                  globalThis.confirm = (message) => {
                    confirmCalls.push(message);
                    return input.scenario !== "critical-cancel";
                  };
                  globalThis.fetch = async (request) => {
                    fetchPaths.push(new URL(typeof request === "string" ? request : request.url, "https://worker.test").pathname);
                    return input.scenario === "login-failure"
                      ? Response.json({ error: "暂时无法读取状态" }, { status: 500 })
                      : input.scenario === "login-unauthorized"
                        ? Response.json({ error: "unauthorized" }, { status: 401 })
                        : Response.json({
                          now: "2026-08-20T03:56:00.000Z",
                          watchedCodes: [],
                          slots: [],
                          health: {
                            consecutiveSourceFailures: 2,
                            lastSuccessAt: "2026-08-20T03:55:00.000Z",
                            lastErrorAt: "2026-08-20T03:56:00.000Z",
                            lastErrorSummary: "source unavailable"
                          }
                        });
                  };
                  try {
                    env.UNSAFE_EVAL.eval(input.script, "admin-inline.js");
                    if (input.scenario === "initialize") {
                      return new Response(null, { status: 204 });
                    }

                    const tokenInput = elements.get("admin-token");
                    tokenInput.value = "test-admin-token-123456789";
                    await elements.get("login-form").listeners.get("submit")({ preventDefault() {} });
                    if (input.scenario === "login-failure") {
                      return Response.json({
                        tokenError: elements.get("token-error").textContent,
                        actionFeedback: elements.get("action-feedback").textContent
                      });
                    }
                    if (input.scenario === "login-unauthorized") {
                      return Response.json({
                        statusSummary: elements.get("status-summary").textContent,
                        healthSummary: elements.get("health-summary").textContent,
                        lastError: elements.get("last-error").textContent,
                        tokenError: elements.get("token-error").textContent,
                        actionFeedback: elements.get("action-feedback").textContent
                      });
                    }

                    if (input.scenario === "notification-tests") {
                      fetchPaths.length = 0;
                      await elements.get("copy-test-button").listeners.get("click")();
                      await elements.get("critical-test-button").listeners.get("click")();
                      return Response.json({
                        fetchPaths,
                        confirmCalls,
                        actionFeedback: elements.get("action-feedback").textContent
                      });
                    }
                    if (input.scenario === "critical-cancel") {
                      fetchPaths.length = 0;
                      await elements.get("critical-test-button").listeners.get("click")();
                      return Response.json({ fetchPaths, confirmCalls });
                    }

                    const tokenAfterLogin = tokenInput.value;
                    const storedAfterLogin = values.get("trae-admin-token") ?? null;
                    await elements.get("logout-button").listeners.get("click")();
                    return Response.json({
                      tokenAfterLogin,
                      storedAfterLogin,
                      statusAfterLogout: elements.get("status-summary").textContent,
                      healthAfterLogout: elements.get("health-summary").textContent,
                      lastErrorAfterLogout: elements.get("last-error").textContent,
                      tokenErrorAfterLogout: elements.get("token-error").textContent,
                      actionAfterLogout: elements.get("action-feedback").textContent
                    });
                  } catch (error) {
                    return new Response(error instanceof Error ? error.stack : String(error), { status: 500 });
                  } finally {
                    globalThis.fetch = originalFetch;
                    globalThis.confirm = originalConfirm;
                    delete globalThis.document;
                    delete globalThis.sessionStorage;
                  }
                }
              };
            `
          }]
        }]
      }
    })
  ]
});
