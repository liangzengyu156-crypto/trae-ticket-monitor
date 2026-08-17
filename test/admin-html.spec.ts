import { describe, expect, it } from "vitest";
import * as adminHtml from "../src/admin-html";
import type { SlotStatusView } from "../src/types";

const { activeFutureSlots, createSessionGate, renderAdminPage } = adminHtml;
const { applyIfCurrent, healthPresentation } = adminHtml as unknown as {
  applyIfCurrent: (
    gate: ReturnType<typeof createSessionGate>,
    version: number,
    sideEffect: () => void
  ) => boolean;
  healthPresentation: (
    health: {
      consecutiveSourceFailures: number;
      lastSuccessAt: string | null;
      lastErrorAt: string | null;
      lastErrorSummary: string | null;
    },
    formatTime: (value: string | null) => string
  ) => { state: string; summary: string; healthSummary: string; lastError: string };
};

const now = "2026-08-20T03:56:00.000Z";

function slot(overrides: Partial<SlotStatusView>): SlotStatusView {
  return {
    code: "D1-1200",
    active: true,
    watched: false,
    observedState: "unknown",
    startsAt: "2026-08-21T04:00:00.000Z",
    endsAt: "2026-08-21T06:00:00.000Z",
    displayTime: "12:00-14:00",
    remaining: null,
    lastCheckedAt: null,
    ...overrides
  };
}

describe("admin page helpers", () => {
  it("selects only active catalog slots that have not started", () => {
    const selected = activeFutureSlots([
      slot({ code: "active-future" }),
      slot({ code: "inactive-future", active: false }),
      slot({ code: "active-past", startsAt: "2026-08-20T02:00:00.000Z" })
    ], now);

    expect(selected.map((item) => item.code)).toEqual(["active-future"]);
  });

  it("invalidates an in-flight response when a newer session begins", () => {
    const gate = createSessionGate();
    const inFlight = gate.begin();
    const afterLogout = gate.begin();

    expect(gate.isCurrent(inFlight)).toBe(false);
    expect(gate.isCurrent(afterLogout)).toBe(true);
  });

  it("does not apply a stale unauthorized reset after a replacement session begins", () => {
    expect(typeof applyIfCurrent).toBe("function");
    const gate = createSessionGate();
    const oldVersion = gate.begin();
    const currentVersion = gate.begin();
    let resetCalls = 0;

    expect(applyIfCurrent(gate, oldVersion, () => { resetCalls += 1; })).toBe(false);
    expect(resetCalls).toBe(0);
    expect(applyIfCurrent(gate, currentVersion, () => { resetCalls += 1; })).toBe(true);
    expect(resetCalls).toBe(1);
  });

  it("keeps source health presentation separate from action outcomes", () => {
    expect(typeof healthPresentation).toBe("function");
    const presentation = healthPresentation({
      consecutiveSourceFailures: 2,
      lastSuccessAt: "2026-08-20T03:56:00.000Z",
      lastErrorAt: "2026-08-20T03:57:00.000Z",
      lastErrorSummary: "source unavailable"
    }, (value) => value ? "formatted:" + value : "暂无");

    expect(presentation).toEqual({
      state: "error",
      summary: "上次成功：formatted:2026-08-20T03:56:00.000Z",
      healthSummary: "数据源状态：连续失败 2 次",
      lastError: "最近错误：source unavailable"
    });
  });

  it("renders browser helpers as literal script instead of serializing bundled functions", () => {
    const page = renderAdminPage();

    expect(page).toContain("function activeFutureSlots(");
    expect(page).toContain("function createSessionGate(");
    expect(page).toContain("function healthPresentation(");
    expect(page).not.toContain(".toString()");
    expect(page).toContain('id="action-feedback"');
    expect(page).toContain("function setActionFeedback");
  });

  it("does not invite password-manager persistence for the admin token", () => {
    expect(renderAdminPage()).toContain('id="admin-token" name="admin-token" type="password" autocomplete="off"');
  });
});
