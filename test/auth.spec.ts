import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";

const validToken = "valid-admin-token-123456789";

describe("isAuthorized", () => {
  it("rejects missing and malformed bearer headers", async () => {
    expect(await isAuthorized(new Request("https://worker.test/api/status"), "secret")).toBe(false);
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Basic secret" }
    }), "secret")).toBe(false);
  });

  it("accepts only the exact bearer token", async () => {
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer " + validToken }
    }), validToken)).toBe(true);
    expect(await isAuthorized(new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer " + validToken.toUpperCase() }
    }), validToken)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["blank", "                        "],
    ["short", "short-secret"],
    ["leading whitespace", " " + validToken],
    ["trailing whitespace", validToken + " "]
  ])("fails closed when the configured admin token is %s", async (_name, configured) => {
    const request = new Request("https://worker.test/api/status", {
      headers: { Authorization: "Bearer " + String(configured) }
    });

    expect(await isAuthorized(request, configured as string)).toBe(false);
  });
});
