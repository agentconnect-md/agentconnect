# Vendored iLink SDK

Source: https://github.com/lc-cn/onebots (MIT)
Upstream path: `adapters/adapter-wechat-clawbot/src/sdk/` + `src/context-token-store.ts`
Vendored at commit: 2264929 (feat: 新增抖音适配器 (#265), 2026-10-09)
Vendored on: 2026-10-09

## What changed vs upstream

- `sdk/*` copied verbatim EXCEPT `*.spec.ts` (left upstream) and bare `"onebots"`
  imports rewritten to `../onebots/index.js` (or `../../onebots/index.js` under `internal/`).
- `onebots/*`: four files vendored from `packages/core/src/` — `errors.ts`,
  `media-source.ts`, `package-metadata.ts`, `recent-event-deduplicator.ts` —
  re-exported through `onebots/index.ts`. The real `onebots` npm package drags a
  full gateway (react/ink/nodemailer); these four are all the SDK touches.
- `context-token-store.ts`: kept the `ClawbotContextTokenStore` interface and
  table-name constant; dropped `ensureWechatClawbotContextTokenTable` which bound
  a onebots `SqliteDB` (AgentConnect provides its own store implementation).

## Upstream tracking

onebots ships frequently (multiple releases/week). The wechat adapter tracks the
official Tencent plugin (`@tencent-weixin/openclaw-weixin`) — check its releases
when iLink protocol bumps land, then resync this directory.

## Local strictness patches (daemon tsconfig is stricter than upstream's)

- `sdk/internal/config.ts`: `match.map(Number)` destructure given defaults (`= 0`).
- `sdk/internal/mime-table.ts`: `split(";")[0]` given `?? ""` fallback.
- `onebots/package-metadata.ts`: catch variable narrowed to `Error` for `cause`.
