# Integration Plugin Architecture — S0 Branch Audit

> **Status:** Complete (S0 of the staging plan in
> [integration-plugin-architecture.md](integration-plugin-architecture.md) §13).
>
> **Method:** five parallel full-read sweeps — daemon shared/core files (the four
> `daemon/src/<platform>/` directories are excluded as whole-module transport code),
> relay, control-plane (+ `prisma/schema.prisma`), web, and protocol + message
> (as a wire-shape inventory). Grep patterns covered `===`/`!==` with any variable
> name, reversed literal-first comparisons, `switch`/`case`, `.includes(` over
> platform arrays, inline platform arrays, session-key prefixes, platform-keyed
> map/object literals, ternaries and `&&`/`||` chains, `z.literal`/`z.enum`
> discriminants, and platform-keyed Prisma queries — plus full-file reads of every
> hot spot, which is what surfaced the branch shapes no grep finds (§6).
> Every row in the appendices carries a `file:line` that was read in context.

## 1. Summary

799 classified rows across the six packages. Under the D2 four-way taxonomy
(the protocol appendix additionally labels wire shapes, counted separately):

| host                               | (a) transport | (b) manifest capability | (c) adapter strategy | (d) core special case |   total |
| ---------------------------------- | ------------: | ----------------------: | -------------------: | --------------------: | ------: |
| daemon (shared files)              |            30 |                      48 |                   74 |                    46 |     198 |
| relay                              |            69 |                      28 |                    7 |                    10 |     114 |
| control-plane                      |            26 |                      91 |                   75 |                    47 |     239 |
| web                                |             7 |                      41 |                   86 |                    21 |     155 |
| protocol+message (shared branches) |            11 |                       5 |                    2 |                     2 |      20 |
| **D2 subtotal**                    |       **143** |                 **213** |              **244** |               **126** | **726** |

Protocol wire-shape inventory (not D2 branches): 23 `wire-enum` rows (closed
enums/unions to open in S1b), 18 `wire-variant` rows (platform-typed frame
variants to become opaque envelopes), 26 `wire-field` rows (named per-platform
fields to fold into generic coords / `adapterExt`), 5 `module-file` rows
(pure per-platform normalizers in `packages/message`), 1 platform-free shared
helper. Grand total: **799**.

Calibration against the design's §3 estimates: the `===`-only pattern's "69
lines in `daemon.ts`" and "~100 with negations" both undercount once the full
shape list is applied — `daemon.ts` alone yields **149** classified rows, and
the shared-daemon total is 198. The extra rows come from the branch shapes
grep cannot see (§6), which is precisely why S0 mandated a wider sweep.

`narrowPlatform` (§6.3): 1 definition (`daemon.ts:7597`) + 13 call sites
across `daemon.ts` (+ `cp/cp-collab-routes.ts` doc references) — 17 textual
sites total, matching the design's "~12 call sites" estimate once comments are
excluded.

## 2. Derived manifest field list (checks design §5)

Every §5 field is confirmed by at least one core pre-dispatch read; no §5
field turned out to be unused. Evidence highlights (full rows in appendices):

| §5 field                   | strongest core reads                                                                                                  | verdict                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id` / `displayName`       | every host; web `platName()` (data.ts:1892), CP sessions.ts:385 labels                                                | confirmed                                                                                    |
| `regions`                  | 11 web rows + CP region maps ×3 (`REGION_ORIGIN`/`REGION_BASE`)                                                       | confirmed — **add `apiBaseUrl` per region** (CP holds three copies of the region→origin map) |
| `ingress`                  | relay-ingress-manager.ts:365; CP integrations.ts:393; web transport picker                                            | confirmed                                                                                    |
| `threading`                | bot-arbitration.ts:83 (session key assumes per-message); daemon.ts:9052                                               | confirmed                                                                                    |
| `topLevelReplies`          | relay-ingress-manager.ts:779; daemon Slack top-level paths                                                            | confirmed (thinnest direct evidence)                                                         |
| `mentionIdPattern`         | daemon.ts:6765 / 6829 (Slack member-id rejection)                                                                     | confirmed                                                                                    |
| `botSenderRouting`         | bot-arbitration.ts:126; relay-ingress-manager.ts:599; daemon.ts:5378/5382; routing-table.ts:90; github-ingress.ts:240 | confirmed                                                                                    |
| `persistsPlacements`       | the three `coordsDecision` lists (collaboration-router.ts:69, cp-collab-routes.ts:41, relay-daemon.ts:437-450)        | confirmed                                                                                    |
| `credentialShape`          | CP dto 773/781; httpBot.ts:134/139; relay 351/369; relay index.ts:46                                                  | confirmed                                                                                    |
| `identityScope`            | relay demux 376/382/518; CP tenant fences; feishu-session-access.ts:119 (`'app'`)                                     | confirmed                                                                                    |
| `multiAgentShareable`      | CP integrations.ts:124; daemon.ts:12862; web AddIntegrationModal:1321                                                 | confirmed                                                                                    |
| `membershipEnumeration`    | daemon.ts:3673/3727/4039/10187; httpBot.ts:398/456; integrations.ts:815                                               | confirmed                                                                                    |
| `leaveGranularity`         | daemon.ts:3825-3847; integrations.ts:1172/1179; IntegrationChannelList.tsx:207/666                                    | confirmed                                                                                    |
| `avatar.perMessageIconUrl` | agent-icon.ts:12/35; daemon.ts:12115                                                                                  | confirmed                                                                                    |

**New field candidates surfaced by the audit** (each needs a D2 call in review
— the dividing rule stays "core reads it before a dispatch target is
resolved"):

1. **`avatar.botProfilePush`** — Telegram/Discord/Feishu accept a pushed bot
   profile avatar; Slack does not (`http/agent-bot-icon-sync.ts:58`). Read at
   install/config time.
2. **`conversationKinds`** — "DM has no thread; group DM requires a mention;
   im/mpim taxonomy" is read pre-dispatch in three relay sites
   (relay-ingress-manager.ts:628/735/779) and encoded as Slack vocabulary on
   the wire (`normalized-message.ts:52 isGroupDm`, `integration.ts:224`).
   Alternative: fold into `threading`/`topLevelReplies`.
3. **`sessionAudience.privateBaseline`** — the Feishu p2p private-baseline
   exception is spelled three times (policy.ts:103, session-access.ts:125,
   session-access-sql.ts:51 / session.repo.ts:1250) and must become one
   declaration.
4. **`messageIdOrdering`** (`'lexical-ts' | 'snowflake' | 'opaque'`) — Slack
   timestamp ordering drives five session-manager sites plus the web
   transcript sort and conversation-merge identity; today it is implicit in
   `platform === 'slack'` checks.
5. **`channelIdSyntax`** (or a hashed A2A coordinate) — `a2aCoordChannel`'s
   collision-freedom rests on a comment-only invariant that no chat platform's
   channel ids contain `:` (collaboration-router.ts:75-79).
6. **`interactionAckMode`** (`'sync' | 'async'`) — optional; Feishu's 2.5 s
   card toast and Slack's `block_suggestion` both require a synchronous body
   on the HTTP 200. §8 already keeps the deadline in the plugin; this flag
   would only tell core the mode exists.
7. **`relayOwnsEgress`** — already anticipated by §8 (derived from the
   `egress` facet); confirmed at relay-ingress-manager.ts:665/769 and
   bot-arbitration.ts:320.

## 3. Derived strategy-function list (checks design §7.4)

All §7.4-named strategies are confirmed with concrete sites:
`threadKeyForPost` (normalized.ts:109-111, daemon.ts:7386/7417, mcp/ops.ts:870/921,
github-ingress.ts:756), `loopGuardScopes` (daemon.ts:845/849/9100/9112/9239),
`tenantScope` / `transportScopeIdentity` (daemon.ts:14678-14892),
`openThreadForTopLevel` (daemon.ts:5517/5555-5583), command chrome renderers
(daemon.ts:9226-9381), DM inference (daemon.ts:15078/15096).

**Additional strategy/facet candidates derived from the audit:**

- **daemon (Layer 2 / §7.3 neighbors):** `postIdentityOptions`
  (12115-12153), status-bar renderer (13130-13176), footer renderer
  (11246/11617/11785), title renderer (14156-14340), approval/elicitation
  surface (567, 13897-13961), `sessionLinkSource` (12822-12833, 13120,
  13176), streaming-edit turn state (the FeishuConverger cluster —
  confirms §7.3's opaque per-turn state slot).
- **daemon (other):** `replyAnchor` (5359), `spaceForChannel` /
  `collapseObservedChannels` (3782/3978/15153 — may become Layer-1 read-port
  methods), `cursorOrdering` (session-manager 937-1051 — pairs with the
  `messageIdOrdering` manifest candidate), `selfMentionId`
  (session-manager.ts:685).
- **relay:** `isThreadRoot` (bot-arbitration.ts:404-405), `decodeInteraction`
  (slack-http-ingest.ts:240), `sessionKeyFor(delivery)`
  (github-ingress.ts:642), `normalizeRetryAuthority` (hooks/ingress.ts:97),
  `lookupUserName` as a read-port method (relay-ingress-manager.ts:732).
- **CP provider facets beyond §9's list:** `identityReconciler` (the Slack
  bot-identity background loop + its platform-keyed repo query),
  `sessionAudienceResolver` registration, `viewerIdentityKeys` (identity
  tuple arity differs: Slack 3-part vs Feishu 4-part),
  `externalScopeRealmKey`, `consoleLinks` (portal deep-links).
- **web module facets beyond §10's list:** `messageIdentity`
  (conversation-merge.ts:92-118), `roomNoun`/`roomGlyph`, the onboarding
  fragment seam (Getting-Started's Slack-only rows), and a per-module mock
  seam (`MOCK_MODE` currently drives real wizard branches).

## 4. Design errata and verified claims

Confirmed exactly as written: zod strips unknown envelope keys
(`envelope.ts:12-19` + the `extractControlExt` workaround at `wire.ts:39-47`);
unknown frame _types_ are graceful (`wire.ts:75-83` → typed `UNKNOWN_FRAME`
REP); unknown enum _values_ inside a known frame are frame-fatal
(`wire.ts:84-92`); and a new platform id in `register.capabilities.platforms`
produces a fatal daemon reconnect loop (`register.ts:23` → `wire.ts:84` →
`connection.ts:59-68` → daemon `client.ts:301-328`). The M-5D down-level
precedent for the S1b `IntegrationSpec` shim is `codec.ts:41-58`.

Corrections to carry into S1 planning:

1. **§6.1 undercounts the inline enum copies.** `relay-daemon.ts` has exactly
   the four stated copies, but the package total is **six** literal copies
   (add `normalized-message.ts:37` and `relay-cp.ts:563`) plus two
   different-member near-copies (`cron.ts:20` four-value with
   `.default('slack')`; `route.ts:15` seven-value canonical).
2. **§6.4 names the wrong protocol type.** `AgentSpec`
   (`frames/agent.ts:255`) is a flat object with no platform discriminator.
   The duplicated closed union is `IntegrationSpec`
   (`frames/integration.ts:161`) ↔ daemon `IntegrationSchema`
   (`agents/agent-schema.ts:96`), with a third copy of the four-value enum at
   `agent-schema.ts:142`; `AgentSpec` couples only via
   `AgentActivate.integrations` (`agent.ts:434`).
3. **§6.8's `CronDef.targetPlatform` / `HookDef.targetPlatform` do not exist
   in the protocol package.** The protocol-side surface is the single
   `CronTarget.platform` (`cron.ts:20`) with three consumers
   (`relay-daemon.ts:321`, `relay-cp.ts:255`, cron itself); the
   `targetPlatform` name lives in CP DTOs/Prisma and `web/lib/api.ts:577/600`
   (typed narrower still: `'slack' | 'telegram'`). One protocol edit, three
   consumers — not two defs.
4. **§6.6 has a `.strict()` hazard.** `SharedSlackStatusTarget`
   (`relay-cp.ts:485-492`) is `.strict()`, so adding an opaque payload slot
   to it is a decode failure on an older relay, not a stripped key.
   `relay-cp.ts` holds 11 `.strict()` schemas (115 exist package-wide); none
   of the platform-carrying frames is strict, so the S1a premise holds where
   it matters — but every §6.6 envelope change must check this list first.

## 5. Defects found in passing (beyond §14's three)

- **`packages/web/src/components/console/views/SettingsView.tsx:216`** — the
  Feishu session-access error message reads "GitHub session access" (the
  ternary only distinguishes slack vs everything-else). One-line copy fix.
- **`packages/control-plane/src/http/mcp/tools.ts:202`** — the MCP
  `listSessions` platform enum omits `'feishu'` while the HTTP route's enum
  (`http/routes/sessions.ts:47`) includes it; MCP clients cannot filter
  Feishu sessions. One-line fix.
- **`packages/daemon/src/agents/write-cron.ts:30`** — a non-Slack cron target
  is silently degraded to headless on the daemon side; this is the daemon
  half of §14 defect #2's blast radius and must land with the §6.8 fix.
- **Seven web fold-to-`slack` sites** (api.ts:1763/1832,
  SessionDetailView:973/1101/1253, data.ts:1904, AddCronModal:79/141) — the
  web mirror of §14 defect #1; S1a's `narrowPlatform` deletion needs a web
  sweep too, or unknown platforms will _render_ as Slack after the daemon
  stops folding them.
- **Relay structural gaps for Feishu** — DM conversation rows land nameless
  (`relay-ingress-manager.ts:732` is a Slack-only map lookup) and Feishu bots
  silently fall out of the gated-notice path (`:769/:773`). Both are latent
  behavior differences that the S3 relay contract will surface; decide
  keep-or-fix explicitly then.
- **`daemon.ts:4039`** (`maybeIntroduceOnJoin` hardcodes `platform =
'slack'`) — probably a designed consequence of authoritative-membership
  being Slack-only, but undocumented; classify during S2 extraction.

## 6. Grep blind-spot checklist (mandatory for S1/S2 sweeps)

Branch shapes the `===`-style patterns do not find, each observed in this
audit. Any "zero platform conditionals remain" exit-criterion check must
include these:

1. **Type-narrowing as the branch** — `instanceof SlackConnection` /
   `TelegramConnection` / `DiscordConnection` / `FeishuConverger` (13 daemon
   sites), and structural casts after a platform test.
2. **Duck-typed capability probes** — `typeof conn?.getThreadReplies !==
'function'`, `typeof slack.setStatus === 'function'`,
   `conn?.workspaceId?.()`.
3. **Parallel-function and map-membership forks** — duplicated call sites
   (`resolveVerified`/`resolveFeishuVerified`), and "which map the bot lives
   in" acting as the platform test (relay `ingests` vs `feishuIngests`;
   daemon's four conn maps).
4. **Hardcoded literals with no comparison** — `?? 'slack'` defaults,
   `const platform = 'slack'`, `sessionLink(..., 'slack')`.
5. **Id-syntax assumptions** — `slackTsMicros`/`compareSlackTs` used
   unconditionally; `msgId.split(':')` grammar; `channel.startsWith('D')`;
   `/^A[A-Z0-9]+$/`, `/^T…/` regexes; UUID ⇒ webchat.
6. **Named per-platform fields on shared types** — `telegramTopicId`,
   `telegramThreadRoot`, `discordTopLevel`, `parentChannel`, `isGroupDm`.
7. **Per-platform identifiers in state** — `tgConnByIntegration`,
   `feishuStreamTimer`, `slackRetryTimers`, `staleReplyFooters`.
8. **String-content-only sites** — SQL literals (`platform <> 'dream'` in
   local-store.ts:2390; the CP `COALESCE(platform,'slack')` family), and one
   file that plain grep _silently skips_:
   `web/.../views/SessionDetailView.tsx` contains a NUL byte, so
   `grep -rn` returns nothing for it — **use `grep -a`** (it holds 9
   platform conditionals including all three `MessageText` call sites).
9. **Substring dispatch** — web `PlatformMark` / `platName` branch on
   `.includes('tele')` etc., order-sensitive.
10. **Closed unions in type positions** — `tsc` enforces them; grep never
    sees them (bot-arbitration.ts:22-23, web api.ts DTOs, CP
    daemon-platform-capability.ts:13).
11. **Optional-dependency presence as the branch** — CP `deps.ts` declares
    twelve per-platform slots; `if (deps.syncTelegramBotIcon)` is a platform
    branch with no literal.
12. **Route mounting by name** — CP `server.ts` and relay `index.ts` register
    per-platform route plugins; the "branch" is a 404 when absent.
13. **Constraint-level branching** — `@@unique([slackAppId, teamId])` _is_
    the `workspace_taken` fence; no TypeScript conditional expresses it.
14. **Template identity composition of differing arity** — `slack:<team>:<user>`
    (3-part) vs `feishu:<region>:<appId>:<openId>` (4-part).
15. **Comment-only invariants** — the msgId grammar (bot-arbitration.ts:403),
    the channel-id `:`-freedom invariant (collaboration-router.ts:75-77), and
    the deliberate platform-absence of `coordsKey`
    (collaboration-router.ts:42/191-205, coupled to `narrowPlatform` — must
    be re-derived when §6.3 lands, in lockstep with the byte-identical daemon
    twin `cp/cp-collab-routes.ts`).
16. **Web-only carriers** — CSS tokens/animations in `globals.css`, the
    `public/brands/lark.svg` asset, mock fixtures (`MOCK_MODE` drives real
    wizard branches), and gates duplicated across files ("keep the two in
    sync" comments).
17. **False positives to exclude** — `workspace.mode === 'github'` (git
    workspace axis, ≈40 CP hits + daemon write-agent/workspace-manager) and
    `'dream'` as a memory-write source / skill kind.

## 7. Classification calls needing a design decision

The per-host appendices flag every ambiguous row; these are the ones that
change a contract shape and should be settled before S1b/S2 (recommendations
inline):

1. **Thread-root detection (b vs c)** — pre-dispatch by timing, per-platform
   string surgery by nature (bot-arbitration.ts:404-405). Recommend the
   design's own hedge: an adapter-exported `isThreadRoot(msg)` predicate that
   core may call pre-dispatch (strategy, not flag).
2. **`transportScopeIdentity` / `tenantScope` dual use** — consumed both
   pre-dispatch (session keying) and post-dispatch (audience scoping).
   Recommend: stay §7.4 strategies; the manifest carries only `identityScope`.
3. **`iconUrl` / `showFooter` / `showStatusBar`** — wire-replicated settings
   whose effect is post-dispatch rendering. Recommend: stay wire fields;
   their _consumption_ moves behind the §7.3 renderer seam.
4. **`conversationKinds`** — new manifest facet vs folding into
   `threading`/`topLevelReplies`. Needs an explicit D2 call; three relay
   reads argue for the facet.
5. **GitHub ingress branches** — §7.6 removes only the _turn-output_ special
   case; the GitHub ingress/hook-message branches (daemon.ts:8008-8048,
   messages/hook-message.ts) remain core (d) permanently. Recommend stating
   this in the design so S2's "zero platform conditionals" criterion
   excludes them explicitly.
6. **`leaveGranularity` / `membershipEnumeration` already exist as wire
   data** (`integration.ts:247/266`). Decide: manifest read (core stops
   carrying them) or wire carry (manifest field is redundant). The wire flag
   currently serves mixed-version daemons; recommend manifest-with-wire-echo
   until the fleet gate, then drop the echo.
7. **Cron/hook `'slack'` defaults** — the `.default('slack')` on
   `CronTarget.platform` and the repo-level `?? 'slack'` are legacy envelope
   defaults, not capabilities; they belong to the §6.8 fix, not the manifest.

## 8. How to read the appendices

One appendix per sweep, in dependency order: daemon (A), relay (B),
control-plane (C), web (D), protocol + message wire inventory (E). Columns:
`file:line` (repo-relative within the named package), the predicate excerpt,
a ≤15-word behavior note, the D2 class, and the implied manifest field or
strategy/facet name. Counts per appendix are the agent-verified totals used
in §1.

---

## Appendix A — `packages/daemon/src` (shared/core files; per-platform dirs excluded)

### 1. Findings

Paths relative to `packages/daemon/src/`.

| file:line                             | predicate                                                                                          | what it does                                                 | class | implied manifest field / strategy fn                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- | ------------------------------------------------------- |
| daemon.ts:567                         | `turn.platform === 'slack' && !turn.webchat && !turn.headless`                                     | `none` mode suppresses approval card only on Slack           | c     | approvalSurface renderer (§7.4 chrome)                  |
| daemon.ts:790                         | `Exclude<NormalizedMessage['platform'], 'hook'>`                                                   | originCoords type excludes hook origin-kind                  | d     | —                                                       |
| daemon.ts:845                         | `` return `slack:${channel}:top-level` ``                                                          | mints Slack channel-wide loop-guard scope                    | c     | loopGuardScopes                                         |
| daemon.ts:849                         | `msg.platform === 'slack' && !msg.isDm`                                                            | Slack top-level roots share one channel circuit              | c     | loopGuardScopes                                         |
| daemon.ts:868                         | `msg.platform !== 'webchat'`                                                                       | webchat exempt from loop guard                               | d     | —                                                       |
| daemon.ts:876                         | `msg.platform === 'slack' && … sender.id === 'unknown'`                                            | detects Slack message_changed poison shape                   | a     | —                                                       |
| daemon.ts:1926                        | `switch (eff.platform) case 'slack'/'telegram'/'discord'`                                          | picks conn map for virtual eval integration                  | a     | §7.5 registry                                           |
| daemon.ts:2100                        | `platform: 'webchat'`                                                                              | eval webchat turn message                                    | d     | —                                                       |
| daemon.ts:2579                        | `req.platform === 'hook' ? 'slack' : req.platform`                                                 | hook coords rewritten to Slack for channelAgents             | d     | —                                                       |
| daemon.ts:2580                        | `coordPlatform === 'webchat' \|\| === 'dream'`                                                     | empty agent roster for non-persisted platforms               | d     | —                                                       |
| daemon.ts:2774                        | slack connect/consolidate/retry block (2765–2836)                                                  | per-platform connect + 3 background reconcile kicks          | a     | §7.5 registry                                           |
| daemon.ts:3317                        | slack runtime socket + HTTP send-only (3300–3406)                                                  | Slack-specific appToken reuse / shared-bot open              | a     | §7.5 registry; ingress                                  |
| daemon.ts:3441                        | telegram/discord/feishu reconcile loops (3441–3650)                                                | three near-duplicate connect/consolidate loops               | a     | §7.5 registry                                           |
| daemon.ts:3673                        | `row.platform !== 'discord' && !== 'telegram' && !== 'feishu'`                                     | backfill names only where no cheap enumeration               | b     | membershipEnumeration                                   |
| daemon.ts:3680                        | `row.platform === 'discord' ? dcConn… : tgConn… : fsConn…`                                         | selects conn map by platform                                 | a     | §7.5 registry                                           |
| daemon.ts:3727                        | `for (const platform of ['telegram','discord','feishu'] as const)`                                 | observed-channel rebuild for observed-only platforms         | b     | membershipEnumeration                                   |
| daemon.ts:3782                        | `platform === 'discord' ? this.spaceFor(c.id) : undefined`                                         | attaches Discord guild to retained channel rows              | c     | spaceForChannel (new)                                   |
| daemon.ts:3825                        | `conn instanceof DiscordConnection` + `target.kind !== 'space'`                                    | Discord leaves guild, not channel                            | b     | leaveGranularity                                        |
| daemon.ts:3841                        | `conn instanceof SlackConnection`                                                                  | Slack leaves channel then re-lists authoritatively           | b     | leaveGranularity + membershipEnumeration                |
| daemon.ts:3847                        | `conn instanceof TelegramConnection`                                                               | Telegram leave must retract row by id                        | b     | leaveGranularity                                        |
| daemon.ts:3931                        | `integration.platform !== 'telegram'`                                                              | Telegram chat-title snapshot update                          | a     | —                                                       |
| daemon.ts:3978                        | `if (platform !== 'discord') return observed`                                                      | collapses Discord thread rows onto parent channel            | c     | collapseObservedChannels (new)                          |
| daemon.ts:4039                        | `const platform = 'slack'`                                                                         | introduce-on-join hardcoded to Slack                         | b     | membershipEnumeration ('authoritative')                 |
| daemon.ts:4960                        | `platform: 'dream'` (also 4955, 4992, 5108, 5124, 5213)                                            | dream execution session rows/snapshots                       | d     | —                                                       |
| daemon.ts:5325                        | `msg.platform !== 'telegram' \|\| msg.thread !== undefined`                                        | Telegram inbound thread canonicalization ladder              | c     | threadKeyForPost (inbound twin)                         |
| daemon.ts:5359                        | `msg.platform !== 'telegram'`                                                                      | Telegram reply-anchor id derivation                          | c     | replyAnchor (new)                                       |
| daemon.ts:5378                        | `cpCollab.isAgentBotApp('slack', channel, appId)`                                                  | managed-bot identity lookup hardcodes slack key              | b     | botSenderRouting                                        |
| daemon.ts:5382                        | `msg.source !== 'user' \|\| msg.platform !== 'slack'`                                              | bot-authored suppression only on Slack                       | b     | botSenderRouting                                        |
| daemon.ts:5517                        | `msg.platform === 'discord' && msg.discordTopLevel`                                                | re-dispatches into a freshly opened thread                   | c     | openThreadForTopLevel                                   |
| daemon.ts:5563                        | `dispatchDiscordTopLevel` body (5555–5583)                                                         | createThread + re-key channel/thread, then dispatch          | c     | openThreadForTopLevel                                   |
| daemon.ts:5609                        | `{ platform: 'webchat', channel: chatId }`                                                         | synthetic routing message for webchat                        | d     | —                                                       |
| daemon.ts:5646                        | `platform: 'webchat'`                                                                              | webchat NormalizedMessage construction                       | d     | —                                                       |
| daemon.ts:5747                        | ``sessionKey('webchat', conversationId, `webchat:${conversationId}`…)``                            | webchat session-key template                                 | d     | —                                                       |
| daemon.ts:6212                        | `msg.source === 'hook'`                                                                            | hook relay frames take separate admission path               | d     | —                                                       |
| daemon.ts:6229                        | `msg.source === 'webchat'`                                                                         | webchat relay op branch                                      | d     | —                                                       |
| daemon.ts:6231                        | `'slack_action' ? … : 'feishu_action' ? …`                                                         | platform interaction frames dispatched per platform          | a     | §6.6 platform_action                                    |
| daemon.ts:6348                        | `candidate.platform === 'slack' && candidate.slack.mode === 'shared'`                              | shared-bot Slack action integration lookup                   | a     | —                                                       |
| daemon.ts:6372                        | `binding.platform === 'slack'`                                                                     | delivery-binding validation for Slack action                 | a     | —                                                       |
| daemon.ts:6387                        | `rec.platform !== 'slack'`                                                                         | rejects Slack action on non-Slack session                    | a     | —                                                       |
| daemon.ts:6394                        | `binding.platform !== 'slack'`                                                                     | Slack action binding mismatch drop                           | a     | —                                                       |
| daemon.ts:6449                        | `candidate.platform === 'feishu' && candidate.feishu.mode === 'shared'`                            | Feishu card-action integration lookup                        | a     | —                                                       |
| daemon.ts:6540                        | `cpCollab.coordsDecision(msg.orgId, platform, channel, …)`                                         | relay-path coordinate-integrity gate                         | b     | persistsPlacements                                      |
| daemon.ts:6575                        | `const narrowed = this.narrowPlatform(platform)`                                                   | child session key minting (relay agentmsg)                   | b     | — (§6.3: narrowPlatform dies)                           |
| daemon.ts:6749                        | `cpCollab.coordsDecision(callerOrg, req.platform, …)`                                              | same-daemon wake coordinate gate, RAW platform               | b     | persistsPlacements                                      |
| daemon.ts:6763                        | `narrowPlatform(req.platform)`                                                                     | wakeRejectionReason caller key                               | b     | — (§6.3)                                                |
| daemon.ts:6765                        | `platform === 'slack' && /^(?:[UW][A-Z0-9]+…)/`                                                    | rejects Slack member id as agent target                      | b     | mentionIdPattern                                        |
| daemon.ts:6782                        | `narrowPlatform(req.platform)`                                                                     | messageAgent caller key                                      | b     | — (§6.3)                                                |
| daemon.ts:6829                        | `platform === 'slack' && /^(?:[UW][A-Z0-9]+…)/`                                                    | same Slack-id guard on delivery path                         | b     | mentionIdPattern                                        |
| daemon.ts:6857                        | `platform === 'hook' ? 'slack' : platform`                                                         | originCoords platform for hook turns                         | d     | —                                                       |
| daemon.ts:6876                        | `resolveCpAgent(…, platform === 'hook' ? 'slack' : platform)`                                      | integration resolution for hook-origin wake                  | d     | —                                                       |
| daemon.ts:6918                        | `coordPlatform = platform === 'hook' ? 'slack' : platform`                                         | cross-daemon route coords for hook turns                     | d     | —                                                       |
| daemon.ts:7045                        | `narrowPlatform(req.platform)`                                                                     | replyToSession caller key                                    | b     | — (§6.3)                                                |
| daemon.ts:7078                        | `platform === 'hook' ? 'slack' : platform`                                                         | reply origin coords for hook turns                           | d     | —                                                       |
| daemon.ts:7108                        | `narrowPlatform(local.platform)`                                                                   | origin session platform → reply integration                  | b     | — (§6.3)                                                |
| daemon.ts:7207                        | `narrowPlatform(req.platform)`                                                                     | viewSessionStatus caller key                                 | b     | — (§6.3)                                                |
| daemon.ts:7386                        | `platform === req.targetPlatform && channel === …`                                                 | fork detection for root-post notice                          | c     | threadKeyForPost                                        |
| daemon.ts:7417                        | `platform === req.targetPlatform && channel === …`                                                 | cross-daemon parent fork detection                           | c     | threadKeyForPost                                        |
| daemon.ts:7454                        | `narrowPlatform(req.platform)`                                                                     | channel-root session spawn key                               | b     | — (§6.3)                                                |
| daemon.ts:7458                        | `narrowPlatform(req.originPlatform ?? req.platform)`                                               | origin session key on another platform                       | b     | — (§6.3)                                                |
| daemon.ts:7475                        | `originPlatform === 'hook' ? 'slack' : originPlatform`                                             | hook origin coords for spawned session                       | d     | —                                                       |
| daemon.ts:7537                        | `platform: Exclude<NormalizedMessage['platform'], 'hook'>`                                         | cross-daemon route ctx excludes hook                         | d     | —                                                       |
| daemon.ts:7597                        | `p === 'telegram' \|\| 'webchat' \|\| 'discord' \|\| 'feishu' \|\| 'hook' ? p : 'slack'`           | narrowPlatform: closed union fold, defaults slack            | b     | — (§6.3 delete)                                         |
| daemon.ts:7620                        | `narrowPlatform(req.platform)`                                                                     | orchestration main session key                               | b     | — (§6.3)                                                |
| daemon.ts:7777                        | `narrowPlatform(orch.platform)`                                                                    | orchestration deadline wake message                          | b     | — (§6.3)                                                |
| daemon.ts:7905                        | `narrowPlatform(req.platform)`                                                                     | orchestration owner check key                                | b     | — (§6.3)                                                |
| daemon.ts:8008                        | `c?.source === 'github' && c.action === 'deleted'`                                                 | skips fire when no session for deleted GH event              | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:8031                        | `c?.source === 'github' && msg.github?.subjectKind === 'pull_request'`                             | trusted inline GH review-comment target                      | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:8048                        | `c?.source === 'github' && c.repo && c.number !== undefined`                                       | derives githubReply target for the turn                      | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:8514                        | `op.user ?? 'webchat'`                                                                             | webchat turn default user id                                 | d     | —                                                       |
| daemon.ts:8622                        | `flushHeldWebchatText(wc)`                                                                         | webchat-only held-text release                               | d     | —                                                       |
| daemon.ts:8649                        | `contextPost.author.user ?? 'webchat'`                                                             | webchat context-post sender fallback                         | d     | —                                                       |
| daemon.ts:8858                        | `pending.platform !== 'slack'`                                                                     | final-fence thread snapshot only via Slack read port         | a     | Layer-1 read port (getThreadReplies)                    |
| daemon.ts:9052                        | `msg.platform === 'slack' ? msg.thread : undefined`                                                | thread only participates in Slack target lookup              | b     | threading                                               |
| daemon.ts:9100                        | `msg.platform !== 'slack' \|\| msg.isDm \|\| !isLoopGuardOpen(slackTopLevel…)`                     | top-level `!resume` recovery is Slack-only                   | c     | loopGuardScopes                                         |
| daemon.ts:9112                        | `integration.platform !== 'slack'`                                                                 | candidate filter for top-level resume                        | c     | loopGuardScopes                                         |
| daemon.ts:9226                        | `msg.platform === 'telegram'` → `postMessage(…{replyTo})`                                          | command reply uses Telegram reply threading                  | c     | command chrome renderer                                 |
| daemon.ts:9239                        | `msg.platform === 'slack' && !msg.isDm`                                                            | picks channel-wide vs per-thread resume scope                | c     | loopGuardScopes                                         |
| daemon.ts:9307                        | `msg.platform === 'telegram'`                                                                      | `/status` HTML chrome + View link                            | c     | command chrome renderer                                 |
| daemon.ts:9314                        | `msg.platform === 'discord'`                                                                       | `/status` markdown + link button                             | c     | command chrome renderer                                 |
| daemon.ts:9322                        | `msg.platform === 'feishu'`                                                                        | `/status` plain text + 🔗 line                               | c     | command chrome renderer                                 |
| daemon.ts:9372                        | `msg.platform === 'telegram' && conn`                                                              | select-card renderer (inline keyboard)                       | c     | command chrome renderer                                 |
| daemon.ts:9381                        | `msg.platform === 'discord' && conn`                                                               | select-card renderer (components, 25 ceiling)                | c     | command chrome renderer                                 |
| daemon.ts:9612                        | `integration.platform !== 'telegram'`                                                              | bare-Telegram-command session resolution                     | a     | —                                                       |
| daemon.ts:9634                        | `integration.platform !== 'slack'`                                                                 | Slack message-shortcut session resolution                    | a     | —                                                       |
| daemon.ts:9721                        | `ctx.platform === 'slack'`                                                                         | failure notice posts with Slack post options                 | c     | chrome renderer                                         |
| daemon.ts:10187                       | `msg.platform === 'slack' \|\| 'telegram' \|\| 'discord' \|\| 'feishu'`                            | records observed inbound for the 4 IM platforms              | b     | membershipEnumeration                                   |
| daemon.ts:10776                       | `msg.platform === 'telegram' ? TelegramConverger : discord ? … : feishu ? … : Output`              | picks Layer-2 renderer per platform                          | c     | §7.3 renderer seam                                      |
| daemon.ts:10891                       | `msg.platform === 'webchat'`                                                                       | webchat turns default to memory-excluded                     | d     | —                                                       |
| daemon.ts:11045                       | `msg.platform === 'telegram' \|\| 'discord' \|\| 'feishu'`                                         | first-seen chat widens observed set                          | b     | membershipEnumeration                                   |
| daemon.ts:11084                       | `msg.platform === 'slack' \|\| 'telegram' \|\| 'discord' \|\| 'feishu'`                            | stageAnswer (turn-final refresh) for IM platforms            | c     | renderer seam                                           |
| daemon.ts:11088                       | `!!webchat && msg.platform === 'webchat'`                                                          | webchatRefresh flag                                          | d     | —                                                       |
| daemon.ts:11246                       | `showFooter && p.platform === 'slack'`                                                             | pre-builds Slack attribution blocks                          | c     | footer renderer                                         |
| daemon.ts:11253                       | `conv instanceof FeishuConverger`                                                                  | Feishu emits a start card before first token                 | c     | streaming-edit mechanics                                |
| daemon.ts:11617                       | `showFooter && p.platform === 'slack' && finalAttributionInfo`                                     | refreshes Slack final footer                                 | c     | footer renderer                                         |
| daemon.ts:11625                       | `conv instanceof FeishuConverger`                                                                  | Feishu final action selection                                | c     | streaming-edit mechanics                                |
| daemon.ts:11785                       | `p.platform === 'slack' && p.conn && p.staleReplyFooters?.length`                                  | terminal retry of Slack stale-footer edits                   | c     | footer renderer                                         |
| daemon.ts:11938                       | `live.platform === 'feishu'`                                                                       | card-cancel on interrupt                                     | c     | streaming-edit mechanics                                |
| daemon.ts:12115                       | `p.platform !== 'slack' \|\| p.isDm`                                                               | per-message username/icon post options                       | c     | postIdentityOptions (manifest avatar.perMessageIconUrl) |
| daemon.ts:12125                       | `p.platform !== 'slack'`                                                                           | agent identity options for chrome rows                       | c     | postIdentityOptions                                     |
| daemon.ts:12153                       | `platform !== 'slack'`                                                                             | Slack transient status ("is thinking…") options              | c     | postIdentityOptions                                     |
| daemon.ts:12822                       | `platform === 'slack' \|\| platform === 'github'`; `platform !== 'feishu'`                         | session-link `?source=` hint, Feishu→region                  | c     | sessionLinkSource; manifest `regions`                   |
| daemon.ts:12833                       | `source?: 'slack' \| 'github' \| FeishuRegion`                                                     | closed source union on session deep links                    | c     | sessionLinkSource                                       |
| daemon.ts:12852                       | `int?.platform === 'slack' && int.slack.mode === 'shared'`                                         | HTTP/shared Slack ⇒ relay-owned action ids                   | b     | ingress                                                 |
| daemon.ts:12862                       | `… && int.slack.shareable === true`                                                                | gates in-thread "Switch agent" control                       | b     | multiAgentShareable                                     |
| daemon.ts:12927                       | `classification?.externalProvider === 'slack' \|\| 'feishu'`                                       | rolling-compat external origin rebuild                       | c     | tenantScope / externalOrigin                            |
| daemon.ts:13120                       | `sessionLink(rec.acpSessionId, 'slack')`                                                           | status modal link source                                     | c     | sessionLinkSource                                       |
| daemon.ts:13130                       | `p.platform === 'slack' && emitted`                                                                | settles the Slack status row                                 | c     | status-bar renderer                                     |
| daemon.ts:13143                       | `p.platform === 'slack' && !p.showStatusBar`                                                       | clears hidden Slack status bar                               | c     | status-bar renderer                                     |
| daemon.ts:13151                       | `p.platform === 'slack' ? p.statusCancellable : null`                                              | status-bar dedup key includes Slack-only field               | c     | status-bar renderer                                     |
| daemon.ts:13165                       | `p.platform === 'telegram' \|\| 'discord' \|\| 'feishu'`                                           | those platforms have no status bar — record only             | c     | status-bar renderer                                     |
| daemon.ts:13176                       | `sessionLink(p.acpSessionId, 'slack')`                                                             | Slack status-bar deep link                                   | c     | sessionLinkSource                                       |
| daemon.ts:13231                       | `p.platform === 'telegram' ? applyTelegram… : discord ? … : feishu ? … : applySlackAction`         | dispatches Layer-2 actions per platform                      | c     | §7.3 renderer seam                                      |
| daemon.ts:13258                       | `p.platform !== 'feishu' \|\| p.feishuStreamTimer \|\| !(p.conv instanceof FeishuConverger)`       | Feishu CardKit stream sampling timer                         | c     | streaming-edit mechanics                                |
| daemon.ts:13897                       | `p.platform === 'slack' && p.conn instanceof SlackConnection`                                      | in-chat permission approval card gate                        | c     | approvalSurface renderer                                |
| daemon.ts:13953                       | `p.platform === 'slack' && p.conn instanceof SlackConnection`                                      | in-chat MCP-approval elicitation gate                        | c     | approvalSurface renderer                                |
| daemon.ts:13961                       | `p.platform !== 'slack' \|\| !(conn instanceof SlackConnection)`                                   | elicitation card only rendered on Slack                      | c     | approvalSurface renderer                                |
| daemon.ts:14156                       | `binding.platform !== 'slack' \|\| rec.platform !== 'slack'`                                       | native DM thread title (Slack Agents)                        | c     | title renderer (new)                                    |
| daemon.ts:14203                       | `p.platform === 'slack' && p.isDm && p.conn`                                                       | live set-title on Slack DM                                   | c     | title renderer                                          |
| daemon.ts:14254                       | `rec?.platform === 'dream'`                                                                        | usage snapshot for quarantined dream extraction              | d     | —                                                       |
| daemon.ts:14340                       | `p?.platform === 'slack' && p.isDm && slackTitle`                                                  | runtime title → Slack DM title                               | c     | title renderer                                          |
| daemon.ts:14377                       | `p.platform === 'hook'` (isHeadlessGithubFinal)                                                    | selects GitHub final answer on hook turns                    | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:14678                       | `switch (integration.platform)` (4 cases)                                                          | per-platform credential → transport scope identity           | c     | transportScopeIdentity; manifest credentialShape        |
| daemon.ts:14719                       | `switch (integration.platform)` + `default:`                                                       | per-platform durable tenant anchor                           | c     | tenantScope; manifest identityScope                     |
| daemon.ts:14782                       | `rec?.externalProvider === 'slack' \|\| 'feishu'`                                                  | inherits external conversation audience                      | c     | tenantScope                                             |
| daemon.ts:14794                       | `rec?.externalProvider === 'github' && realmKey === 'github.com'`                                  | GitHub repository audience                                   | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:14824                       | `externalProvider: 'github' as const` (also 14801, 14814)                                          | githubExternalSource construction                            | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:14838                       | `externalProvider: 'slack' \| 'feishu'`                                                            | return type closes to 2 platforms                            | c     | tenantScope                                             |
| daemon.ts:14846                       | `(msg.platform !== 'slack' && !== 'feishu') \|\| (=== 'slack' && msg.isDm)`                        | which platforms yield external conversation source           | c     | tenantScope; manifest identityScope                     |
| daemon.ts:14855                       | `msg.platform === 'slack' ? conn.workspaceId?.() : feishu ? tenantScope…`                          | realmKey derivation differs per platform                     | c     | tenantScope                                             |
| daemon.ts:14892                       | `direct?.externalProvider === 'slack' \|\| 'feishu'`                                               | fail-closed incomplete external tuple                        | c     | tenantScope                                             |
| daemon.ts:14947                       | `msg.platform === 'webchat' ? undefined : integrationIdFor…`                                       | webchat has no integration                                   | d     | —                                                       |
| daemon.ts:14976                       | `msg.platform === 'webchat'`                                                                       | webchat sessions locally private                             | d     | —                                                       |
| daemon.ts:15027                       | `integrations.filter((i) => i.platform === platform)`                                              | resolves integration owning a scoped session                 | b     | — (session keying)                                      |
| daemon.ts:15035                       | `srcIntegrationIds` iterates 4 conn maps                                                           | ingress attribution across four pools                        | a     | §7.5 registry                                           |
| daemon.ts:15078                       | `msg.isDm \|\| (msg.platform === 'slack' && msg.channel.startsWith('D'))`                          | DM inference from Slack channel id prefix                    | c     | DM inference                                            |
| daemon.ts:15096                       | `msg.isDm \|\| (msg.platform === 'slack' && msg.channel.startsWith('D'))`                          | same inference in gated-notice path                          | c     | DM inference                                            |
| daemon.ts:15120                       | `conn instanceof SlackConnection ? postMessage(…{chrome}) : postChrome(…)`                         | gating notice chrome per transport                           | a     | —                                                       |
| daemon.ts:15153                       | `kind === 'channel' && msg.platform === 'discord'`                                                 | attaches Discord guild to observed row                       | c     | spaceForChannel                                         |
| daemon.ts:15170                       | `!(conn instanceof SlackConnection)`                                                               | profile/channel refinement Slack-only                        | a     | —                                                       |
| daemon.ts:15187                       | `kind !== 'channel' \|\| msg.platform !== 'slack'`                                                 | Slack `G…` mpim disambiguation via conversations.info        | a     | —                                                       |
| daemon.ts:15251                       | `connByIntegration ?? tgConn ?? dcConn ?? fsConn`                                                  | four-map connection lookup                                   | a     | §7.5 registry                                           |
| daemon.ts:15262                       | `replyConnFor` → `connForIntegration`                                                              | reply transport resolution over four pools                   | a     | §7.5 registry                                           |
| daemon.ts:15662                       | `narrowPlatform(rec.platform)`                                                                     | background-task wake session key                             | b     | — (§6.3)                                                |
| daemon.ts:15780                       | `row.platform === 'webchat' && row.channel`                                                        | revokes remote webchat MCP grant on TTL close                | d     | —                                                       |
| daemon.ts:16350                       | `p.platform === 'feishu'`                                                                          | shutdown card-cancel                                         | c     | streaming-edit mechanics                                |
| daemon.ts:16433                       | `msg.source === 'hook' && !hookContext`                                                            | tombstones legacy hook inbox rows                            | d     | —                                                       |
| daemon.ts:17271                       | `msg.platform === 'slack'`                                                                         | anchor post uses Slack identity options                      | c     | chrome renderer                                         |
| daemon.ts:17353                       | `sessionLink(sessionId, 'github')`                                                                 | GitHub comment attribution link                              | d     | — (Layer-2 GitHub)                                      |
| daemon.ts:17587                       | `platforms: ['slack','telegram','discord','feishu']`                                               | CP registration capability list                              | b     | platform registry (manifest ids)                        |
| cp/cp-collab-routes.ts:41             | `new Set(['slack','telegram','discord','feishu'])`                                                 | PERSISTED_IM_PLATFORMS constant                              | b     | persistsPlacements                                      |
| cp/cp-collab-routes.ts:253            | `PERSISTED_IM_PLATFORMS.has(platform)`                                                             | branch 2 vs 3 of coordsDecision (fail-closed)                | b     | persistsPlacements                                      |
| cp/cp-collab-routes.ts:265            | ``botAppsByChannel.get(`${platform}:${channelId}`)``                                               | platform-keyed managed bot-app suppression index             | b     | botSenderRouting                                        |
| messages/normalized.ts:41             | `platform: 'slack' \| 'telegram' \| 'webchat' \| 'discord' \| 'feishu' \| 'hook'`                  | closed platform union on NormalizedMessage                   | b     | §6.1 PlatformId × OriginKind                            |
| messages/normalized.ts:80             | `msg.platform === 'webchat' ? msg.traceId : msg.msgId`                                             | webchat delivery identity uses traceId                       | d     | —                                                       |
| messages/normalized.ts:109            | `platform === 'discord'` / `'telegram'` / `'feishu' && isDm` (109–111)                             | outbound thread-key derivation per platform                  | c     | threadKeyForPost                                        |
| messages/hook-message.ts:32           | `msg.context?.source === 'github'`                                                                 | GH sender login as trigger identity                          | d     | — (Layer-2 GitHub)                                      |
| messages/hook-message.ts:80           | `context?.source !== 'github'`                                                                     | GH session title derivation                                  | d     | —                                                       |
| messages/hook-message.ts:292          | `msg.context?.source === 'github'`                                                                 | GH-specific hook turn text                                   | d     | —                                                       |
| messages/hook-message.ts:314          | `msg.context?.source === 'github'`                                                                 | GH-specific anchor line                                      | d     | —                                                       |
| messages/hook-message.ts:329          | `` `hook:${msg.hookId}` ``                                                                         | hook session trigger id                                      | d     | —                                                       |
| messages/hook-message.ts:347          | `platform: target.platform`                                                                        | anchored hook adopts target platform                         | b     | §6.8 cron/hook targeting                                |
| messages/hook-message.ts:364          | `platform: 'hook'`                                                                                 | headless hook origin-kind                                    | d     | —                                                       |
| session/session-manager.ts:427        | `msg.platform === 'webchat' ? (msg.transcriptTs ?? …)`                                             | webchat carries a canonical relay ts                         | d     | —                                                       |
| session/session-manager.ts:450        | `msg.platform === 'webchat'`                                                                       | webchat transcript slot-probe/bump                           | d     | —                                                       |
| session/session-manager.ts:685        | `msg.platform === 'slack' && integrationId`                                                        | injects raw Slack self-id into prompt meta                   | c     | selfMentionId (manifest mentionIdPattern)               |
| session/session-manager.ts:937        | `msg.platform === 'slack' && slackTsMicros(...) === null`                                          | discards non-Slack-ts read cursor                            | c     | cursorOrdering (new)                                    |
| session/session-manager.ts:951        | `msg.platform === 'slack' && thread !== ts && fetchThreadHistory`                                  | Slack warm-thread snapshot cutoff                            | c     | threadBackfill (Layer-1 read port)                      |
| session/session-manager.ts:1003       | `if (msg.platform === 'slack') gap.sort(compareSlackTs)`                                           | Slack ts ordering of replay gap                              | c     | cursorOrdering                                          |
| session/session-manager.ts:1038       | `msg.platform === 'slack' ? …`                                                                     | delivered-through cursor advance rule                        | c     | cursorOrdering                                          |
| session/session-manager.ts:1044       | `msg.platform === 'slack' && compareSlackTs(ts, markerBefore) <= 0`                                | already-delivered trigger detection                          | c     | cursorOrdering                                          |
| session/session-manager.ts:1051       | `msg.platform === 'slack' && participantGap.some(...)`                                             | stale-trigger chronological batch                            | c     | cursorOrdering                                          |
| router/routing-table.ts:24            | `r.platform !== undefined && r.platform !== msg.platform`                                          | platform-scoped rule filter                                  | b     | — (routing envelope)                                    |
| router/routing-table.ts:90            | `!msg.sender.isBot \|\| msg.platform === 'slack'`                                                  | bot-authored mention admitted only on Slack                  | b     | botSenderRouting                                        |
| router/routing-rule.ts:46             | `int.platform === 'slack'` / `'discord'` / `'feishu'` / else telegram (46–68)                      | extracts core routing knobs from per-platform config         | b     | §6.4 core envelope                                      |
| router/routing-rule.ts:124            | `integrations.find((i) => i.platform === platform)`                                                | prefers same-platform integration for reply                  | b     | — (routing)                                             |
| scheduler/scheduler.ts:19             | `cron.target?.platform ?? 'slack'`                                                                 | headless cron keeps legacy `slack` session key               | b     | §6.8 cron targeting                                     |
| agents/agent-schema.ts:102            | `z.literal('slack'/'telegram'/'discord'/'feishu')` (102–126)                                       | closed IntegrationSchema discriminated union                 | b     | §6.4 opaque config                                      |
| agents/agent-schema.ts:142            | `platform: z.enum(['slack','telegram','discord','feishu'])`                                        | CronDef target platform enum                                 | b     | §6.8 cron targeting                                     |
| agents/write-integration.ts:26        | `spec.platform === 'telegram'/'discord'/'feishu'` else slack (26–73)                               | wire IntegrationSpec → daemon Integration                    | b     | §6.4 opaque config                                      |
| agents/write-cron.ts:30               | `cron.target && cron.target.platform === 'slack'`                                                  | non-Slack cron target silently degraded to headless          | b     | §6.8 cron targeting (known defect)                      |
| mcp/ops.ts:498                        | `knownIntegrations(ctx).filter((i) => i.platform === platform)`                                    | tool-call gateway resolution by platform                     | b     | — (routing)                                             |
| mcp/ops.ts:842                        | `directMessage ? 'slack' : ctx.platform`                                                           | `toUser` DM form defaults to Slack                           | a     | Layer-1 openDirectMessage                               |
| mcp/ops.ts:848                        | `wantPlatform !== 'slack'` → throw                                                                 | `toUser` DM unsupported off Slack                            | a     | Layer-1 openDirectMessage                               |
| mcp/ops.ts:870                        | `wantPlatform === 'telegram' \|\| === 'feishu'`                                                    | probes isIm only where it changes the thread key             | c     | threadKeyForPost / DM inference                         |
| mcp/ops.ts:921                        | `targetPlatform: wantPlatform`                                                                     | feeds rootPostRelation fork check                            | c     | threadKeyForPost                                        |
| mcp/tools.ts:853                      | `integrations.some((i) => i.platform === 'slack')`                                                 | injects readSlackFile tool                                   | a     | Layer-1 read port                                       |
| mcp/tools.ts:854                      | `integrations.some((i) => i.platform === 'telegram')`                                              | injects readTelegramFile tool                                | a     | Layer-1 read port                                       |
| cp/session-reader.ts:215              | `r.platform === 'slack' ? slackThreadUrl(...)`                                                     | Slack thread deep link on session list                       | c     | sessionLinkSource                                       |
| cp/session-reader.ts:249              | `rec.platform === 'slack' && (…)`                                                                  | chronological vs seq transcript paging                       | c     | cursorOrdering                                          |
| cp/session-reader.ts:270              | `externalProvider === 'github' \|\| (platform === 'hook' && transportScope.startsWith('github:'))` | trusted GitHub hook session sender rewrite                   | d     | — (Layer-2 GitHub)                                      |
| cp/session-reader.ts:353              | `rec.platform !== 'slack'`                                                                         | sort by seq off Slack, by eventTime on Slack                 | c     | cursorOrdering                                          |
| cp/relay-client.ts:213                | `msg.source === 'webchat'` (213–214)                                                               | wires webchat sink/post callbacks                            | d     | —                                                       |
| store/local-store.ts:2390             | `platform <> 'dream'`                                                                              | excludes dream rows from session query                       | d     | —                                                       |
| evaluation/environment.ts:80          | `platform: 'slack' \| 'telegram' \| 'discord' \| 'feishu' \| 'webchat'`                            | RefereeEvent closed platform union                           | b     | §6.1 PlatformId                                         |
| evaluation/environment.ts:124         | `switch (eff.platform)` (124–160)                                                                  | synthesizes per-platform credentials for virtual integration | a     | §7.5 registry (test double)                             |
| evaluation/environment.ts:172         | `eff.platform === 'telegram'`                                                                      | Telegram routing identity is @username                       | a     | —                                                       |
| evaluation/virtual-connections.ts:49  | `VirtualPlatform = 'slack' \| 'discord' \| 'telegram'`                                             | virtual transport union (no feishu)                          | a     | §7.5 registry (test double)                             |
| evaluation/virtual-connections.ts:183 | `platform: 'slack'` (also 306 discord, 372 telegram)                                               | virtual inbound message shapes                               | a     | —                                                       |

### 2. Counts

| class                   | count   |
| ----------------------- | ------- |
| (a) transport           | 30      |
| (b) manifest capability | 48      |
| (c) adapter strategy    | 74      |
| (d) core special case   | 46      |
| **total**               | **198** |

daemon.ts alone: 149 (a 22 / b 32 / c 61 / d 34). Other shared files: 49.

`narrowPlatform`: 1 definition (daemon.ts:7597) + 13 call sites (6575, 6763, 6782, 7045, 7108, 7207, 7454, 7458, 7620, 7777, 7905, 15662 — 12 distinct statements, 7458 being a second call in the same function as 7454) plus 3 doc-comment references in cp/cp-collab-routes.ts (215, 223, 239) and 2 explanatory comments in daemon.ts (6741, 7595). Total textual sites: 17 in the two files, matching the design's estimate.

### 3. Ambiguous

- **daemon.ts:3782, 3978, 15153 (`spaceFor` / `collapseObserved`)** — Discord guild grouping runs at console-config time (pre-dispatch) but is _behavior_ (store lookups + fold), not a declarative value, so it fits neither (b) nor (c) cleanly. Filed (c); the real fix may be a Layer-1 read-port method.
- **daemon.ts:8858 (`finalThreadSnapshot`)** — filed (a) because the body is a Slack read-port call, but the _branch_ is post-dispatch; under the new contract it becomes an optional read-port method rather than a strategy.
- **daemon.ts:12115/12125/12153** — per-message username/icon is post-dispatch rendering (c), yet the manifest already carries `avatar.perMessageIconUrl`; the two overlap and D2 doesn't say which wins.
- **daemon.ts:14678 / 14719** — `transportScopeForIntegration` is used both pre-dispatch (session keying, integration resolution at 15027) and post-dispatch (tenant scoping); §7.4 names `transportScopeIdentity`/`tenantScope` as strategies, so filed (c), but the pre-dispatch consumers argue for (b) `credentialShape`/`identityScope`.
- **daemon.ts:567** — one predicate mixes a platform capability (`=== 'slack'`) with two origin-kind exclusions (`webchat`, `headless`); filed (c) but it is a (c)+(d) compound and must be split during S1.
- **daemon.ts:4039 (`const platform = 'slack'` in `maybeIntroduceOnJoin`)** — hardcoded literal with no comparison; the Slack-ness is implicit (only Slack produces authoritative channel snapshots). Filed (b) `membershipEnumeration`, but it could equally be a latent bug rather than a designed capability gate.
- **session/session-manager.ts:937/1003/1038/1044/1051** — Slack-timestamp ordering has no §7.4 strategy name; coined `cursorOrdering`. Could fold into `threadKeyForPost`'s neighbourhood or become a new manifest axis (`messageIdOrdering: 'lexical-ts' | 'snowflake' | 'opaque'`).
- **daemon.ts:7386/7417, router/routing-table.ts:24, router/routing-rule.ts:124, daemon.ts:15027, mcp/ops.ts:498, cp/cp-collab-routes.ts:265** — generic `x.platform === y.platform` equalities with no literal. They survive an open `PlatformId` unchanged, so they may be out of scope entirely; included for completeness.
- **messages/hook-message.ts:32/80/292/314 and daemon.ts:8008/8031/8048** — filed (d) per the rubric's "hardcoded `github` turn-output special case", but these are _ingress_ GitHub branches, not turn-output; §7.6 only promises to remove the output-side special case, so the ingress ones may remain core forever.

### 4. Blind spots — platform-conditionals outside the listed shapes

1. **`instanceof <Platform>Connection`** — daemon.ts:3825, 3841, 3847, 13898, 13954, 13961, 15120, 15170; plus `conv instanceof FeishuConverger` at 11253, 11494, 11625, 11750, 13260. Type-narrowing, not string comparison. 13 sites.
2. **Duck-typed capability probes** — daemon.ts:8860 (`typeof conn?.getThreadReplies !== 'function'`), daemon.ts:9717 (`typeof slack.setStatus === 'function'`), daemon.ts:14724 (`conn?.workspaceId?.()`). Platform-conditional with no platform token at all.
3. **Structural casts as the branch** — daemon.ts:9226/9307/9314/9322/9372/9381 use `conn as TelegramConnection | DiscordConnection | FeishuConnection` after the platform test; the cast, not the test, is the coupling that blocks extraction.
4. **Hardcoded literals with no comparison operator** — daemon.ts:4039 (`const platform = 'slack'`), daemon.ts:13120/13176/17353 (`sessionLink(..., 'slack'|'github')`), scheduler/scheduler.ts:19 (`?? 'slack'`), messages/hook-message.ts:364.
5. **Platform-shaped id/format assumptions with no platform check** — `slackTsMicros` / `compareSlackTs` / `slackTsForWallClock` used unconditionally in session/session-manager.ts and cp/session-reader.ts; `msg.msgId.split(':').pop()` (daemon.ts:5557, 5301) assumes the `<platform>:<chat>:<id>` msgId grammar; `channel.startsWith('D')` (daemon.ts:15078, 15096) and the `G…` comment at 15184 encode Slack id syntax directly.
6. **Named per-platform fields on shared types** — `msg.discordTopLevel`, `msg.telegramTopicId`, `msg.telegramThreadRoot` (daemon.ts:5517, 5327, 5331; messages/normalized.ts). §6.5 targets these, but a `platform ===` grep never finds them.
7. **Per-platform state maps and timers as structure** — `connByIntegration` / `tgConnByIntegration` / `dcConnByIntegration` / `fsConnByIntegration` (daemon.ts:15035, 15251), `slackRetryTimers`, `feishuStreamTimer`, `staleReplyFooters`. The platform is in the _identifier_, not in any conditional.
8. **SQL literals** — store/local-store.ts:2390 (`platform <> 'dream'`) is inside a query string; only a string-content grep finds it.
9. **False positives to exclude from any regex sweep** — `'github'` as a _workspace mode_ (agents/write-agent.ts:667, 827; workspace/workspace-manager.ts:176, 206, 207) and `'dream'` as a _memory write source / skill kind_ (agents/memory.ts:59, agents/dream-runner.ts:913, 944, skills/install-skills.ts:83, skills/dream-skills.ts:280). Not platform conditionals; excluded from counts.

---

## Appendix B — `packages/relay/src`

Scope: all 30 non-test files (7,331 LOC), read in full or grepped exhaustively. Test files excluded from the table (fixtures, not branches) — see §4.

### 1. Classification table

#### `relay-ingress-manager.ts` (the primary hot spot)

| file:line                        | predicate (short excerpt)                                                         | what it does (≤15 words)                                            | class | implied manifest field / strategy fn     |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- | ---------------------------------------- |
| relay-ingress-manager.ts:350     | `if (a.platform === 'feishu') {`                                                  | Forks assign into the Feishu ingest constructor                     | a     | → plugin registry keyed by `manifest.id` |
| relay-ingress-manager.ts:351     | `!a.apiAppId \|\| !('verificationToken' in a.secrets)`                            | Validates Feishu credential shape before building ingest            | b     | `credentialShape` / `identityScope`      |
| relay-ingress-manager.ts:355     | `new FeishuHttpIngest(a.botId, a.apiAppId, a.secrets, …)`                         | Constructs the Feishu transport in relay core                       | a     | —                                        |
| relay-ingress-manager.ts:360     | `feishuIngests.set / feishuBotByAppId.set / feishuAppIdByBot.set`                 | Populates three Feishu-only routing maps                            | a     | —                                        |
| relay-ingress-manager.ts:365     | `if (a.platform !== 'slack') { … 'not yet supported' }`                           | Rejects every non-Slack, non-Feishu platform assignment             | b     | `ingress`                                |
| relay-ingress-manager.ts:369     | `if (!('botToken' in a.secrets))`                                                 | Validates Slack credential shape before building ingest             | b     | `credentialShape`                        |
| relay-ingress-manager.ts:376     | `if (a.apiAppId && a.teamId)`                                                     | Chooses composite (app,team) demux for tenant-scoped bots           | b     | `identityScope: 'tenant'`                |
| relay-ingress-manager.ts:382     | `} else if (a.apiAppId) { this.rememberApiApp(…) }`                               | Falls back to app-only demux for legacy bots                        | b     | `identityScope: 'app'`                   |
| relay-ingress-manager.ts:385     | `new SlackHttpIngest(a.botId, {botToken, signingSecret}, …)`                      | Constructs the Slack transport in relay core                        | a     | —                                        |
| relay-ingress-manager.ts:199     | `ingests = new Map<string, SlackHttpIngest>()` vs `:200 feishuIngests`            | Two parallel per-platform ingest registries in core state           | a     | —                                        |
| relay-ingress-manager.ts:207     | `demuxByApiApp` / `:211 demuxByAppTeam` / `:212 appTeamKeyByBot`                  | Slack-shaped demux indexes held by core                             | a     | —                                        |
| relay-ingress-manager.ts:347     | `this.forgetAppTeam(a.botId); this.forgetFeishuApp(a.botId)`                      | Calls both per-platform cleanup paths unconditionally               | a     | —                                        |
| relay-ingress-manager.ts:457     | `this.forgetAppTeam(botId); this.forgetFeishuApp(botId)`                          | Same dual cleanup on unassign                                       | a     | —                                        |
| relay-ingress-manager.ts:494     | `resolveVerified({apiAppId, teamId, timestamp, rawBody, signature})`              | Slack-only demux+authenticate entry point                           | a     | —                                        |
| relay-ingress-manager.ts:507     | `verifySlackSignature(ingest.signingSecret, timestamp, rawBody, …)`               | Slack HMAC verification called from core (×3: 507/512/519)          | a     | —                                        |
| relay-ingress-manager.ts:518     | `if (assignedTeam !== undefined && assignedTeam !== teamId) continue`             | Skips same-secret sibling installs in the verify-scan               | b     | `identityScope`                          |
| relay-ingress-manager.ts:531     | `resolveFeishuVerified({appId, rawBody, body, headers})`                          | Feishu-only demux+decrypt entry point beside the Slack one          | a     | —                                        |
| relay-ingress-manager.ts:540     | `ingest?.decode(args.rawBody, args.body, args.headers)`                           | Feishu decrypt/verify demux fast path                               | a     | —                                        |
| relay-ingress-manager.ts:543     | `for (const ingest of this.feishuIngests.values())`                               | Brute-force decrypt scan over Feishu assignments                    | a     | —                                        |
| relay-ingress-manager.ts:584     | `[...new Set([...this.ingests.keys(), ...this.feishuIngests.keys()])]`            | Unions two per-platform registries at shutdown                      | a     | —                                        |
| relay-ingress-manager.ts:594     | `this.feishuIngests.delete(botId)` inside `stopIngest`                            | Feishu-specific teardown inline in shared stop path                 | a     | —                                        |
| **relay-ingress-manager.ts:599** | `if (msg.platform !== 'slack' \|\| !msg.sender.isBot \|\| !appId) return false`   | **★ echo-suppression guard** — managed-bot echo filtered Slack-only | b     | `botSenderRouting`                       |
| relay-ingress-manager.ts:603     | `this.deps.isAgentBotApp(agent.agentId, msg.platform, msg.channel, appId)`        | Passes platform as directory lookup key pre-dispatch                | b     | — (platform as key, not flag)            |
| relay-ingress-manager.ts:628     | `msg.isDm \|\| (msg.isGroupDm === true && namesThisBot)`                          | Group-DM needs a mention; DM does not (Slack semantics)             | b     | derived facet `conversationKinds`        |
| **relay-ingress-manager.ts:665** | `if (assignment?.platform === 'feishu') tgt = this.router.soleGatedTarget(botId)` | **★ Feishu egress-ownership fork** — hand gated notice to daemon    | b     | `relayOwnsEgress` (from `egress`)        |
| relay-ingress-manager.ts:732     | `msg.isDm ? await this.ingests.get(botId)?.lookupUserName(…)`                     | Slack-only map lookup; Feishu DM rows land nameless                 | a     | adapter `lookupUserName`                 |
| relay-ingress-manager.ts:735     | `kind: msg.isDm ? 'im' : 'mpim'`                                                  | Maps conversation shape to CP row kind                              | b     | derived facet `conversationKinds`        |
| **relay-ingress-manager.ts:769** | `const ingest = this.ingests.get(botId)` … `:773 if (!ingest) return`             | **★ egress fork, other half** — no Slack ingest ⇒ no notice         | b     | `relayOwnsEgress`                        |
| relay-ingress-manager.ts:776     | `await ingest.postText(msg.channel, '🔒 This agent isn't enabled…')`              | Relay-owned Slack egress for the §14.3 gating notice                | a     | —                                        |
| relay-ingress-manager.ts:779     | `msg.isDm ? undefined : msg.thread`                                               | Chooses thread-reply vs top-level for the notice post               | c     | `threadKeyForPost` / `topLevelReplies`   |
| relay-ingress-manager.ts:168     | `return \`slack-action:${digest}\`` (also :183)                                   | Mints Slack-namespaced dedup msgId in core                          | a     | plugin-minted dedup id                   |
| relay-ingress-manager.ts:194     | `return \`feishu-action:${digest}\``                                              | Mints Feishu-namespaced dedup msgId in core                         | a     | plugin-minted dedup id                   |
| relay-ingress-manager.ts:806     | `source: 'slack_action'` (also :902)                                              | Per-platform `rd/msg` source discriminant                           | a     | — (D3 OriginKind×PlatformId)             |
| relay-ingress-manager.ts:852     | `source: 'feishu_action'`                                                         | Per-platform `rd/msg` source discriminant                           | a     | — (D3)                                   |
| relay-ingress-manager.ts:855     | `sessionKey: \`feishu-action:${messageId}\``                                      | Feishu-specific session-key namespace minted in core                | a     | —                                        |
| relay-ingress-manager.ts:834     | `WireFeishuCardActionValue.safeParse(action.action?.value)`                       | Parses Feishu card payload shape inside relay core                  | a     | —                                        |
| relay-ingress-manager.ts:848     | `action.context?.open_message_id ?? action.open_message_id`                       | Reads Feishu message-id shape variants in core                      | a     | —                                        |
| relay-ingress-manager.ts:130     | `switch (action.kind) { case 'set-model': … }`                                    | Switch over Slack status-bar action verbs to build dedup id         | a     | plugin-minted dedup id                   |

#### `bot-arbitration.ts`

| file:line                  | predicate (short excerpt)                                                                   | what it does (≤15 words)                                  | class | implied manifest field / strategy fn |
| -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----- | ------------------------------------ |
| bot-arbitration.ts:22      | `platform: 'slack' \| 'telegram' \| 'discord' \| 'feishu'`                                  | Closed platform union on the assignment type              | b     | `id` (D3 → open `PlatformId`)        |
| bot-arbitration.ts:23      | `{botToken; signingSecret} \| {verificationToken; encryptKey?}`                             | Two-shape secrets union hardcoded in core type            | b     | `credentialShape`                    |
| bot-arbitration.ts:124     | `if (a.botUserId !== undefined && msg.sender.id === a.botUserId) return null`               | Own-echo suppression via platform bot identity            | b     | `botSenderRouting` (see AMBIG-1)     |
| **bot-arbitration.ts:126** | `if (msg.sender.isBot && (msg.platform !== 'slack' \|\| !explicitlyMentioned)) return null` | **★ Slack-only bot-mention admission** into the ladder    | b     | `botSenderRouting`                   |
| bot-arbitration.ts:83      | `return \`${msg.channel}/${msg.thread ?? msg.channel}\``                                    | Session key assumes per-message threading semantics       | b     | `threading: 'per-message'`           |
| **bot-arbitration.ts:404** | `const ownTs = msg.msgId.slice(msg.msgId.lastIndexOf(':') + 1)`                             | **★ Parses Slack `slack:${channel}:${ts}` msgId shape**   | c     | `isThreadRoot(msg)` (see AMBIG-2)    |
| **bot-arbitration.ts:405** | `if (!msg.thread \|\| msg.thread === ownTs) return false`                                   | **★ thread-root detection** gating the CP lookup backstop | c     | `isThreadRoot(msg)` / `threading`    |
| bot-arbitration.ts:320     | `soleGatedTarget(botId)` (whole method)                                                     | Exists only to serve the Feishu receive-only egress fork  | b     | `relayOwnsEgress`                    |
| bot-arbitration.ts:298     | `soleTarget(botId)` — "fallback for Lark / Feishu cards"                                    | Feishu card-action compat resolution in shared router     | a     | —                                    |

#### `collaboration-router.ts`

| file:line                       | predicate (short excerpt)                                                                     | what it does (≤15 words)                                        | class | implied manifest field / strategy fn      |
| ------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----- | ----------------------------------------- |
| **collaboration-router.ts:69**  | `PERSISTED_IM_PLATFORMS = new Set(['slack','telegram','discord','feishu'])`                   | **The `coordsDecision` platform list** — hardcoded inline array | b     | `persistsPlacements`                      |
| **collaboration-router.ts:224** | `if (PERSISTED_IM_PLATFORMS.has(platform)) return { verdict: 'reject' }`                      | Fail-closed on unknown coordinate for persisted IM platforms    | b     | `persistsPlacements`                      |
| collaboration-router.ts:225     | `return { verdict: 'synthetic', channel: a2aCoordChannel(callerAgentId) }`                    | Channel-free (webchat/dream/hook) admission path                | d     | —                                         |
| collaboration-router.ts:79      | `return \`a2a:${callerAgentId}\``                                                             | Collision-freedom rests on per-platform channel-id syntax       | b     | derived facet `channelIdSyntax` (AMBIG-3) |
| collaboration-router.ts:38      | `return orgId + SEP + platform + SEP + channelId`                                             | Platform is a primary index key for placements                  | b     | — (platform as key)                       |
| collaboration-router.ts:268     | `if (!target \|\| target.platform !== platform \|\| target.channelId !== channelId) continue` | Platform equality gate in bot-app co-residency check            | b     | — (platform as key)                       |
| collaboration-router.ts:140     | `resolve(orgId, platform, channelId, agentId)`                                                | Platform-keyed placement lookup                                 | b     | — (platform as key)                       |

#### `agent-msg-router.ts`

| file:line               | predicate (short excerpt)                                                                       | what it does (≤15 words)                                      | class | implied manifest field / strategy fn |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- | ------------------------------------ |
| agent-msg-router.ts:107 | `router.coordsDecision(orgId, msg.coords.platform, msg.coords.channel, …).verdict === 'reject'` | The `coordsDecision` call site — NAKs a disallowed coordinate | b     | `persistsPlacements`                 |
| agent-msg-router.ts:149 | `router.resolve(orgId, platform, channel, msg.toAgentId)?.integrationId`                        | Platform-keyed reply-integration resolution                   | b     | — (platform as key)                  |

#### `index.ts`

| file:line    | predicate (short excerpt)                                                           | what it does (≤15 words)                                  | class | implied manifest field / strategy fn |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ----- | ------------------------------------ |
| index.ts:46  | `'botToken' in a.secrets ? {botToken, signingSecret} : {verificationToken, …}`      | Credential-shape ternary in the `rc/bot-assign` mapper    | b     | `credentialShape`                    |
| index.ts:44  | `platform: a.platform`                                                              | Passes closed platform enum through to core assignment    | b     | `id` (D3)                            |
| index.ts:214 | `registerSlackHttpIngress(server, …)` / `:215 registerFeishuHttpIngress(server, …)` | Hardcoded per-platform HTTP route registration at boot    | a     | → plugin-driven route registration   |
| index.ts:233 | `if (config.GITHUB_APP_WEBHOOK_SECRET) { registerGithubIngress(…) }`                | Conditionally mounts the GitHub webhook provider endpoint | a     | — (webhook seam)                     |
| index.ts:306 | `source: 'webchat'`                                                                 | Webchat-only context fan-out frame                        | d     | —                                    |

#### `slack-http-ingress.ts` (Slack transport edge)

| file:line                 | predicate (short excerpt)                                                                        | what it does (≤15 words)                                 | class | implied manifest field / strategy fn |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----- | ------------------------------------ |
| slack-http-ingress.ts:110 | `if (body.type === 'url_verification') return reply.code(200).send({challenge})`                 | Slack manifest-handshake challenge answered before demux | a     | —                                    |
| slack-http-ingress.ts:61  | `return \`${body.api_app_id ?? ''}\0${body.team_id ?? ''}\0${body.event_id}\``                   | Slack composite event-identity dedup key                 | a     | plugin-minted dedup id               |
| slack-http-ingress.ts:96  | `scope.post('/slack/events', …)` / `:136 '/slack/interactions'`                                  | Slack-named public route paths                           | a     | —                                    |
| slack-http-ingress.ts:98  | `req.headers['x-slack-signature']` / `:99 'x-slack-request-timestamp'`                           | Reads Slack-specific auth headers                        | a     | —                                    |
| slack-http-ingress.ts:143 | `new URLSearchParams(raw.toString('utf8')).get('payload')`                                       | Slack interaction urlencoded envelope decode             | a     | —                                    |
| slack-http-ingress.ts:162 | `const result = await ingest.handleInteraction(body); return reply.code(200).send(result ?? '')` | Slack `block_suggestion` must ride data on the 200 body  | a     | —                                    |

#### `slack-http-ingest.ts` (Slack transport module)

| file:line                | predicate (short excerpt)                                                                   | what it does (≤15 words)                                   | class | implied manifest field / strategy fn     |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----- | ---------------------------------------- |
| slack-http-ingest.ts:291 | `DEAD_CREDENTIAL_ERRORS = new Set(['account_inactive','token_revoked','invalid_auth'])`     | Slack error-code taxonomy for dead-credential detection    | a     | —                                        |
| slack-http-ingest.ts:300 | `subtype === 'file_share' \|\| 'me_message' \|\| 'thread_broadcast' \|\| 'reply_broadcast'` | Slack message-subtype allowlist for routability            | a     | —                                        |
| slack-http-ingest.ts:310 | `Boolean(event.user \|\| event.bot_id) && !event.hidden && event.message === undefined`     | Slack event-shape routability filter                       | a     | —                                        |
| slack-http-ingest.ts:450 | `if (event?.type === 'app_uninstalled' \|\| event?.type === 'tokens_revoked')`              | Slack app-lifecycle revocation branch                      | a     | —                                        |
| slack-http-ingest.ts:459 | `event?.user === this.botUserId \|\| event?.bot_id === this.slackBotId`                     | Module-local own-echo suppression (twin of the core guard) | a     | —                                        |
| slack-http-ingest.ts:461 | `if (event.type !== 'message' && event.type !== 'app_mention') return`                      | Slack event-type allowlist                                 | a     | —                                        |
| slack-http-ingest.ts:472 | `event.type === 'member_joined_channel' \|\| 'channel_left' \|\| 'group_left'`              | Slack membership-change event taxonomy                     | a     | `membershipEnumeration`                  |
| slack-http-ingest.ts:508 | `types: 'public_channel,private_channel', exclude_archived: true`                           | Authoritative Slack membership enumeration call            | a     | `membershipEnumeration: 'authoritative'` |
| slack-http-ingest.ts:514 | `if (!channel.id \|\| channel.is_im \|\| channel.is_mpim) continue`                         | Excludes DMs/MPIMs from the membership snapshot            | a     | `membershipEnumeration`                  |
| slack-http-ingest.ts:240 | `switch (effectiveActionId) { case SLACK_STATUS_ACTION.manage: … }`                         | Decodes Slack status-bar chrome verbs (post-dispatch UI)   | c     | `decodeInteraction()`                    |

#### `feishu-http-ingress.ts` (Feishu transport edge)

| file:line                 | predicate (short excerpt)                                          | what it does (≤15 words)                                       | class | implied manifest field / strategy fn |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- | ----- | ------------------------------------ |
| feishu-http-ingress.ts:44 | `scope.post('/feishu/events', …)`                                  | Feishu-named public route path                                 | a     | —                                    |
| feishu-http-ingress.ts:52 | `const appId = feishuCallbackAppId(body)`                          | Feishu envelope demux hint extraction                          | a     | —                                    |
| feishu-http-ingress.ts:53 | `x-lark-request-timestamp` / `:54 -nonce` / `:55 x-lark-signature` | Reads Lark-specific auth headers                               | a     | —                                    |
| feishu-http-ingress.ts:67 | `if (resolved.callback.kind === 'challenge')`                      | Feishu `url_verification` challenge answered on the 200        | a     | —                                    |
| feishu-http-ingress.ts:70 | `if (resolved.ingest.seen(resolved.callback.eventId))`             | Feishu per-ingest event-id dedup (separate from Slack's table) | a     | plugin-minted dedup id               |
| feishu-http-ingress.ts:71 | `if (resolved.callback.eventType === 'card.action.trigger')`       | Races a 2.5s sync card response onto the 200 body              | a     | —                                    |

#### `feishu-http-ingest.ts` (Feishu transport module)

| file:line                 | predicate (short excerpt)                                                                 | what it does (≤15 words)                           | class | implied manifest field / strategy fn |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ----- | ------------------------------------ |
| feishu-http-ingest.ts:61  | `createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(rawBody)` | Lark signature scheme (differs from Slack/GitHub)  | a     | —                                    |
| feishu-http-ingest.ts:100 | `const encrypted = typeof outer.encrypt === 'string' ? outer.encrypt : undefined`         | Encrypted-vs-plain callback fork                   | a     | —                                    |
| feishu-http-ingest.ts:103 | `decryptBody(this.secrets.encryptKey, encrypted)` (AES-256-CBC)                           | Feishu payload decryption                          | a     | —                                    |
| feishu-http-ingest.ts:110 | `!safeEqual(token, this.secrets.verificationToken)`                                       | Feishu verification-token authentication           | a     | `credentialShape`                    |
| feishu-http-ingest.ts:112 | `if (appId && appId !== this.appId) return null`                                          | Feishu app-id cross-check                          | a     | `identityScope`                      |
| feishu-http-ingest.ts:114 | `if (body.type === 'url_verification')`                                                   | Feishu challenge handshake                         | a     | —                                    |
| feishu-http-ingest.ts:117 | `if (this.secrets.encryptKey && !signatureIsValid(…))`                                    | Signature only enforced when an encrypt key exists | a     | —                                    |
| feishu-http-ingest.ts:120 | `header?.event_type ?? asRecord(body.event)?.type` / `:126 event_id ?? body.uuid`         | Feishu v1/v2 envelope-shape normalization          | a     | —                                    |
| feishu-http-ingest.ts:149 | `if (callback.eventType === 'card.action.trigger')` / `:153 !== 'im.message.receive_v1'`  | Feishu event-type demux to message vs card path    | a     | —                                    |
| feishu-http-ingest.ts:158 | `` `feishu:${callback.eventId}` : `feishu:${like.chatId}:${like.messageId}` ``            | Feishu-prefixed trace id                           | a     | —                                    |

#### `hooks/` (webhook seam)

| file:line                   | predicate (short excerpt)                                                                             | what it does (≤15 words)                                          | class | implied manifest field / strategy fn      |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----- | ----------------------------------------- |
| hooks/signature.ts:35       | `verifySlackSignature(signingSecret, timestamp, rawBody, header, nowMs)`                              | Slack-only HMAC scheme living in the shared hooks module          | a     | misplaced — belongs in Slack module       |
| hooks/ingress.ts:225        | `if (!rule \|\| rule.kind !== 'webhook' \|\| !rule.webhook) return notFound(reply)`                   | Provider demux on the generic token route                         | a     | —                                         |
| hooks/ingress.ts:97         | `if (captured.kind === 'github' && current.kind === 'github')`                                        | GitHub-only carve-out inside shared retry-authorization core      | c     | `normalizeRetryAuthority(rule)` (AMBIG-4) |
| hooks/hook-table.ts:30      | `if (rule.kind === 'webhook' && rule.webhook) this.byToken.set(…)`                                    | Per-provider index selection in shared table                      | a     | —                                         |
| hooks/hook-table.ts:31      | `if (rule.kind === 'github' && rule.github) { … byRepoId … }`                                         | GitHub repo-id index built in shared table                        | a     | —                                         |
| hooks/hook-table.ts:26      | `if (prior?.github && prior.github.repoId !== rule.github?.repoId)`                                   | GitHub-specific re-index on repo change                           | a     | —                                         |
| hooks/github-ingress.ts:706 | `verifySha256Header(deps.webhookSecret, raw, headers['x-hub-signature-256'])`                         | GitHub signature verification (shared primitive, provider header) | a     | —                                         |
| hooks/github-ingress.ts:710 | `headerString(req.headers['x-github-event'])` / `:711 event === 'ping'`                               | GitHub event-type header demux                                    | a     | —                                         |
| hooks/github-ingress.ts:722 | `event === 'check_run' && payload.action === 'rerequested'` (also :727, :731)                         | GitHub re-request forks before the generic matcher                | a     | —                                         |
| hooks/github-ingress.ts:740 | `if (INSTALLATION_EVENTS.has(event))`                                                                 | Installation events become a CP doorbell, never a run             | a     | —                                         |
| hooks/github-ingress.ts:751 | `if (!SUBSCRIPTION_EVENTS.has(event))`                                                                | GitHub event allowlist                                            | a     | —                                         |
| hooks/github-ingress.ts:756 | `subject?.number !== undefined ? String(subject.number) : event === 'push' ? payload.ref : undefined` | Provider-specific thread-key derivation                           | c     | `threadKeyForPost`                        |
| hooks/github-ingress.ts:223 | `if (rule.kind !== 'github' \|\| !rule.github) return 'no-match'`                                     | Provider gate on the rule matcher                                 | a     | —                                         |
| hooks/github-ingress.ts:240 | `if (ctx.senderType === 'Bot') return 'no-match'`                                                     | GitHub twin of the bot-sender admission rule                      | b     | `botSenderRouting`                        |
| hooks/github-ingress.ts:642 | `sessionKey: \`${rule.github.sessionKeyPrefix ?? repoFullName}#${target.pullNumber}\`` (also :807)    | GitHub-shaped session key minted in ingress                       | c     | `sessionKeyFor(delivery)`                 |
| hooks/ingress.ts:247        | `source: 'hook'` / `:256 source: 'webhook'`                                                           | Hook origin discriminants on the wire                             | d     | — (D3 `OriginKind`)                       |

#### webchat / hook core special cases

| file:line                       | predicate (short excerpt)                                                                      | what it does (≤15 words)                                      | class | implied manifest field / strategy fn |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- | ------------------------------------ |
| relay-browser-server.ts:28      | `export const RELAY_WEBCHAT_WS_PATH = '/webchat'`                                              | Dedicated webchat WS edge with no platform module             | d     | —                                    |
| relay-browser-server.ts:72      | `result = await deps.verify('webchat-token', token)`                                           | Webchat-only credential kind                                  | d     | —                                    |
| relay-browser-server.ts:87      | `const user = result.user ?? 'webchat'`                                                        | Webchat default identity literal                              | d     | —                                    |
| relay-cp-client.ts:167          | `kind === 'webchat-token' ? {kind, credential, conversationBinding:'v1'} : {kind, credential}` | Webchat-only extra field on the shared verify frame           | d     | —                                    |
| relay-browser-connection.ts:308 | `source: 'webchat'` (also :346, :406)                                                          | Webchat origin discriminant on `rd/msg`                       | d     | — (D3 `OriginKind`)                  |
| relay-daemon-connection.ts:142  | `case 'rd/webchat-post':` / `:175 type === 'rd/chat' \|\| 'rd/webchat-post'`                   | Dedicated webchat frame types in the shared daemon wire       | d     | —                                    |
| webchat-router.ts:1             | whole module (`WebchatRouter`, `ChatSink`, `rosterOf`)                                         | Webchat-only chatId→browser routing with no platform analogue | d     | —                                    |

### 2. Per-class counts

| class                   | count   |
| ----------------------- | ------- |
| (a) transport           | **69**  |
| (b) manifest capability | **28**  |
| (c) adapter strategy    | **7**   |
| (d) core special case   | **10**  |
| **total**               | **114** |

Per-file subtotals (a / b / c / d):

| file                            | a   | b   | c   | d   | total |
| ------------------------------- | --- | --- | --- | --- | ----- |
| relay-ingress-manager.ts        | 24  | 12  | 1   | 0   | 37    |
| bot-arbitration.ts              | 1   | 6   | 2   | 0   | 9     |
| collaboration-router.ts         | 0   | 5   | 0   | 1   | 6     |
| agent-msg-router.ts             | 0   | 2   | 0   | 0   | 2     |
| index.ts                        | 2   | 2   | 0   | 1   | 5     |
| slack-http-ingress.ts           | 6   | 0   | 0   | 0   | 6     |
| slack-http-ingest.ts            | 9   | 0   | 1   | 0   | 10    |
| feishu-http-ingress.ts          | 6   | 0   | 0   | 0   | 6     |
| feishu-http-ingest.ts           | 10  | 0   | 0   | 0   | 10    |
| hooks/                          | 11  | 1   | 3   | 1   | 16    |
| webchat / browser / daemon-conn | 0   | 0   | 0   | 7   | 7     |

Distinct manifest fields implied by class (b), by frequency: `credentialShape` (5), `identityScope` (5), `botSenderRouting` (4), `relayOwnsEgress` (3), `persistsPlacements` (3), platform-as-key (5, no flag), `id` (2), `conversationKinds` (2, **new** — not in §5), `threading` (1), `ingress` (1), `channelIdSyntax` (1, **new**).
Distinct strategies implied by class (c): `isThreadRoot` (2), `threadKeyForPost` (2), `decodeInteraction` (1), `sessionKeyFor(delivery)` (1), `normalizeRetryAuthority` (1).

### 3. Ambiguous

- **AMBIG-1 — which line is "the echo-suppression guard".** Three candidates. `relay-ingress-manager.ts:599` is the only one that literally reads `msg.platform`, so it is the core platform read the design names. `bot-arbitration.ts:124` is the true own-echo guard but reads `botUserId`, not platform — it becomes capability-free once bot identity is manifest-supplied. `slack-http-ingest.ts:459` is already inside the transport module.
- **AMBIG-2 — thread-root detection is (b) or (c).** `bot-arbitration.ts:404-405` runs _before_ target resolution (it gates the CP `rc/thread-lookup` backstop), so the strict D2 rule pushes it toward `threading`. But the msgId-tail parse is genuinely per-platform string surgery, which no boolean flag expresses. The design itself hedges ("adapter `isThreadRoot` or the threading capability"); a pure adapter-exported predicate read pre-dispatch is the least-bad resolution.
- **AMBIG-3 — `a2aCoordChannel` (`collaboration-router.ts:79`).** No branch, but its collision-freedom argument is a documented per-platform invariant ("Slack/Telegram/Discord/Feishu channel ids never contain `:`"). A new platform whose ids contain `:` silently breaks it. Either a manifest `channelIdSyntax` assertion or a non-syntactic (hashed) coordinate.
- **AMBIG-4 — `hooks/ingress.ts:97`.** A GitHub-only field-normalization carve-out inside shared retry-authorization core. Pre-dispatch by timing, but it is a data transform, not a declarative value — hence (c). If webhook providers get their own manifest, it becomes `retryAuthorityFields: string[]`, i.e. (b).
- **AMBIG-5 — Feishu card sync-response race (`feishu-http-ingress.ts:71`, `relay-ingress-manager.ts:829-869`).** Classified (a), but "the platform requires the interaction result on the HTTP 200 body within N ms" is a transport _contract_ that core's timeout must honor — arguably a manifest facet (`interactionAckMode: 'sync' | 'async'`). Slack has the same shape at `slack-http-ingress.ts:162` (`block_suggestion`), which strengthens the case for a shared flag.
- **AMBIG-6 — `identityScope` vs transport for the demux maps.** `relay-ingress-manager.ts:376/382/518` read a declarative identity shape (⇒ (b)), but the maps at `:207/:211/:212` that implement it are transport state (⇒ (a)). Split as shown, but the _whole cluster_ moves together in S-later.
- **AMBIG-7 — `conversationKinds` is a new field.** `relay-ingress-manager.ts:628/735` and `:779` encode "DM has no thread; group DM must be mentioned; DM/MPIM are the direct kinds". Not covered by §5's list. Either a new pre-dispatch facet or folded into `threading`/`topLevelReplies`.

### 4. Platform-conditionals outside the listed shapes

- **Deliberate platform _absence_ as a load-bearing decision.** `collaboration-router.ts:42` (`coordsKey` is platform-free) plus the 15-line rationale at `:191-205`: the key omits platform _because_ the daemon's `narrowPlatform` folds `feishu`→`'slack'`. This is a cross-host platform coupling that no grep pattern finds — it must be re-derived, not migrated, and the daemon twin (`packages/daemon/src/cp/cp-collab-routes.ts`, byte-identical per `:56-58`) must move in lockstep.
- **Structural forks with no platform literal.** `relay-ingress-manager.ts:769/773` (`this.ingests` is Slack-only, so a Feishu bot falls out of the notice path) and `:732` (`lookupUserName` silently unavailable for Feishu). The platform condition is encoded in _which map the bot lives in_, not in a comparison.
- **Parallel-function forks.** `resolveVerified` (:494) / `resolveFeishuVerified` (:531); `forwardSessionAction` (:793) / `forwardFeishuAction` (:829); `registerSlackHttpIngress` / `registerFeishuHttpIngress` (index.ts:214-215). Each pair is a switch expressed as duplicated call sites.
- **Type-level platform conditionals.** `bot-arbitration.ts:22-23` — the closed union and the two-shape `secrets` discriminated union. `tsc` enforces these branches; grep for `===` never sees them.
- **Comment-only platform knowledge.** `bot-arbitration.ts:403` documents the `slack:${channel}:${ts}` msgId format that `:404` depends on; `collaboration-router.ts:75-77` documents the channel-id syntax invariant. Both are load-bearing contracts with no code assertion.
- **No reversed literal-first comparisons anywhere.** `grep -rE "'(slack|telegram|discord|feishu|webchat|hook|dream)' *(===|!==)"` returns zero hits in non-test source.
- **No `switch` on platform anywhere in the relay.** All platform dispatch is `if`-chains or map lookups.
- **Zero platform-conditionals** in `config.ts`, `server.ts`, `log.ts`, `mcp/*` (4 files), `memory/binding-table.ts`, `slack-event-dedup.ts` (Slack-named but platform-agnostic), `hooks/rate-limit.ts`, `hooks/hook-snapshot.ts`, `relay-daemon-server.ts`, `relay-browser-connection.ts` (beyond the webchat `source` literals).
- **Test files (excluded from counts).** Only one test contains a platform-iterating construct rather than a fixture: `agent-msg-router.test.ts:411` — `for (const [i, platform] of ['telegram','discord','feishu'].entries())`, the fail-closed matrix for `PERSISTED_IM_PLATFORMS`. This array must stay in sync with `collaboration-router.ts:69` and will need to become manifest-driven alongside it.

---

## Appendix C — `packages/control-plane/src` (+ prisma/schema.prisma)

Scope: `packages/control-plane/src/**` minus `src/generated/` and `*.test.ts`, plus `packages/control-plane/prisma/schema.prisma` for the data-model inventory.

### 1. Classification table

#### 1.1 `http/routes/integrations.ts` — the create funnel + closed DTO union

| file:line                        | predicate (short excerpt)                                                   | what it does (≤15 words)                                            | class | implied manifest field / provider facet              |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| http/routes/integrations.ts:72   | `...(i.feishuRegion ? { region: i.feishuRegion } : {})`                     | Leaks Feishu region into the generic integration DTO                | b     | `regions[]`                                          |
| http/routes/integrations.ts:124  | `if (platform !== 'slack')`                                                 | Refuses multi-agent shared bots on every non-Slack platform         | b     | `multiAgentShareable`                                |
| http/routes/integrations.ts:306  | `if (bot.teamId && !bot.shareable)`                                         | Platform-app workspace bot serves one agent; blocks silent widening | b     | `identityScope: 'tenant'`                            |
| http/routes/integrations.ts:344  | `...(bot.feishuRegion ? { feishuRegion } : {})`                             | Carries region forward on shareable-bot membership admission        | b     | `regions[]`                                          |
| http/routes/integrations.ts:384  | `...(bot.feishuRegion ? { feishuRegion } : {})`                             | Same carry-forward on classic bot reuse                             | b     | `regions[]`                                          |
| http/routes/integrations.ts:393  | `transport === 'http' && platform !== 'slack' && platform !== 'feishu'`     | Rejects HTTP callback ingress for Telegram/Discord                  | b     | `ingress: 'socket'\|'http'\|'both'`                  |
| http/routes/integrations.ts:404  | `if (req.body.platform === 'telegram')`                                     | Whole Telegram credential-validate + bot/integration create branch  | c     | `validateConfig` / `credentialBodySchema`            |
| http/routes/integrations.ts:406  | `await deps.verifyTelegramBot(tg.botToken)`                                 | Calls Telegram getMe to validate the pasted token                   | a     | —                                                    |
| http/routes/integrations.ts:423  | `if (!checked.privacyModeDisabled)`                                         | Telegram-only Group-Privacy-Mode install precondition               | a     | —                                                    |
| http/routes/integrations.ts:453  | `if (deps.syncTelegramBotIcon)`                                             | Post-create Telegram avatar push, failure non-fatal                 | c     | `sideEffects.postCreate`                             |
| http/routes/integrations.ts:466  | `if (req.body.platform === 'discord')`                                      | Whole Discord validate + create branch                              | c     | `validateConfig` / `credentialBodySchema`            |
| http/routes/integrations.ts:468  | `deps.verifyDiscordBot(discord.botToken)`                                   | Calls Discord API to validate the Gateway bot token                 | a     | —                                                    |
| http/routes/integrations.ts:477  | `await deps.ensureDiscordMessageContentIntent(...)`                         | Enables Discord Message Content privileged intent before storing    | a     | —                                                    |
| http/routes/integrations.ts:504  | `discordAppIdFromBotToken(discord.botToken)`                                | Decodes Discord application id out of the bot token                 | a     | —                                                    |
| http/routes/integrations.ts:525  | `if (deps.syncDiscordBotProfile && check?.status !== 'unreachable')`        | Post-create Discord profile/avatar push                             | c     | `sideEffects.postCreate`                             |
| http/routes/integrations.ts:547  | `if (req.body.platform === 'feishu')`                                       | Whole Feishu validate + create branch                               | c     | `validateConfig` / `credentialBodySchema`            |
| http/routes/integrations.ts:549  | `const region = feishu.region // zod-defaulted 'lark'`                      | Picks the Feishu vs Lark API cloud at install                       | b     | `regions[]`                                          |
| http/routes/integrations.ts:558  | `deps.verifyFeishuBot(appId, appSecret, region)`                            | tenant-access-token exchange validates both Feishu credentials      | a     | —                                                    |
| http/routes/integrations.ts:572  | `transport === 'http' && (check?.status !== 'ok' \|\| !check.openId)`       | Feishu HTTP ingress must resolve bot open_id first                  | c     | `projectBotAssign`                                   |
| http/routes/integrations.ts:607  | `const botCheck = await deps.verifySlackBot?.(slack.botToken)`              | Slack auth.test bot-token validation                                | a     | —                                                    |
| http/routes/integrations.ts:617  | `const appCheck = await deps.verifySlackAppToken?.(slack.appToken!)`        | Slack app-level token validation for Socket Mode                    | a     | —                                                    |
| http/routes/integrations.ts:627  | `botCheck.appId !== appTokenAppId`                                          | Cross-checks Slack bot + app tokens belong to one app               | a     | —                                                    |
| http/routes/integrations.ts:815  | `platform === 'telegram' \|\| 'discord' \|\| 'feishu'` (`needsSuppression`) | Durable forget tombstone only where membership is history-derived   | b     | `membershipEnumeration: 'authoritative'\|'observed'` |
| http/routes/integrations.ts:1172 | `target.kind === 'space' && integration.platform !== 'discord'`             | Only Discord has a server to leave                                  | b     | `leaveGranularity`                                   |
| http/routes/integrations.ts:1179 | `target.kind === 'conversation' && integration.platform === 'discord'`      | Discord has no per-channel membership to leave                      | b     | `leaveGranularity`                                   |

#### 1.2 `http/dto/index.ts` — the closed create-DTO union and install DTOs

| file:line                 | predicate (short excerpt)                                            | what it does (≤15 words)                                                | class | implied manifest field / provider facet           |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- | ------------------------------------------------- |
| http/dto/index.ts:698     | `platform: z.enum(['slack','telegram','discord','feishu'])`          | Closed platform enum on the create body                                 | b     | registry-derived `PlatformId` set                 |
| http/dto/index.ts:712-744 | `slack: {...}`, `telegram: {...}`, `discord: {...}`, `feishu: {...}` | Four hand-written per-platform credential sub-schemas                   | c     | `credentialBodySchema`                            |
| http/dto/index.ts:740     | `region: FeishuRegion.default('lark')`                               | Region default baked into the core DTO                                  | b     | `regions[]`                                       |
| http/dto/index.ts:748     | `b.platform === 'slack' ? b.slack : b.platform === 'telegram' ? ...` | Ternary chain selecting the credential object                           | c     | `credentialBodySchema`                            |
| http/dto/index.ts:763     | `(['slack','telegram','discord','feishu'] as const).filter(...)`     | Inline platform array guards mismatched credential blocks               | c     | `credentialBodySchema`                            |
| http/dto/index.ts:773     | `b.platform === 'slack' && b.botId === undefined && b.slack`         | Slack per-transport credential requirements (signingSecret vs appToken) | b     | `credentialShape: 'token+appToken'`               |
| http/dto/index.ts:781     | `b.platform === 'feishu' && ... b.transport === 'http'`              | Feishu HTTP requires a verificationToken                                | b     | `credentialShape: 'appId+appSecret+verification'` |
| http/dto/index.ts:825     | `region: FeishuRegion.optional() // feishu integrations only`        | Feishu-only field on the shared IntegrationDto                          | b     | `regions[]`                                       |
| http/dto/index.ts:1073    | `z.enum(['manual','dream'])`                                         | Dream-origin artifact source                                            | d     | —                                                 |
| http/dto/index.ts:1488    | `region: FeishuRegion.default('lark')` on registration start         | Region default on the Feishu one-click funnel                           | b     | `regions[]`                                       |
| http/dto/index.ts:1492    | `FeishuAppRegistrationStartDto` (authorizationUrl/expiresAt)         | Feishu device-flow install DTO in core DTO module                       | c     | `installRoutes`                                   |
| http/dto/index.ts:1512    | `SlackPlatformInstallStartBody` (agentId XOR botId)                  | Slack platform-app install DTO in core DTO module                       | c     | `installRoutes`                                   |
| http/dto/index.ts:1534    | `SlackPlatformInstallStatusDto`                                      | Slack platform-install poll shape                                       | c     | `installRoutes`                                   |
| http/dto/index.ts:1540    | `'workspace_taken' \| 'workspace_mismatch' \| 'agent_taken'`         | Slack-specific install failure codes in the shared DTO                  | c     | `installRoutes`                                   |
| http/dto/index.ts:1560    | `SlackAppFinalizeBody` (`appToken` socket-only)                      | Slack funnel finalize body                                              | b     | `credentialShape`                                 |
| http/dto/index.ts:1586    | `discriminatedUnion('kind', [conversation, space])`                  | Leave target union exists only because Discord differs                  | b     | `leaveGranularity`                                |
| http/dto/index.ts:1605    | `slackAppId / discordAppId / feishuAppId` on BotDto                  | Three per-platform display id columns on one DTO                        | b     | per-platform JSON bag (D6)                        |
| http/dto/index.ts:1611    | `feishuRegion: FeishuRegion.nullable()`                              | Feishu region on the shared BotDto                                      | b     | `regions[]`                                       |
| http/dto/index.ts:1629    | `teamId: z.string().nullable()`                                      | Slack workspace demux id on the shared BotDto                           | b     | `identityScope: 'tenant'`                         |
| http/dto/index.ts:1809    | `z.array(z.enum(['slack','telegram','discord']))`                    | Waitlist intake hard-codes three platforms                              | b     | registry-derived `PlatformId` set                 |
| http/dto/index.ts:2040    | `export const Platform = z.enum([...4])`                             | Cron/hook target platform enum                                          | b     | registry-derived `PlatformId` set                 |
| http/dto/index.ts:2087    | `targetPlatform: Platform.default('slack')`                          | Cron target defaults to Slack                                           | b     | registry default / envelope field                 |
| http/dto/index.ts:2165    | `targetPlatform: Platform.default('slack')`                          | Hook target defaults to Slack                                           | b     | registry default / envelope field                 |
| http/dto/index.ts:2500    | `z.enum(['slack','github','feishu'])`                                | External-access provider set                                            | c     | `sessionAudienceResolver`                         |

#### 1.3 `orchestrator/placement.ts` — IntegrationSpec assembly

| file:line                     | predicate (short excerpt)                  | what it does (≤15 words)                               | class | implied manifest field / provider facet |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------ | ----- | --------------------------------------- |
| orchestrator/placement.ts:147 | `platform: toDbPlatform(c.targetPlatform)` | Narrows protocol platform for the cron wire target     | d     | —                                       |
| orchestrator/placement.ts:247 | `if (i.platform === 'telegram')`           | Builds the Telegram-shaped spec branch                 | c     | `projectIntegrationConfig`              |
| orchestrator/placement.ts:255 | `if (i.platform === 'discord')`            | Builds the Discord-shaped spec branch                  | c     | `projectIntegrationConfig`              |
| orchestrator/placement.ts:264 | `if (i.platform === 'feishu')`             | Builds the Feishu spec (mode/appId/appSecret/region)   | c     | `projectIntegrationConfig`              |
| orchestrator/placement.ts:276 | `region: i.feishuRegion ?? 'feishu'`       | Region default inside spec assembly                    | b     | `regions[]`                             |
| orchestrator/placement.ts:286 | `platform: 'slack'` (fallthrough)          | Slack is the untested default arm of the discriminator | c     | `projectIntegrationConfig`              |
| orchestrator/placement.ts:328 | `if (i.platform === 'feishu')` (http path) | Feishu shared-mode spec with botOpenId + region        | c     | `projectIntegrationConfig`              |
| orchestrator/placement.ts:338 | `region: i.feishuRegion ?? 'feishu'`       | Region default on the http spec                        | b     | `regions[]`                             |
| orchestrator/placement.ts:348 | `platform: 'slack'` (http fallthrough)     | Slack shared spec with `shareable` + `appId`           | c     | `projectIntegrationConfig`              |

#### 1.4 `orchestrator/httpBot.ts` — rc/bot-assign + relay wire payloads

| file:line                   | predicate (short excerpt)                                                                     | what it does (≤15 words)                               | class | implied manifest field / provider facet  |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- | ---------------------------------------- |
| orchestrator/httpBot.ts:57  | `platform: 'slack' \| 'telegram' \| 'discord' \| 'feishu'`                                    | Closed union on the compiled routing table             | b     | registry-derived `PlatformId` set        |
| orchestrator/httpBot.ts:134 | `bot.platform === 'slack' && !secret.signingSecret`                                           | Refuses assign without Slack signing secret            | b     | `credentialShape`                        |
| orchestrator/httpBot.ts:139 | `bot.platform === 'feishu' && (!verificationToken \|\| !appToken)`                            | Refuses assign without Feishu callback credentials     | b     | `credentialShape`                        |
| orchestrator/httpBot.ts:308 | `bot.platform === 'slack' && !secret.signingSecret`                                           | Same completeness gate in the relay replay path        | b     | `credentialShape`                        |
| orchestrator/httpBot.ts:309 | `bot.platform === 'feishu' && (...)`                                                          | Same Feishu gate in the replay path                    | b     | `credentialShape`                        |
| orchestrator/httpBot.ts:398 | `bot.platform !== 'slack' \|\| bot.transport !== 'http'`                                      | Only Slack reports an authoritative channel snapshot   | b     | `membershipEnumeration: 'authoritative'` |
| orchestrator/httpBot.ts:456 | `bot.platform !== 'slack' && bot.platform !== 'feishu'`                                       | Only Slack/Feishu report incremental DM conversations  | b     | `membershipEnumeration: 'observed'`      |
| orchestrator/httpBot.ts:485 | `source?: 'console' \| 'slack'`                                                               | Slack in-thread "switch agent" as a first-class origin | c     | adapter strategy (post-dispatch control) |
| orchestrator/httpBot.ts:822 | `bot.platform === 'slack' ? 'slack' : ... : 'feishu'`                                         | Four-way identity ternary re-deriving the platform id  | c     | `projectBotAssign`                       |
| orchestrator/httpBot.ts:883 | `bot.platform === 'feishu' && secret.appToken ? apiAppId : bot.slackAppId`                    | Chooses the relay's inbound demux app id per platform  | c     | `projectBotAssign`                       |
| orchestrator/httpBot.ts:891 | `...(bot.teamId ? { teamId: bot.teamId } : {})`                                               | Ships the Slack tenant half of the demux key           | b     | `identityScope: 'tenant'`                |
| orchestrator/httpBot.ts:898 | `bot.platform === 'feishu' ? { verificationToken, encryptKey } : { botToken, signingSecret }` | Two different secret bags on one wire frame            | c     | `projectBotAssign` / `credentialShape`   |

#### 1.5 Avatar / icon push side effects

| file:line                       | predicate (short excerpt)                                                            | what it does (≤15 words)                                | class | implied manifest field / provider facet |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ----- | --------------------------------------- |
| http/agent-bot-icon-sync.ts:58  | `(bot.platform === 'telegram' && ...) \|\| (discord) \|\| (feishu)`                  | Three-way "does this platform accept a bot avatar" test | b     | `avatar.botProfilePush`                 |
| http/agent-bot-icon-sync.ts:99  | `if (state.bot.platform === 'telegram' && deps.syncTelegramBotIcon) ... else if ...` | Per-platform icon-push dispatch chain                   | c     | `sideEffects.iconSync`                  |
| http/agent-bot-icon-sync.ts:106 | `const appId = secret.appToken ?? state.bot.feishuAppId`                             | Feishu-only app-id resolution for the icon call         | c     | `sideEffects.iconSync`                  |
| http/agent-bot-icon-sync.ts:114 | `state.bot.feishuRegion ?? 'feishu'`                                                 | Region default on the icon push                         | b     | `regions[]`                             |
| http/routes/agent-icon.ts:12    | `// Slack fetches this as the per-message icon_url`                                  | Public unauthenticated avatar endpoint exists for Slack | b     | `avatar.perMessageIconUrl`              |
| http/routes/agent-icon.ts:35    | `reply.header('Access-Control-Allow-Origin','*')`                                    | CORS added specifically for the Lark app launcher       | b     | `avatar.perMessageIconUrl`              |
| http/feishu-app-icon.ts:5       | `const REGION_ORIGIN: Record<FeishuRegion,string>`                                   | Region→API-origin map for icon upload                   | b     | `regions[].apiBaseUrl`                  |

#### 1.6 The three structurally different install funnels

| file:line                                 | predicate (short excerpt)                                                                             | what it does (≤15 words)                                            | class | implied manifest field / provider facet  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- | ---------------------------------------- |
| http/routes/slack-install.ts:117          | `platform: 'slack'` (capability check)                                                                | Config-token funnel hard-codes its platform id                      | c     | `installRoutes`                          |
| http/routes/slack-install.ts:307          | `row.transport === 'http' && !row.signingSecret`                                                      | HTTP funnel needs the captured signing secret                       | b     | `credentialShape`                        |
| http/routes/slack-install.ts:316          | `slackAppIdFromAppToken(req.body.appToken) !== row.appId`                                             | Verifies pasted xapp belongs to the created app                     | a     | —                                        |
| http/routes/slack-install.ts:322          | `if (row.transport === 'socket') { if (!req.body.appToken) ... }`                                     | Socket finalize requires the operator-pasted app token              | b     | `credentialShape`                        |
| http/routes/slack-install.ts:350          | `platform: 'slack'` (finalize recheck)                                                                | Second hard-coded platform capability check                         | c     | `installRoutes`                          |
| http/routes/slack-install.ts:571          | `'connected' \| 'denied' \| ... \| 'workspace_taken' \| 'agent_taken'`                                | Slack-specific callback note union                                  | c     | `installRoutes`                          |
| http/routes/slack-install.ts:590          | `note === 'connected' ? ... : note === 'workspace_taken' ? ...`                                       | Slack-specific close-page copy ladder                               | c     | `installRoutes`                          |
| http/routes/slack-platform-install.ts:96  | `bot.platform !== 'slack' \|\| !bot.prebuilt \|\| bot.slackAppId !== platform.appId \|\| !bot.teamId` | Reauthorization fence on the composite workspace identity           | b     | `identityScope: 'tenant'`                |
| http/routes/slack-platform-install.ts:109 | `deps.repos.presetAgent.get(orgId, 'general')`                                                        | Core preset default-binding resolved inside Slack install machinery | c     | `installRoutes` (core leak)              |
| http/routes/slack-platform-install.ts:248 | `result.appId !== platform.appId \|\| !result.teamId`                                                 | Validates the OAuth exchange result against the distributed app     | a     | —                                        |
| http/routes/slack-platform-install.ts:261 | `expectedBot.platform !== 'slack' \|\| ... expectedBot.slackAppId !== platform.appId`                 | Re-fences the expected bot before rotating credentials              | b     | `identityScope: 'tenant'`                |
| http/routes/slack-platform-install.ts:291 | `if (existing && existing.orgId !== row.orgId) ... fail('workspace_taken')`                           | Cross-org workspace fencing on the global demux key                 | b     | `identityScope: 'tenant'`                |
| http/routes/slack-platform-install.ts:332 | `platform: 'slack'` in `addBotMembership`                                                             | Hard-coded platform on the admission write                          | c     | `installRoutes`                          |
| http/routes/slack-platform-install.ts:358 | `transport: 'http', shareable: false, prebuilt: true`                                                 | Distributed app is Events-API-only and single-agent                 | b     | `ingress` + `multiAgentShareable`        |
| http/routes/feishu-registration.ts:82     | `platform: 'feishu'` (capability check)                                                               | Feishu funnel hard-codes its platform id                            | c     | `installRoutes`                          |
| http/routes/feishu-registration.ts:167    | `deps.verifyFeishuBot(registration.appId, registration.appSecret, registration.region)`               | Validates provider-minted credentials during the poll               | a     | —                                        |
| http/routes/feishu-registration.ts:201    | `platform: 'feishu'` (poll-time recheck)                                                              | Second hard-coded platform capability check                         | c     | `installRoutes`                          |
| http/routes/feishu-registration.ts:223    | `verificationToken = ... randomBytes(16)`, `encryptKey = ...`                                         | CP mints Feishu callback secrets for HTTP transport                 | b     | `credentialShape`                        |
| http/routes/feishu-registration.ts:238    | `await deps.configureFeishuHttpApp(httpAppConfig)`                                                    | Pushes the relay request_url into the Feishu app                    | a     | —                                        |
| http/install-slack.ts:25                  | `appToken.split('-')[2] ... /^A[A-Z0-9]+$/`                                                           | Parses Slack app id out of the app-level token                      | a     | —                                        |
| http/install-slack.ts:80                  | `transport === 'http' && args.shareable === true`                                                     | Coerces shareable off for socket bots at the single seam            | b     | `multiAgentShareable` + `ingress`        |
| http/install-slack.ts:90                  | `platform: 'slack'` on bot create                                                                     | Hard-coded platform in the shared Slack install tail                | c     | `installRoutes`                          |
| http/install-slack.ts:125                 | `if (transport === 'http') { await deps.httpBot.syncBot(botId) }`                                     | Ingress choice forks daemon-push vs relay-assign                    | b     | `ingress`                                |
| http/install-feishu.ts:53                 | `integration.platform !== 'feishu'`                                                                   | Reserved-id reuse guard on the Feishu install tail                  | c     | `installRoutes`                          |
| http/install-feishu.ts:65                 | `feishuAppId: appId, feishuRegion: region`                                                            | Writes two Feishu-only Bot columns                                  | b     | per-platform JSON bag (D6) + `regions[]` |
| http/install-feishu.ts:82                 | `botToken: appSecret, appToken: appId`                                                                | Feishu overloads the two-slot secret row                            | b     | `credentialShape: 'appId+appSecret'`     |
| http/install-feishu.ts:103                | `if (transport === 'http') { await deps.httpBot.syncBot(botId) }`                                     | Same ingress fork, duplicated per platform                          | b     | `ingress`                                |
| http/server.ts:201                        | `await api.register(slackOauthCallbackRoutes(deps))`                                                  | Unauthenticated Slack callback mounted at version root              | c     | `installRoutes`                          |
| http/server.ts:230                        | `scope.register(integrationRoutes/feishuRegistrationRoutes/slackInstallRoutes/...)`                   | Four platform-specific route plugins wired by name                  | c     | `installRoutes`                          |

#### 1.7 Bots routes, `Bot` demux, reconciler + reapers

| file:line                                        | predicate (short excerpt)                                                          | what it does (≤15 words)                                     | class | implied manifest field / provider facet |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- | --------------------------------------- |
| http/routes/bots.ts:40                           | `slackAppId: b.slackAppId, discordAppId: ..., feishuAppId: ...`                    | Three per-platform display ids on one DTO mapper             | b     | per-platform JSON bag (D6)              |
| http/routes/bots.ts:53                           | `teamId: b.teamId`                                                                 | Slack tenant demux id exposed generically                    | b     | `identityScope: 'tenant'`               |
| http/routes/bots.ts:69                           | `slackAppLinks(appId, teamId)` → `api.slack.com/apps/...`                          | Builds Slack console deep links                              | c     | `consoleLinks`                          |
| http/routes/bots.ts:151                          | `if (bot.platform !== 'slack')`                                                    | Refuses manifest refresh for non-Slack bots                  | c     | `providerToolingCredentials`            |
| http/routes/bots.ts:156                          | `if (!bot.slackAppId)`                                                             | Refresh needs the Slack app identity column                  | b     | `identityScope`                         |
| http/routes/bots.ts:174                          | `deps.verifySlackBot?.(secret.botToken)`                                           | auth.test identity verification before mutating the manifest | a     | —                                       |
| http/routes/bots.ts:191                          | `api.exportApp(...)` / `api.updateApp(...)`                                        | Slack config-token manifest export/merge/update              | a     | —                                       |
| http/routes/bots.ts:205                          | `bot.transport === 'http' ? relayHttpBase(...) : null`                             | HTTP bots get relay request_urls in the manifest             | b     | `ingress`                               |
| http/routes/bots.ts:225                          | `SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope))`                          | Computes missing Slack OAuth scopes                          | a     | —                                       |
| orchestrator/slackBotIdentityReconciler.ts:30    | `const SLACK_APP_ID = /^A[A-Z0-9]+$/`                                              | Slack id-shape regexes in a background loop                  | c     | `identityReconciler`                    |
| orchestrator/slackBotIdentityReconciler.ts:77    | `for (const bot of await this.bots.listSlackMissingIdentity())`                    | Slack-only background identity backfill loop                 | c     | `identityReconciler`                    |
| orchestrator/slackBotIdentityReconciler.ts:81    | `await this.resolveIdentity(secret.botToken)`                                      | Calls Slack to resolve app/workspace identity                | a     | —                                       |
| persistence/repositories/integration.repo.ts:139 | `where: { platform: 'slack', OR: [{ transport: 'http', slackAppId: null }, ...] }` | Platform-keyed Prisma query feeding the reconciler           | c     | `identityReconciler`                    |
| persistence/repositories/integration.repo.ts:473 | `...(platform === 'slack' && i.bot.slackAppId ? { botAppId } : {})`                | Slack-only field on the channel-placement record             | b     | `identityScope`                         |
| orchestrator/slackInstallReaper.ts:45            | `private readonly label = 'slack-install'`                                         | One reaper class relabelled for three platform funnels       | c     | `pendingInstallReaper`                  |
| container.ts:914                                 | `new SlackInstallReaper(repos.slackPlatformInstall, ...)`                          | Second/third reaper instances for platform-app + Feishu      | c     | `pendingInstallReaper`                  |
| container.ts:970                                 | `new SlackBotIdentityReconciler(...)`                                              | Slack-only reconciler wired into the container graph         | c     | `identityReconciler`                    |

#### 1.8 WS handlers

| file:line                             | predicate (short excerpt)                                                                   | what it does (≤15 words)                               | class | implied manifest field / provider facet |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- | --------------------------------------- |
| ws/handlers/event-session.ts:33       | `p.platform === 'webchat' && p.channel`                                                     | Webchat conversation-owner lookup for classification   | d     | —                                       |
| ws/handlers/event-session.ts:56       | `: p.platform === 'hook' ? p.channel`                                                       | Hook trigger id recovered from the channel field       | d     | —                                       |
| ws/handlers/event-session.ts:60       | `hook?.kind === 'github' && hook.agentId === agentId`                                       | Legacy GitHub-hook external-origin candidate           | d     | github-webhook seam                     |
| ws/handlers/event-session.ts:70       | `(p.platform === 'slack' \|\| p.platform === undefined)`                                    | Legacy mixed-version Slack milestones stay fail-closed | d     | legacy `platform IS NULL` ⇒ slack       |
| ws/handlers/event-session.ts:117      | `bot?.platform === 'feishu' ? (bot.feishuRegion ?? 'feishu') : undefined`                   | Region needed to build the Feishu realm key            | b     | `regions[]`                             |
| ws/handlers/event-session.ts:120      | `origin.provider === 'feishu' ? \`${region}:${appId}\` : (bot?.workspaceId ?? bot?.teamId)` | Two different realm-key compositions in core           | c     | `externalScopeRealmKey`                 |
| ws/handlers/channel-agents.ts:87      | `if (channel !== undefined && isSessionIdentityPlatform(platform)) return []`               | webchat/hook/dream short-circuit to an empty roster    | d     | —                                       |
| ws/handlers/integration-channels.ts:5 | `// platform that cannot enumerate its chats reports authoritative:false`                   | Enumeration capability arrives as a wire flag          | b     | `membershipEnumeration`                 |

#### 1.9 Session-audience resolvers, viewer identity, policy

| file:line                                         | predicate (short excerpt)                                                        | what it does (≤15 words)                                 | class | implied manifest field / provider facet |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | ----- | --------------------------------------- |
| http/viewer-identity.ts:50                        | `identitySet.add(\`slack:${slack.teamId}:${slack.userId}\`)`                     | Three-part Slack viewer identity composed in core        | c     | `viewerIdentityKeys`                    |
| http/viewer-identity.ts:57                        | `identitySet.add(\`feishu:${region}:${app.appId}:${openId}\`)`                   | Four-part Feishu identity — different arity from Slack   | c     | `viewerIdentityKeys`                    |
| domain/session-visibility.ts:65                   | `` `${platform}:${transportScope}:${triggeredBy}` ``                             | Generic three-part owner identity assumes tenant scoping | b     | `identityScope`                         |
| domain/session-visibility.ts:90                   | `if (input.platform === 'webchat')`                                              | Webchat sessions classified private with console owner   | d     | —                                       |
| domain/session-visibility.ts:102                  | `if (input.platform === 'hook' \|\| isAutomationTrigger(...))`                   | Hook/automation sessions classified org, ownerless       | d     | —                                       |
| http/session-access.ts:39                         | `const providers = ['slack','github','feishu'] as const`                         | Inline provider array drives every policy read           | c     | `sessionAudienceResolver`               |
| http/session-access.ts:44                         | `scopes.filter((s) => s.provider === 'slack' ...)` (+45, +46)                    | Three hand-partitioned scope buckets                     | c     | `sessionAudienceResolver`               |
| http/session-access.ts:55                         | `accessTokenFor: (region: 'feishu' \| 'lark')`                                   | Region-typed federated token accessor in core            | b     | `regions[]`                             |
| http/session-access.ts:125                        | `visibility === 'private' && session.externalProvider === 'feishu'`              | Feishu p2p private rows join external scope resolution   | b     | `sessionAudience.privateBaseline`       |
| authorization/policy.ts:103                       | `resource.visibility === 'external' \|\| (private && provider === 'feishu')`     | Same Feishu-only private baseline in the decision point  | b     | `sessionAudience.privateBaseline`       |
| http/slack-session-access.ts:41                   | `DEFINITIVE_DENIALS = new Set(['channel_not_found', ...])`                       | Slack API error codes classified deny vs unknown         | a     | —                                       |
| http/slack-session-access.ts:56                   | `/^slack:([^:]+):([^:]+)$/.exec(key)`                                            | Parses the Slack identity key shape                      | c     | `viewerIdentityKeys`                    |
| http/slack-session-access.ts:126                  | `scope.provider !== 'slack' \|\| scope.resourceKind !== 'conversation' \|\| ...` | Slack scope shape fence before any API call              | c     | `sessionAudienceResolver`               |
| http/slack-session-access.ts:135                  | `const realm = bot?.workspaceId ?? bot?.teamId`                                  | Slack realm key derived from two workspace columns       | b     | `identityScope: 'tenant'`               |
| http/slack-session-access.ts:175                  | `if (audience === 'public') { ... workspaceAccess ... }`                         | Slack public-vs-members audience algorithm               | a     | —                                       |
| http/slack-session-access.ts:188                  | `if (member !== 'allow' \|\| principal.teamId === scope.realmKey)`               | Slack Connect cross-workspace home-team re-check         | a     | —                                       |
| http/feishu-session-access.ts:7                   | `const REGION_ORIGIN: Record<FeishuRegion,string>`                               | Region→API origin map for the audience resolver          | b     | `regions[].apiBaseUrl`                  |
| http/feishu-session-access.ts:101                 | `scope.provider !== 'feishu' \|\| ...`                                           | Feishu scope shape fence                                 | c     | `sessionAudienceResolver`               |
| http/feishu-session-access.ts:110                 | `bot?.platform === 'feishu' ? (bot.feishuRegion ?? 'feishu') : undefined`        | Region default inside audience resolution                | b     | `regions[]`                             |
| http/feishu-session-access.ts:119                 | `scope.realmKey !== \`${region}:${appId}\``                                      | App-scoped (not tenant-scoped) realm identity            | b     | `identityScope: 'app'`                  |
| http/feishu-session-access.ts:142                 | `/open-apis/im/v1/chats/.../members/is_in_chat`                                  | Feishu membership probe API call                         | a     | —                                       |
| http/github-session-access.ts:79                  | `scope.provider !== 'github'`                                                    | GitHub audience resolver shares the same seam            | d     | github-webhook seam                     |
| http/routes/sessions.ts:293                       | `session.externalProvider !== 'feishu' \|\| !session.externalScopeId`            | Splits Feishu region back out of the realm key           | b     | `regions[]`                             |
| http/routes/sessions.ts:353                       | `type ExternalAccessProvider = 'slack' \| 'github' \| 'feishu'`                  | Closed provider union in the sessions route              | c     | `sessionAudienceResolver`               |
| http/routes/sessions.ts:355                       | `if (provider === 'feishu') { ... feishuPlatformApps ... }`                      | Feishu availability needs three extra deps               | c     | `sessionAudienceResolver`               |
| http/routes/sessions.ts:385                       | `provider === 'slack' ? 'Slack' : ... : 'Feishu/Lark'`                           | Hard-coded display labels and operationId fragments      | b     | `displayName`                           |
| http/routes/sessions.ts:437                       | `registerExternalAccessRoutes('slack'/'github'/'feishu')`                        | Three explicit registrations instead of a registry loop  | c     | `sessionAudienceResolver`               |
| persistence/repositories/session-access-sql.ts:51 | `AND ${s}."externalProvider" = 'feishu'`                                         | Feishu private baseline expressed again in SQL           | b     | `sessionAudience.privateBaseline`       |
| persistence/repositories/session.repo.ts:1250     | `AND s."externalProvider" = 'feishu'`                                            | Third spelling of the same Feishu baseline               | b     | `sessionAudience.privateBaseline`       |

#### 1.10 Core special cases — webchat / hook / dream / legacy-slack / github seam

| file:line                                                   | predicate (short excerpt)                                                                | what it does (≤15 words)                               | class | implied manifest field / provider facet |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- | --------------------------------------- |
| persistence/platform.ts:19                                  | `p === 'webchat' \|\| p === 'hook' \|\| p === 'dream'`                                   | The canonical origin-kind predicate                    | d     | —                                       |
| persistence/platform.ts:26                                  | `if (isSessionIdentityPlatform(p)) throw new Error(...)`                                 | Throws when a non-chat platform reaches persistence    | d     | —                                       |
| http/conversation-key.ts:20                                 | `if (key.platform === 'webchat') return key.channel`                                     | Webchat conversation keys skip the codec               | d     | —                                       |
| http/conversation-key.ts:30                                 | `if (UUID_RE.test(raw)) return { platform: 'webchat', ..., thread: \`webchat:${raw}\` }` | UUID shape implies webchat on decode                   | d     | —                                       |
| persistence/repositories/session.repo.ts:156                | `platform === 'slack' ? { OR: [{platform:'slack'},{platform:null}] } : { platform }`     | Legacy NULL platform rows read as Slack                | d     | —                                       |
| persistence/repositories/session.repo.ts:196                | `(${a}."platform" = 'slack' OR ${a}."platform" IS NULL)`                                 | Same rule in raw SQL                                   | d     | —                                       |
| persistence/repositories/session.repo.ts:208                | `${a}."platform" = 'hook' AND ...`                                                       | Hook trigger-id SQL family                             | d     | —                                       |
| persistence/repositories/session.repo.ts:222                | `platform = 'hook' AND ${hookTriggerSql(githubHookIds)}`                                 | GitHub-hook session predicate                          | d     | github-webhook seam                     |
| persistence/repositories/session.repo.ts:242                | `if (q.integration === 'github') return githubHookSql(...)`                              | 'github' is an integration filter with no platform     | d     | github-webhook seam                     |
| persistence/repositories/session.repo.ts:243                | `if (q.integration === 'hook') return genericHookSql(...)`                               | 'hook' likewise                                        | d     | —                                       |
| persistence/repositories/session.repo.ts:307                | `CASE WHEN ${githubHookSql} THEN 'github' WHEN platform IS NULL THEN 'slack' ...`        | Facet CASE mixing github seam and slack legacy         | d     | github-webhook seam                     |
| persistence/repositories/session.repo.ts:323                | `COALESCE(${a}."platform",'slack') = COALESCE(${b}."platform",'slack')`                  | Conversation-key join defaults NULL to slack           | d     | —                                       |
| persistence/repositories/session.repo.ts:334                | `[row.platform ?? 'slack', ...].join('�')`                                               | In-process mirror of the same default                  | d     | —                                       |
| persistence/repositories/session.repo.ts:699                | `ev.platform === 'webchat' && ev.channel && UUID_RE.test(...)`                           | Webchat conversation lock ordering at milestone write  | d     | —                                       |
| persistence/repositories/session.repo.ts:987                | `SELECT DISTINCT COALESCE(s."platform",'slack'), ...`                                    | Grouping query repeats the slack default               | d     | —                                       |
| persistence/repositories/session.repo.ts:1084               | `AND COALESCE(s."platform",'slack') = ${key.platform}`                                   | Key-addressed resolver repeats it again                | d     | —                                       |
| persistence/repositories/session.repo.ts:1219               | `AND s."platform" = 'webchat'`                                                           | Webchat current-session fence in SQL                   | d     | —                                       |
| persistence/repositories/webchat-mcp-operation.repo.ts:63   | `AND active_session."platform" = 'webchat'`                                              | Webchat MCP operation fence                            | d     | —                                       |
| persistence/repositories/webchat-mcp-operation.repo.ts:213  | `AND active_session."platform" = 'webchat'`                                              | Same fence, second query                               | d     | —                                       |
| http/routes/sessions.ts:47                                  | `z.enum(['slack','telegram','webchat','discord','feishu','hook','dream'])`               | Query enum mixes chat platforms and origin kinds       | d     | —                                       |
| http/routes/sessions.ts:106                                 | `query.integration === 'github' \|\| query.integration === 'hook'`                       | Hook-id prefetch gate                                  | d     | github-webhook seam                     |
| http/routes/sessions.ts:119                                 | `(s.platform === 'hook' ? s.channel : '')`                                               | Legacy headless hook id fallback                       | d     | —                                       |
| http/routes/sessions.ts:124                                 | `platform: s.platform ?? 'slack'`                                                        | Slack default in the relation mapper                   | d     | —                                       |
| http/routes/sessions.ts:177                                 | `platform === 'hook' && hook?.kind === 'github' ? 'github' : platform`                   | Synthesizes a 'github' pseudo-platform for the console | d     | github-webhook seam                     |
| http/routes/sessions.ts:188                                 | `s.platform === 'hook' ? (hookName ?? ...)`                                              | Hook name replaces channel name                        | d     | —                                       |
| http/routes/sessions.ts:685                                 | `s.platform === 'webchat' && s.channel`                                                  | Webchat conversation id extraction                     | d     | —                                       |
| http/mcp/tools.ts:202                                       | `z.enum(['slack','telegram','webchat','discord','hook','dream'])`                        | MCP listSessions enum — **omits `feishu`**             | d     | —                                       |
| persistence/ports.ts:1084                                   | `// NULL-platform rows read as 'slack'`                                                  | ConversationKey contract encodes the legacy default    | d     | —                                       |
| persistence/ports.ts:3836                                   | `type OrganizationArtifactSource = 'manual' \| 'dream'`                                  | Dream-origin artifacts                                 | d     | —                                       |
| persistence/repositories/organization-knowledge.repo.ts:543 | `source: 'dream'`                                                                        | Dream-sourced knowledge writes                         | d     | —                                       |

#### 1.11 Cron / hook `targetPlatform`

| file:line                                 | predicate (short excerpt)                                         | what it does (≤15 words)                            | class | implied manifest field / provider facet |
| ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | ----- | --------------------------------------- |
| http/routes/crons.ts:48                   | `targetPlatform: toDbPlatform(c.targetPlatform)`                  | Narrows protocol→DB platform on read                | d     | —                                       |
| http/routes/crons.ts:153                  | `let targetPlatform = req.body.targetPlatform`                    | Closed 4-platform value from the body               | b     | registry-derived `PlatformId` set       |
| http/routes/crons.ts:164                  | `targetPlatform = toDbPlatform(integ.platform)`                   | Derives target platform from the chosen integration | d     | —                                       |
| http/routes/hooks.ts:73                   | `targetPlatform: toDbPlatform(h.targetPlatform)`                  | Same narrowing on hook read                         | d     | —                                       |
| http/routes/hooks.ts:287                  | `targetPlatform: 'slack' \| 'telegram' \| 'discord' \| 'feishu'`  | Closed union inline in `resolveTarget`              | b     | registry-derived `PlatformId` set       |
| http/routes/hooks.ts:298                  | `toDbPlatform(integ.platform)`                                    | Derive-from-integration branch                      | d     | —                                       |
| hooks/hook.service.ts:93                  | `platform: toDbPlatform(hook.targetPlatform)`                     | Narrowing on the hook wire push                     | d     | —                                       |
| persistence/repositories/cron.repo.ts:32  | `targetPlatform: c.targetPlatform as Platform`                    | Unchecked cast from DB string                       | b     | registry-derived `PlatformId` set       |
| persistence/repositories/cron.repo.ts:64  | `toDbPlatform(input.targetPlatform ?? 'slack')`                   | Slack default on cron write                         | d     | —                                       |
| persistence/repositories/hook.repo.ts:100 | `targetPlatform: h.targetPlatform as Platform`                    | Unchecked cast from DB string                       | b     | registry-derived `PlatformId` set       |
| persistence/repositories/hook.repo.ts:454 | `toDbPlatform(input.targetPlatform ?? 'slack')`                   | Slack default on hook write                         | d     | —                                       |
| http/mcp/tools.ts:365                     | `targetPlatform: z.enum(['slack','telegram','discord','feishu'])` | Fourth copy of the closed platform enum             | b     | registry-derived `PlatformId` set       |

#### 1.12 Daemon capability gate, provider dep slots, env

| file:line                             | predicate (short excerpt)                                                   | what it does (≤15 words)                             | class | implied manifest field / provider facet |
| ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- | ----- | --------------------------------------- |
| http/daemon-platform-capability.ts:13 | `type IntegrationPlatform = 'slack' \| 'telegram' \| 'discord' \| 'feishu'` | Fifth copy of the closed platform id union           | b     | registry-derived `PlatformId` set       |
| http/daemon-platform-capability.ts:27 | `daemon.capabilities.platforms.includes(input.platform)`                    | Pre-install gate on daemon-declared platform support | b     | `ingress` / registry handshake          |
| ports.ts:137                          | `platforms: string[]`                                                       | Daemon capability carries platform ids as strings    | b     | registry-derived `PlatformId` set       |
| http/deps.ts:292                      | `verifySlackBot?: SlackBotVerifier` (+295, 299)                             | Three Slack-named optional dep slots on core deps    | c     | CP provider slot                        |
| http/deps.ts:307                      | `verifyTelegramBot: TelegramBotVerifier` (+310)                             | Two Telegram-named dep slots                         | c     | CP provider slot                        |
| http/deps.ts:314                      | `verifyDiscordBot?` (+317, 320)                                             | Three Discord-named dep slots                        | c     | CP provider slot                        |
| http/deps.ts:325                      | `verifyFeishuBot?` (+328, 331, 335)                                         | Four Feishu-named dep slots                          | c     | CP provider slot                        |
| http/deps.ts:346                      | `slackSessionAccess? / githubSessionAccess? / feishuSessionAccess?`         | Three named audience resolvers on core deps          | c     | `sessionAudienceResolver`               |
| http/deps.ts:354                      | `feishuPlatformApps?: FeishuPlatformApps`                                   | Region-keyed platform app config on core deps        | b     | `regions[]`                             |
| http/deps.ts:364                      | `slackPlatformApp?: SlackPlatformAppConfig`                                 | Slack platform app config on core deps               | c     | `envSchema`                             |
| container.ts:819                      | `verifySlackBot, verifySlackAppToken, slackConfigApi,`                      | Twelve per-platform functions wired positionally     | c     | CP provider registry                    |
| container.ts:828                      | `verifyFeishuBot, configureFeishuHttpApp, syncFeishuAppIcon,`               | Feishu block of the same wiring                      | c     | CP provider registry                    |
| container.ts:477                      | `resolveSlackPlatformAppConfig(config)`                                     | Slack env config resolution                          | c     | `envSchema`                             |
| container.ts:478                      | `resolveFeishuPlatformApps(config)`                                         | Feishu/Lark env config resolution                    | c     | `envSchema`                             |
| config/feishu-platform.ts:21          | `['feishu','FEISHU_PLATFORM_APP_ID','FEISHU_PLATFORM_APP_SECRET']`          | Region→env-var-name table                            | c     | `envSchema`                             |
| config/env.ts:114                     | `SLACK_PLATFORM_APP_ID / CLIENT_ID / CLIENT_SECRET / SIGNING_SECRET`        | Four Slack-named env vars in the core schema         | c     | `envSchema`                             |
| config/env.ts:121                     | `FEISHU_PLATFORM_APP_ID ... LARK_PLATFORM_APP_SECRET`                       | Four Feishu/Lark env vars in the core schema         | c     | `envSchema`                             |
| config/env.ts:32                      | `SLACK_INSTALL_TTL_SEC / SLACK_INSTALL_REAP_INTERVAL_SEC`                   | Slack-named reaper knobs used by three funnels       | c     | `pendingInstallReaper`                  |

#### 1.13 Platform API / identity modules and the region axis

| file:line                                                   | predicate (short excerpt)                                              | what it does (≤15 words)                                 | class | implied manifest field / provider facet |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | ----- | --------------------------------------- |
| http/slack-identity.ts:117                                  | `teamId: body.team_id ?? null`                                         | auth.test response mapping                               | a     | —                                       |
| http/discord-identity.ts:28                                 | `export function discordAppIdFromBotToken(botToken)`                   | Decodes Discord app id from token segment                | a     | —                                       |
| http/feishu-identity.ts:38                                  | `const REGION_BASE: Record<FeishuRegion,string>`                       | Region→gateway base URL map                              | b     | `regions[].apiBaseUrl`                  |
| http/feishu-identity.ts:48                                  | `verifyFeishuBot = async (appId, appSecret, region = 'feishu')`        | tenant-access-token + bot/v3/info validation             | a     | —                                       |
| http/feishu-app-config.ts:12                                | `const REGION_ORIGIN: Record<FeishuRegion,string>`                     | Third copy of the region→origin map                      | b     | `regions[].apiBaseUrl`                  |
| http/slack-config-api.ts:30                                 | `/** ... key (Bot.teamId); the per-app funnel has no use for it. */`   | Slack config/OAuth API client                            | a     | —                                       |
| http/logto-federated-token.ts:7                             | `type LogtoFederatedTarget = 'feishu' \| 'lark'`                       | Region doubles as a federated-token target               | b     | `regions[]`                             |
| github/logto-identity.ts:140                                | `region: 'feishu' \| 'lark'`                                           | FeishuIdentity carries the region                        | b     | `regions[]`                             |
| github/logto-identity.ts:150                                | `SLACK_CLAIM = { teamId: 'https://slack.com/team_id', ... }`           | Slack namespaced OIDC claim map                          | c     | `viewerIdentityKeys`                    |
| github/logto-identity.ts:263                                | `summarize(target, identity, target === 'slack' ? slack : null)`       | Slack special-cased when summarizing linked identities   | c     | `viewerIdentityKeys`                    |
| github/logto-identity.ts:522                                | `if (target === 'slack') return slack?.teamDomain ? ... : null`        | Slack profile URL construction                           | c     | `consoleLinks`                          |
| github/logto-identity.ts:586                                | `for (const region of ['feishu','lark'] as const)`                     | Iterates the two Feishu regions as Logto connectors      | b     | `regions[]`                             |
| http/routes/me-social-identities.ts:43                      | `teamId: z.string()`                                                   | Slack workspace exposed on the profile DTO               | c     | `viewerIdentityKeys`                    |
| persistence/repositories/feishu-app-registration.repo.ts:20 | `value === 'feishu' \|\| value === 'lark' ? value : null`              | Region parse/guard at the persistence boundary           | b     | `regions[]`                             |
| registry/waitlistService.ts:21                              | `platform: ('slack' \| 'telegram' \| 'discord')[]`                     | Waitlist intake hard-codes three platforms               | b     | registry-derived `PlatformId` set       |
| http/feishu-registration-provider.ts:31                     | `user_info?: { tenant_brand?: FeishuRegion }`                          | Provider reports the resolved region                     | b     | `regions[]`                             |
| http/feishu-registration.ts:42                              | `fallbackRegion: FeishuRegion`                                         | Region fallback carried through the durable registration | b     | `regions[]`                             |
| persistence/ports.ts:2344                                   | `slackAppId? / teamId? / discordAppId? / feishuAppId? / feishuRegion?` | Five per-platform optional fields on `CreateBotInput`    | b     | per-platform JSON bag (D6)              |
| persistence/ports.ts:2399                                   | `discordAppId: string \| null; feishuAppId: ...; feishuRegion: ...`    | Same five on `BotRecord`                                 | b     | per-platform JSON bag (D6)              |
| persistence/ports.ts:2968                                   | `feishuRegion?: FeishuRegion // only set for platform 'feishu'`        | Feishu-only field on `IntegrationRecord`                 | b     | `regions[]`                             |

### 2. Per-class counts

| class                                                                               | count   |
| ----------------------------------------------------------------------------------- | ------- |
| (a) transport — moves into the CP platform provider                                 | **26**  |
| (b) manifest capability — pre-dispatch / install-time declarative value             | **91**  |
| (c) adapter strategy / CpPlatformProvider facet                                     | **75**  |
| (d) core special case — webchat / hook / dream / github-webhook seam / legacy-slack | **47**  |
| **total classified rows**                                                           | **239** |

Distinct implied **manifest fields** derived (not guessed) from the (b) rows:
`credentialShape`, `identityScope` (`'tenant'` for Slack, `'app'` for Feishu), `multiAgentShareable`, `ingress`, `membershipEnumeration`, `leaveGranularity`, `regions[]` (with `apiBaseUrl`/`portalBaseUrl`), `avatar.perMessageIconUrl`, `avatar.botProfilePush` (new — Telegram/Discord/Feishu accept an avatar, Slack does not), `displayName`, `sessionAudience.privateBaseline` (new — the Feishu p2p private-baseline exception, spelled three times), registry-derived `PlatformId` set (replacing six hand-copied closed unions).

Distinct **provider facets** derived from the (c) rows:
`installRoutes`, `credentialBodySchema`, `validateConfig`, `sideEffects.postCreate` / `sideEffects.iconSync`, `projectIntegrationConfig`, `projectBotAssign`, `pendingInstallReaper`, `identityReconciler` (new — the Slack bot-identity background loop + its platform-keyed Prisma query), `providerToolingCredentials`, `sessionAudienceResolver` (new), `viewerIdentityKeys` (new — identity-tuple arity differs: Slack 3-part, Feishu 4-part), `externalScopeRealmKey` (new), `consoleLinks` (new), `envSchema`.

### 3. Data-model inventory (`packages/control-plane/prisma/schema.prisma`)

| schema:line               | element                                                                    | notes                                                                               |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| prisma/schema.prisma:772  | `enum Platform { slack telegram discord feishu }`                          | The persisted, closed chat-platform enum (D3 target)                                |
| prisma/schema.prisma:788  | `Assignment.platform Platform`                                             | Placement key column                                                                |
| prisma/schema.prisma:1299 | `SecretLease.scopePlatform Platform`                                       | Secret-lease scope                                                                  |
| prisma/schema.prisma:1328 | `CronDef.targetPlatform Platform @default(slack)`                          | Slack default baked into the column                                                 |
| prisma/schema.prisma:1468 | `HookDef.targetPlatform Platform @default(slack)`                          | Same                                                                                |
| prisma/schema.prisma:1694 | `Bot.platform Platform @default(slack)`                                    | Slack default on bot identity                                                       |
| prisma/schema.prisma:1697 | `Bot.slackAppId String?`                                                   | D6 → `externalAppId`                                                                |
| prisma/schema.prisma:1703 | `Bot.teamId String?`                                                       | D6 → `externalTenantId`; load-bearing demux half                                    |
| prisma/schema.prisma:1709 | `Bot.workspaceId / workspaceName`                                          | Display-only, deliberately distinct from `teamId`                                   |
| prisma/schema.prisma:1714 | `Bot.botUserId String?`                                                    | Slack bot user id, echo suppression                                                 |
| prisma/schema.prisma:1717 | `Bot.revokedAt DateTime?`                                                  | Slack `app_uninstalled` / `tokens_revoked` marker                                   |
| prisma/schema.prisma:1724 | `Bot.credentialRevision Int @default(1)` + `credentialInstalledAt`         | Slack-ordering-driven generation fence                                              |
| prisma/schema.prisma:1727 | `Bot.discordAppId String?`                                                 | Display-only → per-platform JSON bag                                                |
| prisma/schema.prisma:1728 | `Bot.feishuAppId String?`                                                  | Display-only → per-platform JSON bag                                                |
| prisma/schema.prisma:1729 | `Bot.feishuRegion String?`                                                 | Region axis; NULL ⇒ `'feishu'`; durable across uninstall                            |
| prisma/schema.prisma:1741 | `Bot.shareable Boolean @default(false)`                                    | `multiAgentShareable` realized as a row flag                                        |
| prisma/schema.prisma:1746 | `Bot.transport SlackTransport @default(socket)`                            | Enum name is Slack-branded but platform-generic                                     |
| prisma/schema.prisma:1757 | `@@unique([slackAppId, teamId])`                                           | The `workspace_taken` fence — a declarative constraint JSON can't carry             |
| prisma/schema.prisma:1765 | `enum SlackTransport { socket http }`                                      | Historical Slack name retained to avoid a destructive rename                        |
| prisma/schema.prisma:1822 | `Integration.platform Platform @default(slack)`                            | Slack default on integration rows                                                   |
| prisma/schema.prisma:1828 | `Integration.feishuRegion String?`                                         | Region duplicated onto the integration row                                          |
| prisma/schema.prisma:1915 | `model SlackInstall`                                                       | Funnel #1 state: appId/clientId/clientSecret/botToken/transport/signingSecret       |
| prisma/schema.prisma:1944 | `model SlackPlatformInstall`                                               | Funnel #2 state: status/failureReason/botId; no per-app creds (env-driven)          |
| prisma/schema.prisma:1971 | `enum SlackPlatformInstallStatus { pending completed failed }`             | Terminal-state enum for funnel #2 only                                              |
| prisma/schema.prisma:1984 | `model FeishuAppRegistration`                                              | Funnel #3 state: device flow, `targetKey @unique`, pre-reserved bot/integration ids |
| prisma/schema.prisma:2020 | `enum FeishuAppRegistrationStatus { pending authorized completed failed }` | Four states vs funnel #2's three — structurally different                           |
| prisma/schema.prisma:2037 | `model SlackUserConfig`                                                    | Per-user Slack App Configuration token (`providerToolingCredentials`)               |
| prisma/schema.prisma:911  | `SessionMeta.externalProvider String?`                                     | Open string (already not the `Platform` enum) — includes `'github'`                 |

Three funnels, three unrelated table shapes, three different terminal-state vocabularies, one shared reaper class relabelled three times (`orchestrator/slackInstallReaper.ts:45`).

### 4. Ambiguous rows

1. **`http/dto/index.ts:2087` / `:2165` — `targetPlatform: Platform.default('slack')`.** Read pre-dispatch (it routes the anchor), so (b), but the _value_ `'slack'` is a legacy core assumption, not a capability — it belongs in the D4 envelope rather than the manifest.
2. **`persistence/repositories/cron.repo.ts:64` / `hook.repo.ts:454` — `toDbPlatform(input.targetPlatform ?? 'slack')`.** Classified (d) as legacy-default core behaviour, but arguably a (b) registry default; the two spellings of the same default disagree with the DTO's `.default('slack')`.
3. **`http/dto/index.ts:1809` and `registry/waitlistService.ts:21` — waitlist platform arrays.** Never read before dispatch (pure applicant metadata), so strictly neither (b) nor (c); classified (b) only because they must track the registry's id set or drift.
4. **`http/routes/slack-platform-install.ts:109` — `presetAgent.get(orgId, 'general')`.** Core preset default-binding policy executing inside a platform-specific funnel; classified (c) `installRoutes`, but the preset lookup itself must stay in core and be handed to the provider.
5. **`orchestrator/httpBot.ts:485/516/532` — `source: 'console' | 'slack'`.** Post-dispatch UI provenance (the in-thread switch-agent control), so (c) by the D2 dividing rule — but it currently sits in a core orchestrator signature.
6. **`orchestrator/httpBot.ts:822-828` — the four-way platform ternary.** Pure identity mapping (`compiled.platform` already equals `bot.platform`); classified (c) `projectBotAssign` but it is dead code that disappears entirely under an open `PlatformId`.
7. **`http/routes/integrations.ts:572` — Feishu HTTP requires a resolved `openId`.** Install-time gating, which argues (b), but the value is fetched by a platform API call and stored for the relay, which argues (c)/(a); classified (c) because the _need_ is platform-mechanical, not declarative.
8. **`ws/handlers/event-session.ts:70` — `p.platform === 'slack' || p.platform === undefined`.** Mixed-version fail-closed handling; (d) as a legacy special case, but it will need a real manifest answer (`persistsPlacements` / origin-kind classification) once ids are open.
9. **`http/agent-bot-icon-sync.ts:58` — the three-way `supported` test.** Classified (b) `avatar.botProfilePush` since core reads it before deciding to act, but the whole loop could equally be a pure (c) facet with a no-op default.
10. **`http/routes/sessions.ts:385` — `'Slack' / 'GitHub' / 'Feishu/Lark'` labels + `operationLabel`.** (b) `displayName` for the copy, but the OpenAPI `operationId` fragment is a wire-compat constraint, so it cannot simply follow the manifest.
11. **`http/github-session-access.ts:79` and the `hook.kind === 'github'` family.** GitHub is a provider in the session-audience axis but not a `Platform` enum member; classified (d) github-webhook seam, though D5 promotes it to a Layer-2 platform.

### 5. Platform-conditionals outside the listed shapes

1. **Optional-dependency presence as the branch.** `http/agent-bot-icon-sync.ts:58-60` and `http/routes/integrations.ts:453,468,525` branch on _whether a per-platform function was injected_ (`deps.syncTelegramBotIcon`, `deps.verifyDiscordBot`, …). `http/deps.ts:292-364` declares twelve such slots and `container.ts:819-842` wires them — a grep for platform literals finds none of it.
2. **File and route existence as the branch.** `http/server.ts:201-207,230-235,271-273` mounts `slackOauthCallbackRoutes`, `slackPlatformCallbackRoutes`, `slackInstallRoutes`, `slackPlatformInstallRoutes`, `feishuRegistrationRoutes` by name; `http/routes/slack-platform-install.ts:53-56` and `slack-install.ts` self-disable via `if (!platform || !publicCpUrl) return`, so the platform branch is "the routes 404".
3. **Class reuse with a label string.** `orchestrator/slackInstallReaper.ts:45` (`private readonly label = 'slack-install'`) is instantiated three times (`container.ts:905/914/924`) for three different platform funnels — a per-platform loop with no platform literal in the class.
4. **Regex-shaped identity assumptions.** `orchestrator/slackBotIdentityReconciler.ts:30-31` (`/^A[A-Z0-9]+$/`, `/^T[A-Z0-9]+$/`), `http/install-slack.ts:26` (`appToken.split('-')[2]`), `http/slack-session-access.ts:56` (`/^slack:([^:]+):([^:]+)$/`), `http/conversation-key.ts:15` (UUID ⇒ webchat), and `ws/handlers/event-session.ts:74` (`!p.channel.startsWith('D')` = Slack DM-id convention) all encode platform id syntax with no platform literal.
5. **Template-literal identity composition of differing arity.** `http/viewer-identity.ts:50` builds `slack:<team>:<user>` (3 parts) while `:57` builds `feishu:<region>:<appId>:<openId>` (4 parts) — and `domain/session-visibility.ts:65` composes a generic 3-part `${platform}:${scope}:${uid}`, so a Feishu DM's ingest-side owner identity and the viewer-side identity are not the same shape.
6. **Constraint-level branching in SQL/Prisma.** `prisma/schema.prisma:1757` `@@unique([slackAppId, teamId])` is the actual `workspace_taken` fence; `http/routes/slack-platform-install.ts:291` only reports it. No TypeScript conditional expresses this rule.
7. **`SlackTransport` as a platform-neutral enum with a platform-branded name** (`prisma/schema.prisma:1765`, `persistence/ports.ts:2336`) — used by Feishu and every other platform; a rename is blocked by a destructive PostgreSQL enum migration.
8. **Out-of-scope but adjacent:** `agent.workspace.mode === 'github'` (≈40 hits) is the _git workspace_ axis, not a chat platform; excluded from the taxonomy. The `hook.kind === 'github'` family (`hooks/hook.service.ts:77-79`, `http/routes/hooks.ts:363-365`, `orchestrator/hookRedeliveryReconciler.ts:193`) _is_ the github-webhook seam and is classified (d) where it touches session/platform identity.

**One likely bug found in passing:** `http/mcp/tools.ts:202` — the `listSessions` platform enum is `['slack','telegram','webchat','discord','hook','dream']`, missing `'feishu'`, while the HTTP route's equivalent (`http/routes/sessions.ts:47`) includes it. An MCP client cannot filter Feishu sessions.

---

## Appendix D — `packages/web/src`

### 1. Classification table

#### `components/console/modals/AddIntegrationModal.tsx` (wizard blocks grouped)

| file:line                         | predicate (short excerpt)                                                                                               | what it does (≤15 words)                                                  | class | implied manifest field / module facet                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----- | -------------------------------------------------------- |
| AddIntegrationModal.tsx:85-86     | `type BotPlatform = 'slack' \| 'telegram' \| 'discord' \| 'feishu'`                                                     | Closed four-platform union typing the whole modal                         | b     | `id` (must become open `PlatformId`)                     |
| AddIntegrationModal.tsx:94-105    | `BOT_PLATFORMS = [{key:'slack',label:'Slack'},…]`                                                                       | Static tile registry + display labels; `PLATFORMS` appends webhook/github | b     | `id`, `displayName` (registry)                           |
| AddIntegrationModal.tsx:112-119   | `PLATFORM_INSTALL_FAILURES: Record<string,string>`                                                                      | Slack platform-install failure-reason copy                                | c     | wizard Body copy / apiBindings error map                 |
| AddIntegrationModal.tsx:121-127   | `FEISHU_REGISTRATION_FAILURES`                                                                                          | Feishu one-click registration failure copy                                | c     | wizard Body copy                                         |
| AddIntegrationModal.tsx:154-166   | `IM_INVITE_HINT = { slack, telegram, discord }`                                                                         | Per-platform "invite the bot to a channel/group" hint                     | c     | marketing/help copy                                      |
| AddIntegrationModal.tsx:171-196   | `GUIDE: Record<'telegram'\|'discord',…>`                                                                                | Portal href, step text, token placeholder for two platforms               | c     | wizard Body                                              |
| AddIntegrationModal.tsx:198-256   | `TelegramPrivacyStatus({status})`                                                                                       | Telegram Privacy-Mode status banner + retry                               | c     | wizard Body                                              |
| AddIntegrationModal.tsx:260-293   | `FEISHU_COMMON_REQS` / `FEISHU_DELIVERY_REQS['socket'\|'http']`                                                         | Feishu app-scope checklist, keyed by transport                            | c     | wizard Body / copy                                       |
| AddIntegrationModal.tsx:328-331   | `TRANSPORT_LABEL: Record<'slack'\|'feishu',…>`                                                                          | Names which platforms even offer a transport choice                       | b     | `ingress: 'socket'\|'http'\|'both'`                      |
| AddIntegrationModal.tsx:337-371   | `function DeliveryLine({ platform: 'slack' \| 'feishu' })`                                                              | Renders/toggles inbound transport line                                    | c     | `affordances.transport` (reads `ingress`)                |
| AddIntegrationModal.tsx:378-415   | `function SlackManifestPreview()`                                                                                       | Slack "From a manifest" hover mock                                        | c     | wizard Body                                              |
| AddIntegrationModal.tsx:422-486   | `function SlackConfigTokenPreview()`                                                                                    | Slack config-token page hover mock                                        | c     | wizard Body                                              |
| AddIntegrationModal.tsx:613-622   | `function TelegramBar({icon,title})`                                                                                    | Telegram-branded mini-screen chrome                                       | c     | wizard Body                                              |
| AddIntegrationModal.tsx:636-760   | `const TG_STEPS: WalkthroughStep[]`                                                                                     | Three-step BotFather walkthrough                                          | c     | wizard Body / marketing copy                             |
| AddIntegrationModal.tsx:764-864   | `const DISCORD_STEPS: WalkthroughStep[]`                                                                                | Two-step Discord Developer Portal walkthrough                             | c     | wizard Body / marketing copy                             |
| AddIntegrationModal.tsx:872-973   | `feishuWalkthroughSteps(brand:'Feishu'\|'Lark', host)`                                                                  | Region-parameterized Feishu console walkthrough                           | c     | wizard Body; reads `regions[].displayName/portalBaseUrl` |
| AddIntegrationModal.tsx:1015-1018 | `feishuRegion` state; `feishuBrand = feishuRegion==='lark'?…`                                                           | Region axis drives every Feishu label                                     | b     | `regions`                                                |
| AddIntegrationModal.tsx:1027-1032 | `botIdentityCopy: Record<BotPlatform,{create,existing}>`                                                                | Per-platform create/reuse mode-card copy                                  | c     | wizard Body copy                                         |
| AddIntegrationModal.tsx:1049-1091 | `slackFunnel`, `autoUsable`, `createMethod`, `cfgAccess`, `install`, `platformAvailable`, `slackIdentity`               | Slack-only install state machine (7 states)                               | c     | wizard Body + apiBindings                                |
| AddIntegrationModal.tsx:1207-1209 | `BOT_PLATFORMS.filter(p => daemon.caps.platforms.includes(p.key))`                                                      | Gates tiles on daemon-advertised adapters                                 | b     | registry × daemon caps                                   |
| AddIntegrationModal.tsx:1212-1215 | `candidate === 'webhook' \|\| candidate === 'github' \|\| …`                                                            | Exempts webhook/github from adapter gating                                | d     | core special case                                        |
| AddIntegrationModal.tsx:1220-1265 | `pickPlatform` / caps effect reset `setFeishuVerificationToken('')` …                                                   | Resets every platform's sub-form fields on switch                         | c     | wizard Body (host reset seam)                            |
| AddIntegrationModal.tsx:1278-1285 | `b.platform === platform && (platform !== 'feishu' \|\| region match) && …`                                             | Free-bot reuse eligibility incl. Feishu region                            | c     | `freeBotFilter`                                          |
| AddIntegrationModal.tsx:1299-1301 | `slackChecking`/`slackBuiltin`/`hideIdentitySection`                                                                    | Hides the whole identity section for Slack built-in pane                  | c     | wizard Body                                              |
| AddIntegrationModal.tsx:1310-1311 | `platform === 'slack' && relayAvailable ? 'http' : 'socket'`                                                            | Default ingress transport per platform                                    | b     | `ingress` (default)                                      |
| AddIntegrationModal.tsx:1321-1326 | `shareToggleAvailable = platform === 'slack' && …transport==='http'`                                                    | Share opt-in is Slack-only and http-only                                  | b     | `multiAgentShareable` (+ `affordances.share`)            |
| AddIntegrationModal.tsx:1331-1339 | `slackBotOk = startsWith('xoxb-')`, `slackAppOk`, `slackSigningOk`, `telegramOk`                                        | Per-platform credential-format validators                                 | c     | wizard Body (shadow of `credentialShape`)                |
| AddIntegrationModal.tsx:1340-1374 | `telegramCheckEnabled = … platform === 'telegram' && telegramOk`                                                        | Debounced Telegram getMe/privacy probe via SWR                            | c     | apiBindings                                              |
| AddIntegrationModal.tsx:1375-1386 | `discordAppId = platform==='discord' ? discordApplicationIdFromToken(...)`; feishu `cli_` checks; `feishuCallbackUrl`   | Discord app-id decode, Feishu credential + callback URL                   | a     | transport mechanics in web helper                        |
| AddIntegrationModal.tsx:1388-1397 | `createValid = platform==='slack' ? … : platform==='telegram' ? … : platform==='feishu' ? …`                            | Four-way submit-validity ternary                                          | c     | wizard Body                                              |
| AddIntegrationModal.tsx:1401-1420 | `slackAppIdFromAppToken`, `slackManifestJson`, `slackCreateAppUrl`                                                      | Builds the Slack app manifest + create deep link                          | a     | `slack-manifest.ts` helper                               |
| AddIntegrationModal.tsx:1471-1581 | `if (platform !== 'github' \|\| gh !== null) return` (3 effects)                                                        | GitHub installation/repo-roster probes                                    | d     | core fragment (GitHub stays core)                        |
| AddIntegrationModal.tsx:1730-1807 | `submit()` — `platform === 'slack' ? {…} : platform === 'feishu' ? …`                                                   | Assembles per-platform `CreateIntegrationInput` (create + reuse)          | c     | `buildReuseInput` / create-input builder                 |
| AddIntegrationModal.tsx:1813-1863 | `saveConfigAndStart()` → `saveSlackConfig` + `startSlackInstall`                                                        | Stores Slack config token, mints app, opens OAuth                         | c     | apiBindings                                              |
| AddIntegrationModal.tsx:1867-1908 | `startAuto()` / `restartAuto()`                                                                                         | Slack auto-install start + abandon                                        | c     | apiBindings                                              |
| AddIntegrationModal.tsx:1913-1938 | `startFeishuAuto()` → `startFeishuRegistration`                                                                         | Feishu device-flow deeplink, synchronous blank tab                        | c     | apiBindings                                              |
| AddIntegrationModal.tsx:1943-1982 | `if (… platform !== 'feishu' \|\| feishuMethod !== 'deeplink' …) return`                                                | Feishu registration polling loop (2s)                                     | c     | install-polling hook                                     |
| AddIntegrationModal.tsx:1988-2007 | `finalizeAuto()` → `finalizeSlackInstall`                                                                               | Slack finalize; socket pastes xapp, http none                             | c     | apiBindings                                              |
| AddIntegrationModal.tsx:2014-2039 | `if (mode!=='create' \|\| platform!=='slack' \|\| slackFunnel!==null) return`                                           | Slack funnel/deployment capability probe                                  | c     | apiBindings                                              |
| AddIntegrationModal.tsx:2044-2061 | `if (mode!=='create' \|\| platform!=='feishu') return`                                                                  | Feishu relay-availability probe (reuses `/slack/config`)                  | c     | apiBindings                                              |
| AddIntegrationModal.tsx:2065-2108 | `startPlatformInstall()` + platform-install poll (2.5s)                                                                 | "Add to Slack" built-in app install + polling                             | c     | apiBindings / install-polling                            |
| AddIntegrationModal.tsx:2112-2129 | `if (… slackFunnel !== true \|\| autoPhase !== 'authorizing' …) return`                                                 | Polls Slack install until `bot_ready`                                     | c     | install-polling hook                                     |
| AddIntegrationModal.tsx:2142-2157 | `isAuto`/`isConfigSetup`/`isFeishuDeeplink`                                                                             | Per-platform footer-mode derivation                                       | c     | wizard Body                                              |
| AddIntegrationModal.tsx:2158-2179 | `footer = platform === 'webhook' ? … : platform === 'github' ? … : isAuto ? …`                                          | Footer primary action chosen per platform                                 | d     | chassis footer + core webhook/github arms                |
| AddIntegrationModal.tsx:2213-2233 | `candidate.key === 'github' ? <GithubMark/>` … `candidate.key === 'feishu' ? <LarkFeishuSwitcher/>`                     | Tile mark + region switcher special-cases                                 | c     | `Mark` / `regions`                                       |
| AddIntegrationModal.tsx:2238-2372 | `{platform === 'webhook' && …}` (two blocks)                                                                            | Webhook form + created-endpoint/HMAC/curl panes                           | d     | core special case                                        |
| AddIntegrationModal.tsx:2373-2821 | `{platform === 'github' && (…)}`                                                                                        | Whole GitHub repo/events/review wizard section                            | d     | core fragment (design §10)                               |
| AddIntegrationModal.tsx:2825-2866 | `{slackBuiltin && (…)}`                                                                                                 | Built-in "Add to Slack" pane + custom-identity disclosure                 | c     | wizard Body                                              |
| AddIntegrationModal.tsx:2867-2934 | `platform !== 'webhook' && platform !== 'github' && !hideIdentitySection`                                               | Bot-identity header + mode cards gated off core kinds                     | d     | chassis / core inverse gate                              |
| AddIntegrationModal.tsx:2989-3367 | `{mode === 'create' && platform === 'slack' && !slackBuiltin && (…)}`                                                   | Entire Slack create pane (config-token vs manifest methods)               | c     | wizard Body                                              |
| AddIntegrationModal.tsx:3368-3439 | `platform !== 'slack' && !== 'feishu' && !== 'webhook' && !== 'github'`; `platform==='telegram'?TG_STEPS:DISCORD_STEPS` | Shared Telegram/Discord create pane + walkthrough pick                    | c     | wizard Body                                              |
| AddIntegrationModal.tsx:3442-3470 | `{platform === 'discord' && (discordAppId ? … )}`                                                                       | "Add to Discord" invite button from decoded app id                        | a     | `discord-invite.ts` mechanics                            |
| AddIntegrationModal.tsx:3476-3699 | `{mode === 'create' && platform === 'feishu' && (…)}`                                                                   | Feishu create pane: deeplink/manual toggle, HTTP callback fields          | c     | wizard Body                                              |
| AddIntegrationModal.tsx:3591-3612 | `feishuRegion === 'lark' ? 'https://open.larksuite.com/…' : 'https://open.feishu.cn/…'`                                 | Region-specific developer-console host                                    | b     | `regions[].portalBaseUrl`                                |
| AddIntegrationModal.tsx:3700-3721 | `{platform === 'feishu' && (mode === 'existing' \|\| feishuMethod === 'manual')}`                                       | Feishu setup checklist pane                                               | c     | wizard Body                                              |
| AddIntegrationModal.tsx:3725-3734 | `platform === 'webhook' ? … : 'github' ? … : 'slack' ? … : 'feishu' ? …`                                                | Five-way footer hint copy                                                 | c     | marketing/help copy (+ d arms)                           |
| AddIntegrationModal.tsx:3765-3770 | `{!hideIdentitySection && !isFeishuDeeplink && <Button …>}`                                                             | Suppresses footer for Slack-builtin / Feishu-deeplink panes               | c     | wizard Body                                              |

#### `AddCronModal.tsx` — design §14 defect #2

| file:line                        | predicate                                                                            | what it does                                                     | class | facet                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----- | ------------------------------------------ |
| AddCronModal.tsx:73-77           | `interface Target { … platform: 'slack' \| 'telegram' }`                             | **Closed two-platform union for cron anchors**                   | b     | cron targeting (`OriginKind`×`PlatformId`) |
| AddCronModal.tsx:79              | `const HEADLESS: Target = { platform: 'slack' }`                                     | Headless fire defaults to `slack` sentinel                       | b     | fold-to-slack default                      |
| AddCronModal.tsx:141             | `platform: (i.platform === 'telegram' ? 'telegram' : 'slack') as Target['platform']` | **The coercion: Discord/Feishu anchors silently become `slack`** | b     | §6.8 cron/hook targeting                   |
| AddCronModal.tsx:150,161,169,198 | `` `${option.platform}:${option.channelId}` ``; `o.platform === target.platform`     | Dedupe/resolve keyed on the coerced platform                     | b     | same defect's blast radius                 |

#### `IntegrationChannelList.tsx` — channel-list semantics

| file:line                          | predicate                                                                        | what it does                                           | class | facet                                    |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- | ---------------------------------------- |
| IntegrationChannelList.tsx:207     | `canLeaveConversation = (platform) => platform === 'telegram'`                   | Only Telegram supports per-conversation bot self-leave | b     | `leaveGranularity: 'conversation'`       |
| IntegrationChannelList.tsx:217     | `platform === 'telegram' \|\| platform === 'feishu' ? 'group' : 'channel'`       | Room noun per platform                                 | c     | affordances / `roomNoun`                 |
| IntegrationChannelList.tsx:227-228 | `roomNoun(platform) === 'group' ? '' : '#'`                                      | List glyph (`#` vs none) per platform                  | c     | `roomGlyph`                              |
| IntegrationChannelList.tsx:232-241 | `platform === 'telegram' ? 'Telegram' : … : 'the chat app'`                      | Human platform name for menu copy                      | b     | `displayName`                            |
| IntegrationChannelList.tsx:252-253 | `canLeaveConversation(platform) && !isDirectConversation(kind)`                  | Whether the row menu offers Leave                      | b     | `leaveGranularity`                       |
| IntegrationChannelList.tsx:284-288 | `platform === 'discord' ? 'A Discord bot belongs to a server…'`                  | Three-way "cannot leave" explanation                   | b     | `leaveGranularity: 'space'`              |
| IntegrationChannelList.tsx:666     | `if (!integrationId \|\| platform !== 'discord' \|\| !g.key) return undefined`   | Band-level Leave-server action, Discord only           | b     | `leaveGranularity: 'space'`              |
| IntegrationChannelList.tsx:789     | `{platform === 'discord' && ' A Discord bot joins servers, not channels…'}`      | Footer note, Discord                                   | c     | copy                                     |
| IntegrationChannelList.tsx:790     | `{platform === 'slack' && ' To remove the bot from a channel, do it in Slack…'}` | Footer note keyed on authoritative membership          | b     | `membershipEnumeration: 'authoritative'` |

#### `components/marks.tsx` — PlatformMark

| file:line         | predicate                                                                   | what it does                                            | class | facet                     |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- | ----- | ------------------------- |
| marks.tsx:248-259 | `x.includes('tele')` / `'disc'` / `'feishu'\|'lark'` / `'slack'`            | Chat-platform brand SVG dispatch by substring           | c     | `Mark`                    |
| marks.tsx:212-247 | `x.includes('github')` / `'hook'` / `'sched'` / `'dream'` / `'play'\|'web'` | Core-kind glyphs (webhook, schedule, dream, playground) | d     | core special case         |
| marks.tsx:275-284 | `SocialLoginMark`: `target==='github'` / `'slack'` / `'lark'\|'feishu'`     | Sign-in-provider brand marks                            | d     | identity provider catalog |

#### `views/SettingsView.tsx` — bots-settings fragments

| file:line                  | predicate                                                                             | what it does                                              | class | facet                                |
| -------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----- | ------------------------------------ |
| SettingsView.tsx:70-73     | `region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'`         | Per-region Feishu portal deep-link                        | b     | `regions[].portalBaseUrl`            |
| SettingsView.tsx:78-132    | `SESSION_ACCESS_COPY: Record<SessionAccessProvider,…>` (slack/github/feishu)          | Per-provider session-visibility card copy                 | c     | `settingsFragments.sessionAccess`    |
| SettingsView.tsx:216       | `` `Could not load ${provider === 'slack' ? 'Slack' : 'GitHub'} session access.` ``   | **Defect: Feishu error reads "GitHub session access"**    | c     | settingsFragments (bug)              |
| SettingsView.tsx:364-370   | `BOT_PLATFORM_TABS = [ …{key:'lark',platform:'feishu',feishuRegion:'lark'}… ]`        | Bot tab registry; one platform split into two region tabs | b     | `id` + `regions`                     |
| SettingsView.tsx:374-377   | `bot.platform !== tab.platform … (bot.feishuRegion ?? 'feishu') === tab.feishuRegion` | Bot→tab matcher across the region axis                    | b     | `regions`                            |
| SettingsView.tsx:527-574   | `function SlackRefreshNotice({result, builtin, …})`                                   | Slack refresh/reinstall notice + action button            | c     | `settingsFragments.botCard`          |
| SettingsView.tsx:1024-1039 | `refreshSlackApp(b)` → `refreshSlackBot(b.id)`                                        | Slack manifest/scope refresh action                       | c     | `settingsFragments.lifecycleActions` |
| SettingsView.tsx:1042-1122 | `reinstallBuiltinSlackApp` + reinstall poll loop                                      | Slack built-in reinstall state machine (~80 lines)        | c     | `settingsFragments.lifecycleActions` |
| SettingsView.tsx:1188-1189 | `feishuRegion = b.feishuRegion ?? 'feishu'; feishuBrand = …==='lark'?'Lark':'Feishu'` | Per-bot region brand resolution                           | b     | `regions`                            |
| SettingsView.tsx:1233-1237 | `{platformTab.platform === 'slack' && <span>{b.transport ?? 'socket'}</span>}`        | Transport badge, Slack only                               | b     | `ingress`                            |
| SettingsView.tsx:1283-1312 | `{platformTab.platform === 'slack' && b.slackAppId && …}` (two blocks)                | Refresh button + api.slack.com/apps deep link             | c     | `settingsFragments.botCard`          |
| SettingsView.tsx:1313-1325 | `{platformTab.platform === 'discord' && b.discordAppId && …}`                         | "Add to Discord" invite link on bot row                   | c/a   | `settingsFragments.botCard`          |
| SettingsView.tsx:1326-1338 | `{platformTab.platform === 'feishu' && <a href={feishuAppSettingsUrl(...)}>}`         | Feishu/Lark console deep link                             | c     | `settingsFragments.botCard`          |

#### `views/AgentDetailView.tsx`

| file:line                                | predicate                                                                           | what it does                             | class | facet                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- | ----- | ------------------------------ |
| AgentDetailView.tsx:102-109              | `INTEGRATION_BLURB: Record<Platform,string>`                                        | Empty-state tile one-liners per platform | c     | marketing copy                 |
| AgentDetailView.tsx:112-118              | `if (integration.platform !== 'feishu') return null; region === 'lark' ? …`         | Region badge on Feishu integration rows  | b     | `regions`                      |
| AgentDetailView.tsx:417-422              | `key === 'webhook' \|\| key === 'github' \|\| … caps.platforms.includes(key)`       | Duplicates the modal's adapter gate      | b/d   | registry gate + core exemption |
| AgentDetailView.tsx:1187-1200, 1305-1318 | `{g.platform === 'discord' && g.discordAppId && …}` (twice)                         | Discord invite link on integration cards | c/a   | `settingsFragments`            |
| AgentDetailView.tsx:1544-1563            | `p.key === 'github' ? <GithubMark/>` … `p.key === 'feishu' ? <LarkFeishuSwitcher/>` | Duplicated picker-tile special cases     | c     | `Mark` / `regions`             |

#### `views/SessionDetailView.tsx` — transcript renderer (design §14 defect #3)

| file:line                                  | predicate                                                                                                  | what it does                                                         | class | facet                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- | ------------------------------ |
| SessionDetailView.tsx:70, 2791, 2852, 2897 | `import { MessageText }`; `<MessageText text={turn.text} />` (3 sites)                                     | **Sole transcript renderer; applies Slack mrkdwn to every platform** | c     | `textRenderer` (registry seam) |
| SessionDetailView.tsx:973                  | `platform: target.platform ?? 'slack'`                                                                     | Conversation-key build folds unknown to `slack`                      | b     | fold-to-slack default          |
| SessionDetailView.tsx:1101                 | `platform: conversationRoster?.platform ?? 'slack'`                                                        | Merge-source platform folds to `slack`                               | c     | `MergeSource.platform`         |
| SessionDetailView.tsx:1185                 | `value === 'slack' \|\| 'github' \|\| 'lark' \|\| 'feishu' ? value : undefined`                            | Closed provider-hint union from `?source`                            | d     | identity-provider hint         |
| SessionDetailView.tsx:1253                 | `platform: currentSessionDetail.platform ?? 'slack'`                                                       | Self-key encode folds to `slack`                                     | b     | fold-to-slack default          |
| SessionDetailView.tsx:1442, 1448           | `sessionAttributionAgentAuthors(session?.platform ?? '', …)`                                               | Slack-footer author attribution over transcript                      | c     | `textRenderer` inverse         |
| SessionDetailView.tsx:1605, 1646           | `mergeSessionMessages(current, page.messages, src.platform)`                                               | Platform-dependent transcript ordering                               | c     | message-ordering facet         |
| SessionDetailView.tsx:1913-1920            | `isPg = platform==='playground'`; `isWebchat`; `usesIntegrationAvatar = platform==='hook' && …==='github'` | Live-surface + hook/github avatar special cases                      | d     | core special case              |
| SessionDetailView.tsx:2121/2153/2214, 2515 | `sourceLabel: platName(sessionIntegration)`; `` `Open the ${platName(...)} thread` ``                      | Per-platform source labels in transcript rows                        | b     | `displayName`                  |

#### Other views / components

| file:line                                       | predicate                                                                                                   | what it does                                                   | class | facet                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----- | ------------------------------------- |
| SessionsView.tsx:117                            | `fChannel === PLAYGROUND_CHANNEL_FILTER ? { platform: 'webchat' }`                                          | Playground channel filter maps to webchat platform             | d     | core special case                     |
| SessionsView.tsx:188                            | `if (provider === 'slack' \|\| provider === 'github') query.set('source', provider)`                        | Only two platforms emit the `?source` hint                     | d     | identity-provider hint                |
| ScheduleDetailView.tsx:225-234                  | `c.targetPlatform === 'slack' && c.targetChannel ? <a href={\`https://slack.com/app_redirect?channel=…\`}>` | Slack-only channel deep link on schedule detail                | c     | `settingsFragments` / deep-link facet |
| ScheduleDetailView.tsx:470-486                  | same predicate, list variant                                                                                | Second copy of the Slack-only deep link                        | c     | same                                  |
| SessionVisibilityControl.tsx:87-96              | `externalProvider === 'slack' ? 'Slack' : github ? … : === 'feishu' ? (feishuRegion==='lark'?…)`            | Names the audience provider (+ region)                         | b     | `displayName`, `regions`              |
| OutputModeField.tsx:82-83                       | `'Slack threads show model, context, usage…'` / `'Slack session status rows are hidden.'`                   | Output-mode copy names Slack for all platforms                 | c     | copy (post-dispatch chrome)           |
| IntegrationMarks.tsx:39-49                      | `kind === 'github' ? <GithubMark/> : <PlatformMark platform="webhook"/>`                                    | Hook-kind marks alongside platform marks                       | d     | core special case                     |
| DaemonDetailView.tsx:473, 829                   | `daemon.caps.platforms.map(platName)`                                                                       | Renders advertised adapters as chips                           | b     | registry × caps                       |
| DeleteBotModal.tsx:18-20, 55-68                 | `bot.slackAppId ? \`https://api.slack.com/apps/${…}\` : …`                                                  | Delete dialog deep-links to Slack app settings unconditionally | c     | `settingsFragments.lifecycleActions`  |
| LarkFeishuSwitcher.tsx:1-21                     | `BRAND_LABEL = { lark:'Lark', feishu:'Feishu' }`; `value === 'lark' ? 'feishu' : 'lark'`                    | The whole region-toggle component                              | b     | `regions`                             |
| SlackConfigCard.tsx:33-180                      | whole component (`fetchSlackConfig`/`saveSlackConfig`/`deleteSlackConfig`)                                  | Per-user Slack config-token card on Profile                    | c     | `settingsFragments` + apiBindings     |
| GettingStartedChecklist.tsx:43-48               | `case 'slack': … openModal('integration', target, { platform: 'slack' })`                                   | Onboarding action hard-wires Slack                             | c     | onboarding copy/action                |
| GettingStartedChecklist.tsx:259-335             | `AddToSlackRow` + `useSlackPlatformInstall(...)`                                                            | Onboarding "Add to Slack" row + install polling                | c     | apiBindings/install-polling           |
| GettingStarted.tsx:154 / OnboardingView.tsx:550 | `it.key === 'slack' ? <AddToSlackRow …>`                                                                    | Two call sites special-case the Slack step                     | c     | onboarding fragment                   |
| SocialSignInCard.tsx:42, 465                    | `provider.target === 'slack' ? 'min-h-12' : 'min-h-8'` / extra skeleton line                                | Slack identity row is taller (carries workspace)               | d     | identity provider                     |
| Waitlist.tsx:29, 43-46                          | `type Platform = 'slack' \| 'telegram' \| 'discord'`; `PLATFORMS=[…]`                                       | Pre-auth marketing platform chips (three only)                 | c     | marketing copy (outside console)      |
| Waitlist.tsx:568                                | `'Slack, Telegram and Discord — no new app to learn.'`                                                      | Marketing body copy                                            | c     | marketing copy                        |

#### `lib/`

| file:line                                     | predicate                                                                                                         | what it does                                                   | class | facet                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----- | ----------------------------------------- |
| lib/api.ts:577, 600                           | `targetPlatform: 'slack' \| 'telegram'` (CronDto, UpsertCronInput)                                                | DTO-level closed union feeding AddCronModal's coercion         | b     | §6.8 cron targeting                       |
| lib/api.ts:640-658                            | `CreateIntegrationInput` discriminated on `platform` with 4 credential blocks                                     | Per-platform install payload shapes                            | b     | `credentialShape`, `ingress`              |
| lib/api.ts:660-662, 2970-2973                 | `TelegramBotCheckDto`; `POST /integrations/telegram/check`                                                        | Telegram token/privacy validation binding                      | c     | apiBindings                               |
| lib/api.ts:664-757, 2987-3042                 | `startSlackInstall`/`getSlackInstall`/`finalizeSlackInstall`/`*PlatformInstall`/`fetchSlackConfig`                | Nine Slack-only CP client bindings                             | c     | apiBindings                               |
| lib/api.ts:696-717, 2975-2985                 | `startFeishuRegistration` / `getFeishuRegistration`                                                               | Feishu registration bindings + region field                    | c     | apiBindings                               |
| lib/api.ts:795-812                            | `slackAppId`, `discordAppId`, `feishuAppId`, `feishuRegion`, `teamId` on `BotDto`                                 | Per-platform identity columns on the bot DTO                   | b     | D6 `externalAppId`/`platformConfig`       |
| lib/api.ts:1735-1757                          | `isWebchat`/`isDream`/`isHook`; `isSlackDm = platform==='slack' && /^D/.test(...)`                                | Channel-label resolution; Slack DM-id heuristic                | d + c | core kinds + Slack id domain knowledge    |
| lib/api.ts:1763, 1832                         | `d.sessionKey.platform \|\| 'slack'`; `platform: d.platform ?? 'slack'`                                           | Fold-to-slack defaults on session hydration                    | b     | narrowPlatform analog                     |
| lib/api.ts:2093-2094, 3404                    | `SessionAccessProvider = 'slack'\|'github'\|'feishu'`; `platform: ('slack'\|'telegram'\|'discord')[]`             | Closed provider / waitlist unions                              | b     | `id`                                      |
| lib/api.ts:3192-3210                          | `leaveConversation(… {kind:'space'})`; `refreshSlackBot`                                                          | Discord-space leave + Slack refresh bindings                   | c     | apiBindings                               |
| lib/api.ts:3321-3335                          | `if (provider === 'slack') return apiGet<MySlackIdentityDto>(…)`                                                  | Slack identity takes a dedicated endpoint                      | c     | apiBindings                               |
| lib/data.ts:1892-1904                         | `x.includes('sched')/'github'/'dream'/'hook'/'play'\|'web'/'tele'/'disc'/'feishu'\|'lark'` → **`return 'Slack'`** | Display-name dispatch; **unknown platform renders as "Slack"** | b     | `displayName` (fold-to-slack)             |
| lib/data.ts:1909-1911                         | `s.platform === 'playground' ? 'webchat'`; `platform==='hook' && hookKind==='github'`                             | Session→display-integration mapping                            | d     | core special case                         |
| lib/data.ts:1923-1927, 1940                   | `s.channel.startsWith('cron:')`; `sessionPlatform(s) === 'webchat'`                                               | Schedule/playground channel-cell special cases                 | d     | core special case                         |
| lib/data-context.tsx:278                      | `...(d.platform === 'feishu' ? { region: d.region ?? bot?.feishuRegion ?? 'feishu' } : {})`                       | Attaches region only for Feishu rows                           | b     | `regions`                                 |
| lib/conversation-merge.ts:14-19               | `MergeSource { platform: string }` + doc                                                                          | Platform selects the duplicate-identity rule                   | c     | merge domain knowledge                    |
| lib/conversation-merge.ts:55-79               | `/^\d{16,20}$/` Discord snowflake; decimal-seconds branch                                                         | Per-platform timestamp-domain normalization                    | c     | id/timestamp domain knowledge             |
| lib/conversation-merge.ts:92-118              | `if (platform==='webchat'… 'discord'… 'telegram'… 'feishu'…) else SLACK_NATIVE_TS`                                | Four regexes + Slack fallback for dedupe identity              | c     | `messageIdentity` facet (+ d for webchat) |
| lib/session-transcript.ts:16-19               | `if (platform !== 'slack') return a.seq - b.seq`                                                                  | Slack re-sorts by event time; others by seq                    | c     | message-ordering facet                    |
| lib/session-trigger.ts:12-28                  | `if (platform !== 'slack' \|\| message.trustedAgentBot !== true) return undefined`                                | Parses Slack "sent by <…>" attribution footer                  | c     | `textRenderer` inverse                    |
| lib/conversation-key.ts:17                    | `if (key.platform === 'webchat') return key.channel`                                                              | Webchat bypasses key encoding                                  | d     | core special case                         |
| lib/session-runtime-controls.ts:27            | `session.platform === 'playground' \|\| session.platform === 'webchat'`                                           | Runtime controls allowed on live surfaces                      | d     | core special case                         |
| lib/transcript-time.ts:31-37, 55-58           | `if (raw.includes('.')) return numeric*1000` (Slack seconds)                                                      | Slack decimal-second vs daemon-ms parsing                      | c     | timestamp domain knowledge                |
| lib/slack-manifest.ts:29-212                  | `SLACK_BOT_SCOPES`, `buildSlackManifest`, `slackAppIdFromAppToken`, `slackApp*Url`                                | Whole file: Slack app manifest + deep-link mechanics           | a     | transport mechanics helper                |
| lib/discord-invite.ts:16-54                   | `DISCORD_BOT_PERMISSIONS` bitfield; `discordApplicationIdFromToken`; `discordBotInviteUrl`                        | Whole file: Discord token decode + OAuth invite URL            | a     | transport mechanics helper                |
| modals/telegram-privacy-auto-refresh.ts:3-33  | `TELEGRAM_PRIVACY_RECHECK_MS = 5_000` + visibility-gated poll                                                     | Telegram-specific re-check cadence hook                        | a     | transport mechanics helper                |
| lib/use-slack-platform-install.ts:21-118      | `FAILURES` map + popup/poll state machine                                                                         | Whole file: Slack platform-install polling hook                | c     | apiBindings / install-polling             |
| lib/slack-refresh-notice.ts:19-62             | `result.authorization === 'invalid' \| 'app_mismatch' \| 'reinstall_required'`                                    | Whole file: Slack refresh → one action + message               | c     | `settingsFragments.lifecycleActions`      |
| components/console/slack-mrkdwn.ts:29-75      | `LINK`/`USER`/`CHANNEL`/`SPECIAL` regexes; `slackToMarkdown`                                                      | Whole file: Slack control-syntax → CommonMark                  | c     | `textRenderer`                            |
| components/console/MessageText.tsx:19, 50     | `{slackToMarkdown(text)}`                                                                                         | **Unconditionally applies Slack rewriting to all rows**        | c     | `textRenderer` (defect #3 root)           |
| lib/swr-keys.ts:25-28                         | `sessionAccess: <const Provider extends 'slack'\|'github'\|'feishu'>`                                             | Closed provider union in cache-key type                        | b     | `id`                                      |
| lib/getting-started.ts:25, 96-103             | `{ kind: 'slack'; agentId }`; `integrations.some(i => i.platform === 'slack')`                                    | Onboarding step is Slack by name                               | c     | onboarding fragment                       |
| lib/social-login-providers.ts:27-33, 39-42    | `SOCIAL_LOGIN_CATALOG`; `target === 'lark' \|\| target === 'feishu'`                                              | Sign-in catalog + regional-provider predicate                  | d     | identity provider                         |
| components/SocialLoginButtons.tsx:8-11, 33-39 | `provider.target === 'lark' \|\| provider.target === 'feishu'`                                                    | Collapses Lark/Feishu into one switchable button               | d     | identity provider + `regions`             |

### 2. Per-class counts

| class                                                                                               | count   |
| --------------------------------------------------------------------------------------------------- | ------- |
| (a) transport — platform API mechanics in web helpers                                               | **7**   |
| (b) manifest capability                                                                             | **41**  |
| (c) web module fragment                                                                             | **86**  |
| (d) core special case (webchat / hook / dream / playground / schedule / github / identity-provider) | **21**  |
| **Total rows**                                                                                      | **155** |

Rows carrying a secondary class are counted once under the primary. Derived manifest-field frequency (from the (b) rows): `id`/`displayName` 12 · `regions` 11 · `ingress` 5 · `leaveGranularity` 4 · `credentialShape` 2 · `multiAgentShareable` 1 · `membershipEnumeration` 1 · cron-targeting union (§6.8) 4 · D6 identity columns 1.

### 3. Ambiguous

1. **`roomNoun` / `roomGlyph`** (IntegrationChannelList:217, 227) — could be a manifest string, but core never reads it before dispatch; design §10 names it a web-module facet → filed (c). `platformName` (:232) is the same shape yet is pure `displayName` → filed (b). The two live three lines apart; picking one class for both would be defensible.
2. **`canLeaveConversation` / `spaceAction`** (:207, :666) — filed (b) `leaveGranularity` because it gates an action, but the _copy_ explaining each refusal (:284-288) is inseparable from it and is (c).
3. **`platName()`** (data.ts:1892-1904) — three classes in one function: chat-platform display names (b), `sched`/`dream`/`hook`/`play` arms (d), and a `return 'Slack'` fallback that is a `narrowPlatform` clone (defect-class).
4. **`PlatformMark`** (marks.tsx:207-265) — the (c) `Mark` facet and the (d) core-kind glyphs are one substring chain; splitting them is an actual refactor, not a re-label.
5. **`duplicateIdentity` / `transcriptEventTimeUs`** (conversation-merge:92-118, 55-79) — post-dispatch domain knowledge (⇒ adapter-strategy-shaped) but consumed by a _core_ merge routine. In the web flavor there is no strategy slot, so filed (c); a `messageIdentity` module export is the natural landing.
6. **`mergeSessionMessages`** (session-transcript:17) — `platform !== 'slack'` is really "does this platform's ts carry order?", i.e. a candidate manifest bit; filed (c) because it is post-fetch presentation.
7. **`SESSION_ACCESS_COPY`** (SettingsView:78-132) — session-visibility is core (§12), but §9 calls the audience resolvers platform plugins; the console copy sits astride that line. Filed (c).
8. **Social-login catalog** (social-login-providers.ts:27-42, SocialLoginButtons:8-11, marks:275-284, SessionDetailView:1185, SocialSignInCard:42/465) — 6 conditionals over ids that _coincide_ with chat-platform ids but belong to the Logto connector axis, not `WebPlatformModule`. Filed (d); if a `PlatformModule` ever owns them, `regions` already covers the Lark/Feishu half.
9. **`Waitlist.tsx`** (29, 43-46, 568) — pre-auth marketing outside the console shell; would still need the platform list. Filed (c) marketing copy.
10. **`DeliveryLine`** (AddIntegrationModal:337-371) — reads `ingress` (b) but _is_ the affordance component (c). Filed (c).

### 4. Platform-conditionals outside the listed shapes

- **A file `grep -r` silently skips.** `packages/web/src/components/console/views/SessionDetailView.tsx` contains a NUL byte, so `file` reports `data` and BSD/GNU `grep -rn` returns **nothing** for it (even `grep -c "platform"` → empty). It holds 9 platform-conditionals including all three `MessageText` call sites (defect #3). Any S0/S2 sweep must use `grep -a`. It is the only such file under `packages/web/src`.
- **Substring dispatch, not equality** — `PlatformMark` (marks.tsx:212-259) and `platName` (data.ts:1894-1903) branch on `.includes('tele')`, `'disc'`, `'feishu'|'lark'`, `'sched'`, `'play'|'web'`. Invisible to `===`/`!==` greps, and order-sensitive (`'hook'` must precede `'web'`).
- **Fold-to-`slack` defaults** (the web mirror of §14 defect #1) — api.ts:1763, api.ts:1832, SessionDetailView:973/1101/1253, data.ts:1904, AddCronModal:79 and :141. Seven sites where an unknown platform silently becomes Slack.
- **Closed unions in type positions** (no runtime predicate, but they _are_ the branch set) — api.ts:577/600 (`targetPlatform`), api.ts:640-658, api.ts:2093-2094, api.ts:3404, swr-keys.ts:25, AddCronModal.tsx:77, AddIntegrationModal.tsx:85-86, 171, 328.
- **CSS tokens and animation classes** — `packages/web/src/app/globals.css:79-81` (`--slack`, `--telegram`, `--discord`), `:242-244` (`*-soft`), `:2909-2921` + `:3042-3066` (`slackHintBlink`, `.slack-hint-blink`, `.cfgtok-pop`, `.cfg-scroll`, `.cfg-click-a/b`), `:3022-3024` (Telegram/Discord walkthrough animations). A `WebPlatformModule` that owns its wizard Body would need these to move too — and Tailwind v4 `@source` scanning is exactly the D1 hazard.
- **A per-platform binary asset** — `packages/web/public/brands/lark.svg`, referenced by `marks.tsx:18` (`LARK_MARK_SRC`) because Lark ships no icon-set entry. Slack/Telegram/Discord come from npm icon packages; Lark does not.
- **Mock fixtures, not conditionals** — `lib/data.ts:1140-1622` and `lib/data-context.tsx:277-490` hardcode per-platform bot/integration rows (`slackAppId`, `discordAppId`, `feishuAppId: 'cli_mocklarkops'`, `feishuRegion`). `MOCK_MODE` also drives real branches (AddIntegrationModal:1342, :1367, :2016-2023, which fakes Slack funnel + platform app). A module split needs a per-module mock seam or `MOCK_MODE` becomes a fifth cross-cutting switch.
- **Duplicated gates across files** — the daemon-caps platform gate exists twice verbatim (AddIntegrationModal:1212-1215 and AgentDetailView:417-422), the Discord invite block twice inside AgentDetailView (1187, 1305), the Slack platform-install poll twice (AddIntegrationModal:2082-2108 and use-slack-platform-install.ts:78-118 — the latter's header comment says "keep the two in sync"), and the Slack failure map twice (AddIntegrationModal:112 and use-slack-platform-install.ts:21).

---

## Appendix E — `packages/protocol/src` + `packages/message/src` (wire-shape inventory)

### 1. Inventory table

| file:line                                      | item (short excerpt)                                                                                                                | what it is (≤15 words)                                                | label               | S1b target / implied name                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| protocol/src/frames/route.ts:15                | `Platform = z.enum(['slack','telegram','webchat','discord','feishu','hook','dream'])`                                               | canonical enum; conflates origin kinds with chat identities           | wire-enum           | §6.1 `OriginKind` × `PlatformId`           |
| protocol/src/frames/route.ts:19                | `SessionKey = z.object({ platform: Platform, ...})`                                                                                 | session primitive keyed on the closed enum                            | wire-enum           | §6.1                                       |
| protocol/src/frames/register.ts:23             | `platforms: z.array(Platform), // D3 adapters present`                                                                              | handshake capability array; unknown id kills register                 | wire-enum           | §6.2 (S1a tolerant reader)                 |
| protocol/src/frames/register.ts:62             | `capabilities: RegisterReq.shape.capabilities`                                                                                      | `capabilities/update` reuses the same closed array hot-path           | wire-enum           | §6.2                                       |
| protocol/src/frames/relay-daemon.ts:370        | `coords: { platform: z.enum([...5]) }`                                                                                              | inline copy #1 — RdAgentMsg delivery coords                           | wire-enum           | §6.1                                       |
| protocol/src/frames/relay-daemon.ts:392        | `originCoords: { platform: z.enum([...5]) }`                                                                                        | inline copy #2 — RdAgentMsg origin lineage                            | wire-enum           | §6.1                                       |
| protocol/src/frames/relay-daemon.ts:462        | `coords: { platform: z.enum([...5]) }`                                                                                              | inline copy #3 — RdAgentMsgFwd delivery coords                        | wire-enum           | §6.1                                       |
| protocol/src/frames/relay-daemon.ts:479        | `originCoords: { platform: z.enum([...5]) }`                                                                                        | inline copy #4 — RdAgentMsgFwd origin lineage                         | wire-enum           | §6.1                                       |
| protocol/src/frames/relay-daemon.ts:437-450    | `"(slack / telegram / discord / feishu) ⇒ refused, FAIL CLOSED"` + `"folds feishu and anything it does not recognise into 'slack'"` | coordsDecision contract: hardcoded persisted-IM list + narrowPlatform | shared-branch (b)   | §6.1 / §6.3; manifest `persistsPlacements` |
| protocol/src/frames/relay-daemon.ts:188        | `RdSlackAction = z.discriminatedUnion('kind', [...10])`                                                                             | Slack control vocabulary typed on the wire                            | wire-variant        | §6.6 opaque payload                        |
| protocol/src/frames/relay-daemon.ts:211        | `source: z.literal('slack_action')`                                                                                                 | platform-named rd/msg member                                          | wire-variant        | §6.6 `platform_action`                     |
| protocol/src/frames/relay-daemon.ts:229,236    | `WireFeishuCardActionTarget` / `…Value`                                                                                             | Feishu card routing target typed in core protocol                     | wire-variant        | §6.6 envelope                              |
| protocol/src/frames/relay-daemon.ts:242        | `WireFeishuCardActionEvent = z.object({ open_message_id, operator, action …})`                                                      | raw Feishu provider body carried verbatim on the wire                 | wire-variant        | §6.6 opaque payload                        |
| protocol/src/frames/relay-daemon.ts:270        | `WireFeishuCardActionResponse = { toast: {...} }`                                                                                   | Feishu toast round-trip typed in core                                 | wire-variant        | §6.6 opaque `response?`                    |
| protocol/src/frames/relay-daemon.ts:283        | `source: z.literal('feishu_action')`                                                                                                | the Feishu analog member of rd/msg                                    | wire-variant        | §6.6                                       |
| protocol/src/frames/relay-daemon.ts:326        | `RdMsg = z.discriminatedUnion('source', [webchat, im, slack_action, feishu_action, hook])`                                          | two of five members are platform identities                           | wire-variant        | §6.6                                       |
| protocol/src/frames/relay-daemon.ts:343        | `feishuCardAction: WireFeishuCardActionResponse.optional()`                                                                         | per-platform ack slot (design's stated precedent)                     | wire-field          | §6.6 opaque `response?`                    |
| protocol/src/frames/relay-daemon.ts:163        | `WireNormalizedMessage = NormalizedPlatformMessageSchema`                                                                           | rd/msg IM payload is the named-field schema                           | wire-field          | §6.5                                       |
| protocol/src/frames/relay-daemon.ts:321        | `target: CronTarget.optional() // output anchoring`                                                                                 | hook output anchoring inherits cron's 4-platform enum                 | wire-enum           | §6.8                                       |
| protocol/src/normalized-message.ts:37          | `platform: z.enum(['slack','telegram','webchat','discord','feishu'])`                                                               | fifth inline enum copy (5-value variant)                              | wire-enum           | §6.1                                       |
| protocol/src/normalized-message.ts:52          | `isGroupDm` (`/** Slack 'mpim' … */`)                                                                                               | Slack-vocabulary conversation classification                          | wire-field          | §6.5 / core `conversationKind`             |
| protocol/src/normalized-message.ts:58          | `telegramTopicId: z.string().optional()`                                                                                            | named per-platform topic id                                           | wire-field          | §6.5 `coords.topicId`                      |
| protocol/src/normalized-message.ts:60          | `telegramThreadRoot: z.string().optional()`                                                                                         | named per-platform reply-chain root                                   | wire-field          | §6.5 `coords.threadId`                     |
| protocol/src/normalized-message.ts:62          | `discordTopLevel: z.boolean().optional()`                                                                                           | named promote-to-thread flag                                          | wire-field          | §6.5 `coords.promoteToThread`              |
| protocol/src/normalized-message.ts:64          | `parentChannel: z.string().optional()`                                                                                              | Discord enclosing-channel coordinate                                  | wire-field          | §6.5 `adapterExt`                          |
| protocol/src/frames/integration.ts:161         | `IntegrationSpec = z.discriminatedUnion('platform', [4])`                                                                           | the closed per-platform spec union                                    | wire-variant        | §6.4 core envelope + opaque config         |
| protocol/src/frames/integration.ts:58          | `IntegrationSlackConfig = z.object({...}).superRefine(...)`                                                                         | per-platform config object with core knobs inside                     | wire-variant        | §6.4 `config: unknown`                     |
| protocol/src/frames/integration.ts:60,71,79,85 | `mode`, `bindRules`, `mutedChannels`, `gated`                                                                                       | core routing knobs embedded in the Slack variant                      | wire-field          | §6.4 `core{}`                              |
| protocol/src/frames/integration.ts:98          | `IntegrationTelegramConfig`                                                                                                         | per-platform config object                                            | wire-variant        | §6.4                                       |
| protocol/src/frames/integration.ts:100-102     | `bindRules`, `mutedChannels`, `gated`                                                                                               | core knobs duplicated into the Telegram variant                       | wire-field          | §6.4 `core{}`                              |
| protocol/src/frames/integration.ts:112         | `IntegrationDiscordConfig`                                                                                                          | per-platform config object                                            | wire-variant        | §6.4                                       |
| protocol/src/frames/integration.ts:115-117     | `bindRules`, `mutedChannels`, `gated`                                                                                               | core knobs duplicated into the Discord variant                        | wire-field          | §6.4 `core{}`                              |
| protocol/src/frames/integration.ts:139         | `IntegrationFeishuConfig`                                                                                                           | per-platform config object                                            | wire-variant        | §6.4                                       |
| protocol/src/frames/integration.ts:143,148-150 | `mode`, `bindRules`, `mutedChannels`, `gated`                                                                                       | core knobs duplicated into the Feishu variant                         | wire-field          | §6.4 `core{}`                              |
| protocol/src/frames/integration.ts:136         | `FeishuRegion = z.enum(['feishu','lark'])`                                                                                          | regional cloud axis as a platform-named enum                          | wire-enum           | §5 manifest `regions[]`                    |
| protocol/src/frames/integration.ts:224         | `kind: z.enum(['channel','im','mpim']).optional()`                                                                                  | Slack conversation vocabulary in a shared frame                       | wire-enum           | §6.4 / manifest                            |
| protocol/src/frames/integration.ts:221-222     | `spaceId` / `space` (`enclosing Discord guild snowflake`)                                                                           | Discord-motivated container fields, generically named                 | wire-field          | §6.4 opaque config / adapterExt            |
| protocol/src/frames/integration.ts:247         | `authoritative: z.boolean().optional()`                                                                                             | membership-enumeration semantics as a per-report flag                 | shared-branch (b)   | manifest `membershipEnumeration`           |
| protocol/src/frames/integration.ts:266         | `IntegrationLeaveTarget = discriminatedUnion('kind',[conversation,space])`                                                          | closed leave-granularity union                                        | wire-enum           | manifest `leaveGranularity`                |
| protocol/src/frames/agent.ts:434               | `integrations: z.array(IntegrationSpec)`                                                                                            | AgentActivate bootstrap bundle carries the closed union               | wire-variant        | §6.4                                       |
| protocol/src/frames/agent.ts:266               | `iconUrl` (`Slack per-message icon_url (chat:write.customize)`)                                                                     | Slack-specific avatar contract on a shared spec                       | shared-branch (b)   | manifest `avatar.perMessageIconUrl`        |
| protocol/src/frames/agent.ts:287               | `showStatusBar // render Slack's persistent session status row`                                                                     | post-dispatch chrome flag named for one platform                      | shared-branch (c)   | adapter `renderStatusBar`                  |
| protocol/src/frames/agent.ts:286               | `showFooter // render platform attribution/session footers`                                                                         | post-dispatch footer strategy exposed as a core flag                  | shared-branch (c)   | adapter `renderFooter`                     |
| protocol/src/frames/cron.ts:20                 | `platform: z.enum(['slack','telegram','discord','feishu']).default('slack')`                                                        | CronTarget closed union + lossy slack default                         | wire-enum           | §6.8                                       |
| protocol/src/frames/collab.ts:84               | `platform: Platform` (CollabChannelRoute)                                                                                           | snapshot channel key uses the closed enum                             | wire-enum           | §6.1                                       |
| protocol/src/frames/collab.ts:41               | `botAppId // Public Slack app id (A…)`                                                                                              | Slack-named provenance field in the shared snapshot                   | wire-field          | §6.7 / adapterExt                          |
| protocol/src/frames/collab.ts:96-106           | `CollabRoutesSnapshot = { generation, channels, agents }`                                                                           | carries no originKind-per-platformId classification data              | wire-field (gap)    | §6.1 classification rides snapshot         |
| protocol/src/frames/channel.ts:48              | `platform: Platform` (ChannelAgentsReq)                                                                                             | directory REQ keyed on closed enum                                    | wire-enum           | §6.1                                       |
| protocol/src/frames/channel.ts:61              | `platform: Platform` (ChannelAgentsOk)                                                                                              | directory REP echo keyed on closed enum                               | wire-enum           | §6.1                                       |
| protocol/src/frames/secrets.ts:14              | `scope: { platform: Platform, workspaceId }`                                                                                        | lease request scope on closed enum                                    | wire-enum           | §6.1                                       |
| protocol/src/frames/secrets.ts:24              | `scope: { platform: z.string(), ... }`                                                                                              | grant side already open — enum/string asymmetry                       | wire-field          | §6.1 (existing open precedent)             |
| protocol/src/frames/telemetry.ts:84            | `platform: Platform.optional()` (EventSession)                                                                                      | session milestone echo on closed enum                                 | wire-enum           | §6.1 / §6.2 "store verbatim"               |
| protocol/src/frames/telemetry.ts:30            | `ExternalSessionAudience = discriminatedUnion('provider',[slack,feishu,github])`                                                    | closed provider union for audience identity                           | wire-variant        | §6.1 open provider id                      |
| protocol/src/frames/telemetry.ts:55            | `ExternalSessionOrigin = discriminatedUnion('provider', [...])`                                                                     | per-provider credential-proof shapes typed in core                    | wire-variant        | §6.4-style opaque proof                    |
| protocol/src/frames/telemetry.ts:156           | `platform: z.string().optional() // denormalized sessionKey echo`                                                                   | UsageReport already open — precedent                                  | wire-field          | §6.1 (existing open precedent)             |
| protocol/src/consts.ts:50                      | `SLACK_SESSION_AUDIENCE_FEATURE = 'slack-session-audience-v1'`                                                                      | pre-dispatch capability string with a platform in its name            | shared-branch (b)   | §6.2 / manifest-derived feature            |
| protocol/src/frame.ts:211                      | `'integration/upsert': IntegrationUpsert`                                                                                           | daemon↔CP frame map carries the closed union                          | wire-variant        | §6.4                                       |
| protocol/src/frames/relay-cp.ts:563            | `platform: z.enum(['slack','telegram','discord','feishu'])`                                                                         | sixth inline enum copy — bot assignment                               | wire-enum           | §6.7                                       |
| protocol/src/frames/relay-cp.ts:568            | `apiAppId // Slack "A…", Feishu "cli_…"`                                                                                            | per-platform demux identity as a named field                          | wire-field          | §6.7 opaque `ingress`                      |
| protocol/src/frames/relay-cp.ts:574            | `teamId // Slack workspace id ("T…")`                                                                                               | Slack composite-key half; D6 `externalTenantId`                       | wire-field          | §6.7 opaque `ingress`                      |
| protocol/src/frames/relay-cp.ts:529            | `RcBotSecrets = z.union([{botToken,signingSecret},{verificationToken,encryptKey}])`                                                 | untagged per-platform secret union                                    | wire-variant        | §6.7 opaque `secrets`                      |
| protocol/src/frames/relay-cp.ts:724            | `reason: z.enum(['app_uninstalled','tokens_revoked'])`                                                                              | Slack lifecycle vocabulary in a shared frame                          | wire-enum           | §6.7                                       |
| protocol/src/frames/relay-cp.ts:689            | `RcBotChannels = { botId, channels }` (`re-listed … via users.conversations`)                                                       | Slack authoritative-enumeration report shape                          | shared-branch (b)   | manifest `membershipEnumeration`           |
| protocol/src/frames/relay-cp.ts:677            | `RcSetChannelAgent` (`picked … in the in-Slack config modal`)                                                                       | Slack modal callback promoted to a core frame                         | shared-branch (a)   | §6.6 platform module                       |
| protocol/src/frames/relay-cp.ts:663            | `RcAssign = { botId, sessionKey, agentId, daemonId }`                                                                               | thread-affinity broadcast; platform rides inside sessionKey           | wire-field          | §6.1 (sessionKey string form)              |
| protocol/src/frames/relay-cp.ts:768            | `RcThreadAssign = { botId, sessionKey, … }`                                                                                         | thread-affinity report leg, same sessionKey encoding                  | wire-field          | §6.1                                       |
| protocol/src/frames/relay-cp.ts:780            | `RcThreadLookup = { botId, sessionKey }`                                                                                            | pull-on-miss backstop, same sessionKey encoding                       | wire-field          | §6.1                                       |
| protocol/src/frames/relay-cp.ts:402            | `SHARED_CONFIG_ACTION_ID = 'ac_shared_channel_config'`                                                                              | Slack Block Kit action id pinned in core protocol                     | shared-branch (a)   | §6.6 platform module                       |
| protocol/src/frames/relay-cp.ts:409            | `SHARED_AGENT_SELECT_ACTION_ID = 'ac_shared_agent_select'`                                                                          | Slack select action id in core protocol                               | shared-branch (a)   | §6.6                                       |
| protocol/src/frames/relay-cp.ts:414            | `SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID = 'ac_manage_session'`                                                                   | Slack shortcut callback id in core protocol                           | shared-branch (a)   | §6.6                                       |
| protocol/src/frames/relay-cp.ts:419-429        | `SLACK_STATUS_ACTION = { more, manage, setModel, … }`                                                                               | nine Slack action ids in core protocol                                | shared-branch (a)   | §6.6                                       |
| protocol/src/frames/relay-cp.ts:434-436        | `PERMISSION_ACTION_PREFIX` / `ELICIT_ACTION_PREFIX` / `ELICIT_DISMISS_ACTION`                                                       | Slack card action prefixes in core protocol                           | shared-branch (a)   | §6.6                                       |
| protocol/src/frames/relay-cp.ts:440,444        | `encodePermValue` / `decodePermValue`                                                                                               | Slack 150-char value codec in core protocol                           | shared-branch (a)   | §6.6                                       |
| protocol/src/frames/relay-cp.ts:451            | `SlackStatusOverflowAction = z.enum(['switch-agent','manage','cancel'])`                                                            | Slack overflow vocabulary as a wire enum (+codecs 467/471)            | wire-enum           | §6.6                                       |
| protocol/src/frames/relay-cp.ts:485            | `SharedSlackStatusTarget = z.object({v,agentId,integrationId,sessionKey}).strict()`                                                 | Slack-named opaque routing target (+codecs 495/499)                   | wire-variant        | §6.6 envelope                              |
| protocol/src/frames/relay-cp.ts:246            | `kind: z.enum(['webhook','github'])`                                                                                                | hook origin-kind closed enum                                          | shared-branch (d)   | §6.1 `OriginKind`                          |
| protocol/src/frames/relay-cp.ts:255            | `target: CronTarget.optional()`                                                                                                     | hook anchoring inherits cron's 4-platform enum                        | wire-enum           | §6.8                                       |
| protocol/src/frames/relay-cp.ts:276            | `commentFamilies: z.array(z.enum(['issues','pull_request']))`                                                                       | GitHub-specific thread taxonomy in a core frame                       | shared-branch (d)   | hook module                                |
| protocol/src/wire.ts:75-83                     | `const schema = Object.hasOwn(schemas, env.data.type) … msg: 'UNKNOWN_FRAME'`                                                       | unknown frame type → typed REP, never a close                         | shared-branch (a)   | §6.2 evidence                              |
| protocol/src/wire.ts:84-92                     | `const payload = schema.safeParse(...); if (!payload.success) return { ok:false … }`                                                | known type + failing payload → frame refused                          | shared-branch (a)   | §6.2 evidence                              |
| protocol/src/codec.ts:41-58                    | `export function encode(frame) { if (frame.type === 'memoryconnection/upsert') … 'register/ok' … }`                                 | per-frame down-level emission shim (M-5D precedent)                   | shared-branch (a)   | §6.4 IntegrationSpec legacy emission       |
| message/src/slack-message.ts:1-110             | whole file (110 lines)                                                                                                              | pure Slack normalizer + attachment mapping                            | module-file         | `platforms/slack/`                         |
| message/src/slack-message-text.ts:1-188        | whole file (188 lines)                                                                                                              | pure Slack Block Kit / attachment text extraction                     | module-file         | `platforms/slack/`                         |
| message/src/telegram-message.ts:1-209          | whole file (209 lines)                                                                                                              | pure Telegram types + normalizer                                      | module-file         | `platforms/telegram/`                      |
| message/src/discord-message.ts:1-103           | whole file (103 lines)                                                                                                              | pure Discord types + normalizer                                       | module-file         | `platforms/discord/`                       |
| message/src/feishu-message.ts:1-198            | whole file (198 lines)                                                                                                              | pure Feishu/Lark event → message-like + normalizer                    | module-file         | `platforms/feishu/`                        |
| message/src/index.ts:1-6                       | `export * from './discord-message.js'` … (5 platform barrels)                                                                       | static per-platform barrel = the de-facto registry seam               | shared-branch (a)   | `platforms/registry.ts`                    |
| message/src/attachment-mention.ts:6            | `attachmentMention(attachments)`                                                                                                    | only genuinely shared helper; **no platform branch**                  | (none — stays core) | core                                       |
| message/src/telegram-message.ts:196            | `...(isForumTopic && threadId !== undefined ? { telegramTopicId: threadId } : {})`                                                  | write site of the named topic-id wire field                           | wire-field          | §6.5 `coords.topicId`                      |
| message/src/telegram-message.ts:197            | `...(!isForumTopic && threadId !== undefined ? { telegramThreadRoot: threadId } : {})`                                              | write site of the named reply-root wire field                         | wire-field          | §6.5 `coords.threadId`                     |
| message/src/discord-message.ts:100             | `...(message.isThread && message.parentChannelId ? { parentChannel: … } : {})`                                                      | write site of the Discord parent-channel field                        | wire-field          | §6.5 `adapterExt`                          |
| message/src/discord-message.ts:101             | `...(!isDm && !message.isThread ? { discordTopLevel: true } : {})`                                                                  | write site of the promote-to-thread flag                              | wire-field          | §6.5 `coords.promoteToThread`              |
| message/src/slack-message.ts:100               | `...(message.channel_type === 'mpim' ? { isGroupDm: true } : {})`                                                                   | write site of the Slack mpim classification                           | wire-field          | §6.5 / core `conversationKind`             |

### 2. Counts

| label                                                | count  |
| ---------------------------------------------------- | ------ |
| wire-enum                                            | 23     |
| wire-variant                                         | 18     |
| wire-field                                           | 26     |
| shared-branch (a = transport)                        | 11     |
| shared-branch (b = pre-dispatch manifest capability) | 5      |
| shared-branch (c = post-dispatch adapter strategy)   | 2      |
| shared-branch (d = webchat/hook/dream special case)  | 2      |
| shared-branch subtotal                               | 20     |
| module-file                                          | 5      |
| none (shared, platform-free)                         | 1      |
| **total rows**                                       | **93** |

Inline `Platform`-enum copies found across `frames/` + `normalized-message.ts`: **6 literal copies** (relay-daemon.ts 370/392/462/479; normalized-message.ts:37; relay-cp.ts:563) plus 2 near-copies with different member sets (cron.ts:20 four-value + `.default('slack')`; route.ts:15 seven-value canonical). The design says "four inline copies in relay-daemon.ts" — confirmed exactly four there, but the total is six across the package; §6.1's rewrite list is incomplete by two.

### 3. Ambiguous rows

- `normalized-message.ts:52 isGroupDm` — Slack `mpim` vocabulary, but core actually consumes it pre-dispatch (mention-gating, and `EventSession.conversationKind` at telemetry.ts:102). Could stay core as a manifest-fed classification rather than folding into `adapterExt`.
- `integration.ts:224 kind: ['channel','im','mpim']` — Slack vocabulary, but it is read pre-dispatch by gating (§14 fail-closed DM rows), so opening it needs a core-owned conversation taxonomy, not just a string.
- `integration.ts:221-222 spaceId/space` — already generically named; may need no change beyond documentation. Listed as wire-field only because its semantics are Discord-guild-shaped.
- `integration.ts:266 IntegrationLeaveTarget` / `247 authoritative` — these are the two places where the manifest axes `leaveGranularity` / `membershipEnumeration` already exist as wire data. Either they become manifest reads (core stops carrying them) or they stay on the wire and the manifest field is redundant; the design does not say which.
- `agent.ts:266 iconUrl`, `286 showFooter`, `287 showStatusBar` — D2 boundary cases: they are user-facing settings replicated CP→daemon (pre-dispatch data) whose _effect_ is post-dispatch rendering. Classified by effect (b/c per §5's explicit "footer style / status-bar shape are adapter strategy"), but they are wire fields today.
- `relay-cp.ts:663 / 768 / 780` (thread affinity) — no platform field in the schema; the platform rides inside the opaque `sessionKey` string (`${platform}:${channel}:${thread}`). No schema change needed for S1b, but every producer/consumer of that string form is affected by §6.1, so they are audit targets rather than edits.
- `secrets.ts:24` and `telemetry.ts:156` — already `z.string()`. Listed as evidence that an open platform string is not novel on this wire, not as work items.
- `consts.ts:50 SLACK_SESSION_AUDIENCE_FEATURE` — feature strings are `z.array(z.string())`, so there is no fatality; only the name bakes in a platform. Cosmetic unless the capability generalizes.
- `wire.ts:75-83`, `wire.ts:84-92`, `codec.ts:41-58` — mechanism rows, not platform branches. Labeled `shared-branch (a)` for schema conformance; they carry no per-platform logic today.
- `message/src/attachment-mention.ts:6` — the only shared file in `packages/message/src`, and it contains **no** platform branch. There is no shared `normalized.ts` and no shared `threadKeyForPost` in this package; those derivations live inside the per-platform modules (`slack-message.ts:87`, `discord-message.ts:90`, `feishu-message.ts:189`, `telegram-message.ts:153`) and move wholesale.
- `collab.ts:96-106` — a _gap_ row (something the design requires that is absent), not an existing branch.

### 4. Verification of the design's zod / handshake claims

**Claim: "zod strips unknown object keys" — CONFIRMED, with one material exception.**

- `protocol/src/envelope.ts:12-19` — `Envelope` is a plain `z.object` (no `.strict()`), so unknown envelope keys are stripped. Direct proof: `wire.ts:39-47 extractControlExt(json)` re-reads `epoch`/`agentId`/`launchId` **from the raw parsed JSON**, not from `env.data`, precisely because the `Envelope` parse drops them; `wire.ts:96` rebuilds the frame from the stripped `env.data`.
- Exception: 115 `.strict()` schemas exist in `packages/protocol/src`, and **11 of them are in `frames/relay-cp.ts`**, including `SharedSlackStatusTarget` (relay-cp.ts:485-492) and `LegacySlackStatusOverflowValue` (relay-cp.ts:454-460), plus the GitHub hook-authz frames (132-138, 141-163, 168, 176-198, 204-231). On those, an additive field is a **decode failure**, not a strip. None of the platform-carrying frames (`route`, `register`, `integration`, `cron`, `collab`, `channel`, `relay-daemon`, `normalized-message`) is strict, so §6.2's staging premise holds where it matters — but §6.6's "add an opaque payload slot to the Slack status target" would be rejected by an older relay because relay-cp.ts:492 is `.strict()`. This is not in the design and should be called out.

**Claim: "unknown frame types graceful" — CONFIRMED.**
`wire.ts:75-83` — a `type` absent from the schema map returns `{ok:false, msg:'UNKNOWN_FRAME'}` carrying `corr`; `control-plane/src/ws/connection.ts:59-62` turns that into a typed `error` REP (`sendError(..., false)` = not fatal), and `connection.ts:140-144` maps it to the `UNKNOWN_FRAME` error code. The socket is not closed.

**Claim: "unknown enum values inside a known frame are fatal to the frame" — CONFIRMED.**
`wire.ts:84-92` — for a _known_ type, `schema.safeParse(env.data.payload)` failure returns `{ok:false, msg: payload.error.message}`; no partial acceptance, no per-field salvage. `z.enum` has no catch-all, so one unknown platform string fails the whole payload. `connection.ts:143` maps it to `BAD_PAYLOAD`.

**Claim: "a new platform id reaching an old CP kills the handshake and the daemon enters a reconnect loop" — CONFIRMED.**
Chain: `register.ts:23 platforms: z.array(Platform)` → unknown id fails the `register` payload parse at `wire.ts:84-92` → `control-plane/src/ws/connection.ts:59-68` sends `error BAD_PAYLOAD` REP **and** `correlator.reject(decoded.corr, ProtocolError(..., {retryable:false}))` → daemon `daemon/src/cp/client.ts:384` (`await this.correlator.request(register, ...)`) throws → `client.ts:301-311` catch closes transport (`1011 'handshake failed'`) and `scheduleReconnect()` → `client.ts:315-328` exponential backoff, retrying forever. CP never closes the socket and stays in `REGISTERING` accepting only `register` (`connection.ts:130-131`). Net: fatal reconnect loop, exactly as §6.2/D3 states.

**Refinement to the design's §6.4 claim about `AgentSpec`.**
`protocol/src/frames/agent.ts:255-374 AgentSpec` is a **flat `z.object`, not a union**, no platform discriminator. The actual duplicated closed union is `protocol/src/frames/integration.ts:161 IntegrationSpec` ↔ `daemon/src/agents/agent-schema.ts:96 IntegrationSchema` (`z.discriminatedUnion('platform', [slack@102, telegram@108, discord@114, feishu@120])`), with a _third_ copy of the four-value enum at `daemon/src/agents/agent-schema.ts:142`. The protocol-side coupling to `AgentSpec` is indirect: `agent.ts:434 AgentActivate.integrations: z.array(IntegrationSpec)`. §6.4 should name `IntegrationSpec`/`IntegrationSchema`, not `AgentSpec`.

**Also refuted as written:** §6.8's `CronDef.targetPlatform` / `HookDef.targetPlatform` do not exist in `packages/protocol/src` — `targetPlatform` appears only in `packages/web` (`lib/api.ts:577,600` typed `'slack' | 'telegram'` — narrower still than the wire) and CP DTOs. The protocol-side equivalent is the single `CronTarget.platform` at `cron.ts:20`, reused by `relay-daemon.ts:321` (hook) and `relay-cp.ts:255` (hook assign), so §6.8 is one protocol edit with three consumers, not two separate defs.
