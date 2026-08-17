# TRAE ticket monitor

This Cloudflare Worker reads the public TRAE activity time-slot feed and sends Bark notifications when a watched slot is initially available or changes from sold out to available. It is strictly a monitor-and-notify tool: it never holds a place, books a slot, submits an order, or bypasses login, queues, CAPTCHAs, or other safeguards. Every booking remains a manual action in WeChat.

## Local verification

Install the locked development dependencies and run the automated checks:

```bash
npm install
npm test
npm run typecheck
npx wrangler deploy --dry-run --outdir dist
```

The dry run writes the generated bundle to the ignored `dist/` directory; it does not deploy anything. `npm run verify` runs type checking, the complete mocked test suite, and the same dry-run bundle. Tests mock both the TRAE source and Bark, so they do not contact either real service.

For the production-source secret check, run:

```bash
npm run check:secrets
```

The secret scan is expected to exit with status 1 because no match should exist in the production files. Test-only configuration and fixtures stay outside this production scan.

## Deploy and configure secrets

Log in, enter each secret only at Wrangler's interactive prompt, and deploy:

```bash
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put BARK_DEVICE_KEY
npm run deploy
```

Generate a new random `ADMIN_TOKEN` of at least 24 characters. Do not reuse an account password. Copy `BARK_DEVICE_KEY` from the personal push URL shown in the Bark app, and paste only the key at the secret prompt. Do not place either value in source files, command-line assignments, Wrangler configuration, logs, or screenshots.

The Worker deploy includes a one-minute Cron Trigger, a single `MONITOR` Durable Object binding, and SQLite-backed Durable Object storage. Cloudflare Secrets supply credentials at runtime; neither secret belongs in the dry-run bundle.

## Verify on iPhone

1. In iPhone Settings, open Bark notification settings and allow notifications, sounds, and Critical Alerts. Also verify the TRAE monitor group is not muted inside Bark.
2. Open the deployed `workers.dev` URL in iPhone Safari and enter `ADMIN_TOKEN`.
3. Confirm the default watched slots are `D1-1200` and `D1-1400`.
4. Run exactly one immediate check and verify that both default slot states appear.
5. Send exactly one Bark test notification. It remains an ordinary notification and does not exercise the 30-second critical ringtone.
6. Tap the notification and confirm that `weixin://` opens WeChat. Then open Recently Used and select `TRAE AI创造力大赛` manually.

WeChat does not expose a supported link for opening the user's most recently used Mini Program. Opening a specified third-party Mini Program requires that Mini Program's AppID, a published page path, and owner-side WeChat Platform configuration; this project does not own or configure the TRAE Mini Program.

## After the activity and cleanup

Once no watched future slot remains, leaving the Worker deployed produces no TRAE source traffic. To reuse the monitor, open the page and select future active slots.

To remove it, delete the Worker and both secrets in the Cloudflare dashboard. If a temporary Stream CA certificate was installed during earlier traffic inspection and was not already cleaned up, remove or untrust it on the device as well.

## Primary documentation

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Bark push API v2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)
