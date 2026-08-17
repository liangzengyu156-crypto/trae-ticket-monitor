# Bark Critical Availability Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the availability push with the approved concise Chinese copy and make only real availability alerts use Bark critical notification, maximum volume, and a 30-second repeating ringtone.

**Architecture:** Extend the persisted `NotificationIntent` snapshot with optional Bark delivery controls, set them only in the availability transition, and serialize them at the Bark HTTP boundary. Keep test, source-failure, and recovery intents ordinary; preserve existing transition deduplication, immutable retry snapshots, and `weixin://` behavior.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Bark API v2, Vitest, Wrangler.

## Global Constraints

- The tool remains monitor-and-notify only; it must never book, hold, submit, or bypass login, queues, CAPTCHAs, or other safeguards.
- Availability title is exactly `🚨 TRAE 放票：{时段}`.
- Availability body is exactly `剩余 {数量} 个名额｜{日期} {检测时间} 检测到。立即打开微信 → 最近使用 → TRAE AI创造力大赛`.
- `{日期}` uses `M月D日` and `{检测时间}` uses `HH:mm:ss`, both in `Asia/Shanghai`.
- Only availability notifications carry `level: "critical"`, `call: "1"`, and `volume: "10"`.
- Availability notifications retain `sound: "alarm"`, `group: "trae-ticket-monitor"`, and `url: "weixin://"`.
- Test, source-failure, and recovery notifications must omit `level`, `call`, and `volume`.
- Do not add an editable notification UI, a strong-alert test button, or an unowned WeChat Mini Program URL Scheme.
- Do not add dependencies or place credentials in source, tests, docs, commands, logs, screenshots, or Git history.

## File Map

- Modify `src/types.ts`: define optional Bark delivery controls on `NotificationIntent`.
- Modify `src/transitions.ts`: construct the fixed availability copy and critical-only fields; leave health intents ordinary.
- Modify `src/clients.ts`: serialize optional Bark delivery controls.
- Modify `test/transitions.spec.ts`: protect exact copy, Shanghai formatting, critical-only behavior, immutable retry, and deduplication.
- Modify `test/clients.spec.ts`: protect the critical Bark JSON payload and ordinary-payload omission.
- Modify `test/monitor-service.spec.ts`: prove the test notification remains ordinary.
- Modify `README.md`: document iPhone critical-notification setup and the supported WeChat handoff.

---

### Task 1: Availability intent copy and critical-only model

**Files:**
- Modify: `src/types.ts:55-62`
- Modify: `src/transitions.ts:13-44`
- Test: `test/transitions.spec.ts:25-120`
- Test: `test/monitor-service.spec.ts:50-75`

**Interfaces:**
- Consumes: existing `NotificationIntent`, `SlotState`, `applyCatalogSuccess(...)`, and `listPendingNotifications(...)`.
- Produces: `NotificationIntent` with optional `level`, `call`, and `volume` fields; availability intents populate all three while ordinary intents omit them.

- [ ] **Step 1: Change the availability expectation first**

Replace the full intent expectation in `test/transitions.spec.ts` with the approved literal:

```ts
expect(intent).toEqual({
  id: "slot:D1-1200",
  title: "🚨 TRAE 放票：12:00-14:00",
  body: "剩余 2 个名额｜8月21日 13:00:00 检测到。立即打开微信 → 最近使用 → TRAE AI创造力大赛",
  group: "trae-ticket-monitor",
  sound: "alarm",
  url: "weixin://",
  level: "critical",
  call: "1",
  volume: "10"
});
```

Add ordinary-intent assertions to the health transition test after the third failed round:

```ts
const failure = listPendingNotifications(record).find((item) => item.id === "health:failure");
expect(failure).toBeDefined();
expect(failure).not.toHaveProperty("level");
expect(failure).not.toHaveProperty("call");
expect(failure).not.toHaveProperty("volume");
```

Extend the recovery-path test after `markNotificationDelivered(record, "health:failure", 3)` and `applyCatalogSuccess(...)` so it also inspects the queued recovery intent:

```ts
const recovery = listPendingNotifications(record).find((item) => item.id === "health:recovery");
expect(recovery).toBeDefined();
expect(recovery).not.toHaveProperty("level");
expect(recovery).not.toHaveProperty("call");
expect(recovery).not.toHaveProperty("volume");
```

Add the same three negative assertions to the existing repeated-test-notification test in `test/monitor-service.spec.ts` for every captured intent:

```ts
for (const intent of pushed) {
  expect(intent).not.toHaveProperty("level");
  expect(intent).not.toHaveProperty("call");
  expect(intent).not.toHaveProperty("volume");
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- test/transitions.spec.ts test/monitor-service.spec.ts
```

Expected: FAIL because the availability title/body remain the old wording and the critical fields do not exist. The ordinary-intent assertions may already pass; the availability literal must fail for the intended reason.

- [ ] **Step 3: Extend the notification type**

Update `NotificationIntent` in `src/types.ts`:

```ts
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
```

- [ ] **Step 4: Add focused Shanghai display helpers**

Keep the existing full Shanghai formatter for other copy and add these helpers directly below it in `src/transitions.ts`:

```ts
function shanghaiMonthDay(value: string): string {
  const date = shanghaiDateTime(value).slice(0, 10);
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function shanghaiClock(value: string): string {
  return shanghaiDateTime(value).slice(11);
}
```

- [ ] **Step 5: Implement the fixed availability intent**

Replace the returned object in `availabilityIntent(...)` with:

```ts
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
```

Do not add these fields to the test, failure, or recovery constructors.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- test/transitions.spec.ts test/monitor-service.spec.ts
```

Expected: both test files PASS. Confirm the existing immutable-retry and continuous-availability tests still pass without changing their behavioral assertions.

- [ ] **Step 7: Commit the independently testable intent change**

```bash
git add src/types.ts src/transitions.ts test/transitions.spec.ts test/monitor-service.spec.ts
git commit -m "Add critical TRAE availability alerts"
```

### Task 2: Bark critical-field serialization

**Files:**
- Modify: `src/clients.ts:35-69`
- Test: `test/clients.spec.ts:122-186`

**Interfaces:**
- Consumes: the optional `NotificationIntent.level`, `.call`, and `.volume` produced by Task 1.
- Produces: the same optional fields in the JSON body sent by `sendBark(...)`; ordinary requests omit them through JSON serialization.

- [ ] **Step 1: Add a failing critical-payload test**

Add this case inside `describe("sendBark", ...)` in `test/clients.spec.ts`:

```ts
it("posts critical delivery controls for an availability intent", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  const criticalIntent: NotificationIntent = {
    ...intent,
    level: "critical",
    call: "1",
    volume: "10"
  };

  await sendBark(fetcher as typeof fetch, "device-secret", criticalIntent);

  const request = fetcher.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body))).toEqual({
    device_key: "device-secret",
    title: "票务提醒",
    body: "D1-1200 有余票",
    group: "trae-ticket-monitor",
    sound: "alarm",
    url: "weixin://",
    level: "critical",
    call: "1",
    volume: "10"
  });
});
```

Strengthen the existing ordinary `posts the complete Bark payload` test by retaining its exact JSON equality without the three new keys. That literal proves ordinary intents omit the strong controls.

- [ ] **Step 2: Run the client test and verify RED**

Run:

```bash
npm test -- test/clients.spec.ts
```

Expected: FAIL because `sendBark(...)` currently drops `level`, `call`, and `volume`.

- [ ] **Step 3: Serialize optional delivery controls**

Extend the JSON object in `src/clients.ts`:

```ts
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
```

Do not add defaults. `JSON.stringify` must omit `undefined` keys for ordinary intents.

- [ ] **Step 4: Run the client test and verify GREEN**

Run:

```bash
npm test -- test/clients.spec.ts
```

Expected: PASS, including timeout, redirect rejection, secret redaction, critical payload, and ordinary payload cases.

- [ ] **Step 5: Commit the HTTP boundary change**

```bash
git add src/clients.ts test/clients.spec.ts
git commit -m "Send Bark critical delivery controls"
```

### Task 3: User guidance, full verification, deployment, and sync

**Files:**
- Modify: `README.md:41-55`
- Verify: `src/**`, `test/**`, `wrangler.jsonc`, generated dry-run bundle

**Interfaces:**
- Consumes: the critical availability payload completed in Tasks 1 and 2.
- Produces: explicit iPhone setup instructions, fresh full-suite evidence, a deployed Worker version, and a synchronized GitHub `main` branch.

- [ ] **Step 1: Document iPhone critical-alert setup and the WeChat boundary**

Replace the existing iPhone verification section with instructions that state all of the following:

```markdown
## Verify on iPhone

1. In iPhone Settings, open Bark notification settings and allow notifications, sounds, and Critical Alerts. Also verify the TRAE monitor group is not muted inside Bark.
2. Open the deployed `workers.dev` URL in iPhone Safari and enter `ADMIN_TOKEN`.
3. Confirm the default watched slots are `D1-1200` and `D1-1400`.
4. Run exactly one immediate check and verify that both default slot states appear.
5. Send exactly one Bark test notification. It remains an ordinary notification and does not exercise the 30-second critical ringtone.
6. Tap the notification and confirm that `weixin://` opens WeChat. Then open Recently Used and select `TRAE AI创造力大赛` manually.

WeChat does not expose a supported link for opening the user's most recently used Mini Program. Opening a specified third-party Mini Program requires that Mini Program's AppID, a published page path, and owner-side WeChat Platform configuration; this project does not own or configure the TRAE Mini Program.
```

- [ ] **Step 2: Run the fresh full verification gate**

Run:

```bash
npm run verify
```

Expected: type checking succeeds, every Vitest file passes with zero failures, and Wrangler dry-run exits successfully.

- [ ] **Step 3: Run the expected-negative production secret scan**

Run:

```bash
npm run check:secrets
```

Expected: exit status `1` with no matches. Any matched credential-like assignment is a release blocker; do not deploy until removed and the scan again exits `1` with empty output.

- [ ] **Step 4: Inspect the final scope before release**

Run:

```bash
git status --short --branch
git diff HEAD -- README.md src/types.ts src/transitions.ts src/clients.ts test/transitions.spec.ts test/monitor-service.spec.ts test/clients.spec.ts
```

Expected: only approved notification implementation, tests, and README changes are present. Do not stage unrelated files.

- [ ] **Step 5: Commit documentation if it changed after Task 2**

```bash
git add README.md
git commit -m "Document Bark critical alert setup"
```

- [ ] **Step 6: Deploy the verified Worker**

```bash
npx wrangler deploy
```

Expected: deployment prints the existing `trae-ticket-monitor.trae-ticket-monitor.workers.dev` URL, the one-minute schedule, and a new version ID. Do not alter or re-enter either Cloudflare secret.

- [ ] **Step 7: Verify the ordinary live test path manually**

Open the deployed admin page, log in with the existing `ADMIN_TOKEN`, run one immediate check, and send one test notification. Confirm the check succeeds, the test notification arrives once, and tapping it opens WeChat without a 30-second critical ringtone.

Do not force a real critical alert through production by falsifying availability or selecting an unrelated available slot. The exact critical payload is proven by automated tests.

- [ ] **Step 8: Push the reviewed commits to the personal repository**

```bash
git push origin main
```

Expected: the remote `main` branch advances to the local verified commit. Confirm the remote remains `liangzengyu156-crypto/trae-ticket-monitor` and no company remote is configured.
