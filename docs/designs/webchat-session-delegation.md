# Webchat Session Delegation — Opening a Session With the Acting User's Permissions

Status: design proposal (v1 = webchat only)

This specifies the **webchat half of P4** — the per-session delegated credential that
[`preset-agents.md`](preset-agents.md) §4 names as the security prerequisite for putting
admin tools inside the `agentconnect` preset's Playground sessions, and that its M3 row
schedules as "minimal P4 first". It also answers that document's §9 open question ("how
far the admin toolset scopes inside a general-purpose agent's webapp sessions") and the
vertical-escalation question [`agent-assistant.md`](agent-assistant.md) §10.3 leaves
OPEN.

It supersedes the mechanics still carried in `agent-assistant.md` §4 / §5 / §6.3 on one
premise: delivery there is "mint at `rc/verify`, deliver through the relay→daemon session
path". That is replaced by a daemon-pulled lease (§5). The `kind='assistant'` premise is
already gone upstream (both documents cancelled it on 2026-07-29), so nothing here
depends on it. §11 lists the remaining deltas; those two files stay unedited and change
alongside their own implementations.

### Vocabulary

Fixed here and used consistently below, in field names, in audit records, and in UI copy.
Two of these exist to resolve real collisions with names the codebase already spends.

- **Acting user** — the human whose AgentConnect permissions a session borrows while it
  runs. _Not_ "conversation owner": `owner` is an org membership role
  (`owner`/`collaborator`/`viewer`, `http/rbac.ts`), so that phrasing reads as a role
  claim it is not.
- **Delegation lease** — the short-lived, renewable grant that lets one webchat session
  act as its acting user. Held by the daemon; never visible to the model or the
  transcript.
- **Delegated key** — the credential a lease resolves to: one revocable API key whose
  authority is its acting user's. _Not_ called a "principal" — `principal` /
  `principalType` already means _a credential's_ subject in the CP
  (`daemon | user | relay | oauth`), and overloading it to mean a human is what made an
  earlier draft of this document ambiguous.
- **Control-plane tools** — the tool surface a session uses to operate AgentConnect
  itself (agents, crons, sessions, usage), served by the CP and reachable only under a
  lease.
- **Conversation** — one CP-registered webchat thread, bound at creation to exactly one
  acting user and one agent, mapping to exactly one daemon session.

---

## 1. Problem

A daemon session today has **no idea who it is acting for**. `dispatchWebchatTurn`
(`packages/daemon/src/daemon.ts:4127`) turns a relay op into a `NormalizedMessage`
whose `sender.id` is a display handle, and that is the end of the identity chain. So
any authority a session exercises against AgentConnect itself has to come from some
_static_ credential (an agent-level key, a daemon key, a config-file secret).

That is a textbook confused deputy, and it does not get milder now that the assistant
is folded into the preset `agentconnect` agent — it gets worse, because that agent also
has shell and file tools and is reachable by members of every role:

- **Ambient authority.** A static key's authority is the union of what every webchat
  user might be allowed to do. A `viewer` chatting with the agent can ask it to do a
  `collaborator`'s work and the credential says yes.
- **No attribution.** The audit trail records "some key did this", not "Ada asked for
  this in conversation X".
- **No revocation granularity.** Demoting Ada, or removing her from the org, does not
  change what the session can still do on her behalf.

So: **when the daemon opens a webchat session, that session must act with the
permissions of its acting user — no more, and never as a static identity.**

### 1.1 Scope: control plane only (decision)

Delegation governs **only what the session can do to AgentConnect itself** — the
control-plane tools. It deliberately does **not** vary by role:

- the session's local tools (Bash / Edit / Write / WebFetch), permission mode, or
  sandbox;
- the workspace it runs in;
- which skills, memory, or peer agents it can see.

Those stay agent configuration. Reason: the confused deputy above is the one real gap;
making local execution authority or resource visibility bend to whoever is chatting
would introduce a second, per-turn permission model whose semantics (and host-process
caching) do not converge. The vertical-escalation consequence of that choice is faced
head-on in §8, not hidden.

---

## 2. What already exists (do not rebuild)

| Piece                             | Where                                                              | Note                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → conversation authz      | `http/routes/webchat-token.ts`                                     | `humanAuth` + `canView(agent)` + a conversation-ownership row, then a 5-min HS256 token                                                |
| Token claims                      | `registry/webchatToken.ts`                                         | `{ userId, user, agentId, orgId, conversationId }` — the acting user is already **authoritative** here                                 |
| Relay-side verification           | `ws/relay-connection.ts:320` → `container.ts:854`                  | Re-resolves the agent's CURRENT `daemonId`; returns `RcVerifyResult`                                                                   |
| Verified display name             | `relay/src/relay-browser-connection.ts` (`parseBrowserFrame`)      | The relay **overwrites** a browser-supplied `user`, so `op.user` is already spoof-proof                                                |
| One conversation ⇒ one session    | `daemon.ts` `webchatSessionKey()`                                  | `sessionKey('webchat', conversationId, 'webchat:<id>', agentId)`                                                                       |
| Lease protocol shape              | `protocol/src/frames/secrets.ts`                                   | `secrets/request` (D→C REQ at session start) · `grant` with `ttl`/`renewBeforeSec` · `renew` · `revoke` (C→D EVT hot kill) — copy this |
| D→C request precedent             | `frames/channel.ts`, `frames/gitcred.ts`, `frames/hook.ts`         | The daemon already initiates REQ→REP on the control WS                                                                                 |
| Revocable one-org credential      | `ApiKey` (`prisma/schema.prisma:410`), `registry/apiKeyService.ts` | hash-only at rest, pepper, `expiresAt` / `revokedAt`, `scopes[]`                                                                       |
| Scope confinement                 | `http/org-scope.ts:55`                                             | non-empty `scopes` without `mcp:write` ⇒ 403 on every mutating REST call                                                               |
| Role resolved per request         | `http/org-scope.ts` (`roleOf`)                                     | Role is **never** baked into a credential; demotion applies on the next call                                                           |
| CP MCP endpoint + catalog         | `http/mcp/routes.ts`, `http/mcp/tools.ts`                          | Stateless per POST at `/api/v1/mcp` and `/v1/mcp`; tools execute by injecting real REST requests with the caller's own credential      |
| Daemon local MCP + injection seam | `daemon/src/mcp/{inject,control-server,ops}.ts`, `daemon.ts:2024`  | stdio bridge ↔ unix socket (0700 dir / 0600 socket), per-session opaque token in the child's env, never visible to the model           |
| System-tool auto-allow            | `daemon.ts:311-347`, `resolveAcpPermission` (~`daemon.ts:10986`)   | Permission requests for `server === 'agentconnect'` ∧ tool ∈ registered set are granted with no card; anything else falls through      |

Missing: the `delegated` principal, the lease frames, the relay activity signal, the
daemon-side lease store, and the injection branch.

---

## 3. Design in one picture

```
browser              relay                 CP                              daemon
  │ POST /webchat/token (humanAuth · canView · ownership row)                 │
  │◀──────── token{userId,user,agentId,orgId,conversationId} ─────────────────┤
  │─ WS dial ─────────▶│                                                      │
  │                    │─ rc/verify(webchat-token) ─▶│                        │
  │                    │◀─ rc/verify/ok ─────────────┤                        │
  │                    │─ rc/webchat-open{convId} ──▶│ mark conversation LIVE  │
  │─ op ──────────────▶│─ rd/msg (unchanged) ───────────────────────────────▶ │
  │                    │                             │                        │ session/new
  │                    │                             │◀─ delegation/request ──┤  (agent has control
  │                    │                             │   {convId}             │   tools enabled)
  │                    │                             │ checks: row exists ∧    │
  │                    │                             │ agent placed HERE ∧     │
  │                    │                             │ conversation LIVE ∧     │
  │                    │                             │ acting user still member│
  │                    │                             │─ delegation/grant ─────▶│ hold lease in memory,
  │                    │                             │   {leaseId, secret,     │ keyed by sessionKey
  │                    │                             │    ttl, renewBeforeSec} │
  │                    │                             │                        │ inject 2nd MCP server
  │                    │                             │                        │  = local bridge (proxy)
  │                    │                             │◀─ POST /v1/mcp ────────┤ per call: attach the
  │                    │                             │   Bearer <current key> │ CURRENT lease's key
  │                    │                             │ role resolved per req, │
  │                    │                             │ allowlist, audit       │
  │─ close / drop ────▶│─ rc/webchat-close ─────────▶│ clear LIVE → revoke     │─ delegation/revoke ─▶│
```

---

## 4. The delegated key

A fifth `PrincipalType`, joining `daemon | user | relay | oauth`:

| Dimension  | `delegated`                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Minted by  | **only** a `delegation/request` grant (§5). No REST route mints one                                        |
| Bound to   | acting user (`userId`) + `orgId` (existing columns) + `agentId` + `conversationId` (new, `delegated`-only) |
| TTL        | ~15 min, renewed per turn while the conversation stays live; replaced (old row revoked) on re-grant        |
| Scopes     | `['mcp:read']`, or `['mcp:read','mcp:write']` when the agent's control-tools switch is set to write (§7)   |
| Authority  | acting user's CURRENT org role ∩ scopes ∩ **route allowlist** (§6) ∩ not-self (§6.2)                       |
| Role       | never baked in — `roleOf` per request, so demotion/removal applies on the next call                        |
| Visible to | the daemon process only. Never the model, transcript, workspace, child env, or argv                        |

Reuses the whole existing credential pipeline: hash-only at rest, pepper,
`expiresAt`/`revokedAt` checked on auth, `authenticateUser` resolving the human + org,
`req.apiKeyScopes` feeding `org-scope.ts`'s confinement guard.

New in the CP:

- `apiKeyService.mintDelegated({ userId, orgId, agentId, conversationId, scopes })` →
  `{ leaseId, secret, expiresAt }`, revoking any live key for the same
  `(userId, agentId, conversationId)` in the same transaction — exactly one live key per
  conversation;
- `authenticateUser` accepts the `delegated` principal and sets
  `req.delegation = { leaseId, agentId, conversationId, actingUserId }`;
- an expiry sweeper for `delegated` rows, and revoke-on-close (§5.3);
- audit: grant / renew / revoke as `audit_event`; every tool call already logs, now with
  `principalType='delegated'` + `agentId` + `conversationId` + `actingUserId`.

---

## 5. Lease acquisition: daemon pull over the control WS

### 5.1 Why pull, not relay-carried

The earlier draft minted at `rc/verify` and pushed the secret through the relay on every
`rd/msg`. Two of the arguments for that path were wrong:

- _"the relay path keeps working when the CP is down"_ — false. Control-plane tool calls
  **target the CP**; when the CP is down the capability is dead regardless of where the
  credential lives.
- _"a CP-initiated delivery races the first turn"_ — true only for a CP **push**. A
  daemon **pull** happens at the moment of need, so there is no race to lose.

Pulling therefore keeps user-authority secrets off the relay entirely, leaves `rd/*` and
`RcVerifyResult` **byte-unchanged**, and inherits renew + hot-revoke semantics from
`secrets.ts` instead of inventing them.

### 5.2 Frames (mirroring `secrets/*`)

```
delegation/request   D→C REQ  { conversationId }
delegation/grant     C→D REP  { leaseId, conversationId, secret, ttl, renewBeforeSec }
delegation/renew     D→C REQ  { leaseId } → delegation/grant
delegation/revoke    C→D EVT  { leaseId, reason }
```

The request carries **only** the conversation id. Everything else is resolved from
CP-owned state, never from the daemon's claim: the acting user and the agent come from
the conversation row, and the granted scopes come from the CP's own copy of that agent's
control-tools switch at grant time. `delegation/renew` re-runs the full §5.3 admission
and mints a **fresh secret** (the reply is a full `delegation/grant`; the old key is
revoked in the same transaction) — a lease that can no longer be granted can no longer
be renewed.

`secret` is credential material: never logged on either side, never persisted by the
daemon, and excluded from telemetry.

### 5.3 Admission rule — what makes a pull legitimate

The CP grants only when **all** hold:

1. the conversation row exists — it names both the acting user and the agent, so
   neither is ever taken from the daemon's claim;
2. the conversation's agent is **currently placed on the asking daemon**;
3. the conversation is **LIVE** — at least one browser connection is open right now
   (§5.4);
4. the acting user is still a member of the org (`roleOf` returns a role).

Condition 3 is what makes the blast-radius claim true rather than aspirational: without
it, a compromised daemon could hold a rolling lease for the acting user of **any**
conversation it has ever hosted, forever. With it, only people actually chatting at that
moment are exposed. That property was previously assumed (`agent-assistant.md` §10) but
never actually enforced — it is enforced here, and it is the sole reason §5.4 exists.

### 5.4 The missing activity signal

The CP has no idea whether a tab is still open: `rc/*` carries `verify` and
`run-report`, nothing about browser connections, and a tab open for three hours
re-verifies exactly zero times (verification happens once per WS dial). So add:

```
rc/webchat-open    R→C EVT  { conversationId, connectionId }
rc/webchat-close   R→C EVT  { conversationId, connectionId }
```

Liveness is **per browser connection, not a boolean**: the relay stamps each event with
its own connection id, the CP counts open connections per conversation, and LIVE means
count > 0. A boolean model would let two tabs on the same conversation kill each other
(open A, open B, close A → lease revoked while B is still chatting). The relay emits
`open` after a successful verify and `close` when that browser socket ends; a relay that
disconnects clears every connection it contributed (the existing relay sweeper already
knows when a relay drops, and its registration/liveness bookkeeping is the natural
home). A relay that **reconnects** re-emits `open` for every browser connection it still
holds — liveness lives in CP memory, so a CP restart would otherwise strand every
conversation as not-live (same replay-on-register pattern as `onRegistered`'s shared-bot
replay).

When the count reaches zero: CP marks the conversation not-live and hot-revokes its
lease (`delegation/revoke` → the daemon drops it, so a background turn that outlives its
tab loses control-plane authority but keeps chatting).

### 5.5 Renewal

The daemon renews at the start of a turn when the lease is inside `renewBeforeSec`,
never mid-call. A failed renew is not fatal to the conversation: the lease simply lapses
and control-plane tools fail closed (§9) while chat continues. This is why the TTL can
be short — a CP blip costs a tool call, not a session.

---

## 6. Authority boundary: allowlist, default-deny

The CP MCP layer executes a tool by **injecting a real REST request with the caller's
own credential** (`http/mcp/routes.ts`), so the set of routes the delegated key can
reach _is_ the authority boundary; the tool catalog is curation on top of it.

### 6.1 Allowlist, not deny-list (decision)

`agent-assistant.md` §6.3 proposed `denyDelegated` over enumerated high-risk route
families. Inverted here: a delegated key may reach **only explicitly listed** route
families, everything else 403s. Reason: with a deny-list, security depends on every
future route author remembering that a delegated principal exists — and (per §7/§8)
there is no human in the loop to catch the omission. With an allowlist a newly added
route is unreachable until someone deliberately admits it.

v1 admits, and nothing else:

- `GET` on agents, daemons (list/read), crons + cron runs, sessions (list/read), usage,
  integrations (metadata), bots / members / hooks / hook runs (metadata, no secrets);
- writes (only under `mcp:write`): `POST|PATCH /agents`, `PUT|DELETE /crons/:id`,
  `POST /crons/:id/run`.

Explicitly **not** admitted (so no guard is needed to exclude them): every credential
route (`/me/keys`, `/daemons/token`, `/daemons/:id/keys`, and
`/agents/:id/webchat/token` — the recursion stop), member and org writes, all three
`/sharing` families, `/agents/:id/call-policy`, `/bots` and the Slack / GitHub
installation funnels, `/slack/config`, and hook writes.

### 6.2 No self-modification (decision)

A write whose **target resource binds to the conversation's own agent** is refused, full
stop. That covers more than `PATCH /agents/:id` on itself:

- agent writes targeting its own `agentId` — delete, re-placement, runtime change,
  `permissions`, `workspace`, `mcpServers`;
- **cron writes whose `agentId` is its own** — a cron drives exactly one agent
  (`http/routes/crons.ts`: "A cron drives ONE agent, agentId is required"), and a cron
  turn runs as **non-webchat ingress: no lease, but full local tools**. Without this
  rule, injected content could schedule instructions for itself and convert a 15-minute
  lease window into persistent shell execution — the exact escalation §6.2 exists to
  block, one route family over. Re-targeting an existing cron **onto** itself is refused
  the same way; `POST /crons/:id/run` on a self-targeted cron likewise.

The agent has shell access, so editing its own configuration — directly or via a
resource that feeds it work — is a direct route to escalating its own execution
authority on the daemon host. This constraint holds without relying on anyone's
judgement; "attach this repo to yourself" is a console action.

### 6.3 Destructive confirmation

`agent-assistant.md` §6.4's mechanism stands: destructive tools require `confirm`
exactly equal to the target's name, compared in the tool layer. Under the v1 allowlist
the only reachable destructive operation is `deleteCron` (`DELETE /agents/:id` and
integration writes are not admitted, so `deleteAgent` / `removeIntegration` do not exist
in v1's catalog — the rule applies to them if and when the allowlist grows). §8 records
honestly what this does and does not buy.

---

## 7. Injection

### 7.1 Per-agent switch (decision)

Control-tools exposure is per agent, not platform-wide:

- a custom agent turns it on from the console's **Tools** page — **default off**;
- the preset `agentconnect` agent ships **on, with writes**.

Unconditional injection was rejected: it would add a whole org-management surface to
every playground session of every agent (context cost, and a pure code-review agent
suddenly becomes a management entry point).

### 7.2 Proxy through the daemon's own bridge (decision)

`mcpServersFor` (`daemon.ts:2024`) gains a branch: when `platform === 'webchat'` and the
agent has control tools enabled, push a **second MCP server** — another instance of the
daemon's existing stdio bridge, whose IPC token resolves to a `cp-mcp` passthrough in
`mcp/ops.ts` that forwards `tools/list` and `tools/call` to
`<controlPlane.url → http(s)>/v1/mcp` with
`Authorization: Bearer <the sessionKey's CURRENT lease secret>`.

Injection is deliberately **not** conditioned on a lease existing. Two reasons.
`mcpServersFor` is a synchronous callback (`session-manager.ts:195`) while acquiring a
lease is a D→C round trip, so the lease can only ever be prefetched best-effort (the
daemon requests it at turn admission, before dispatch). And an ACP session's server list
is fixed at `session/new` — if a CP blip at the first turn suppressed injection, that
conversation would **permanently** lack control tools for the life of the session, which
contradicts the whole point of the proxy (static descriptor, credential resolved per
call). So: inject on webchat + switch alone, both synchronously known; a call arriving
with no live lease fails closed with the §9 message, and the next turn's prefetch
restores service.

Not a URL + header handed to the runtime, because:

- an ACP session's `mcpServers` list is fixed at `session/new` and re-asserted verbatim
  on `session/load` (`session-manager.ts:658,707`), while the lease rotates every
  ~15 min — a URL injection would pin a dead credential into a live session;
- the credential never enters a child process's env or argv, one step stricter than the
  existing `AC_MCP_TOKEN` discipline;
- fail-closed text is daemon-authored (§9), not a bare 401 the model may narrate as an
  AgentConnect outage;
- one place for daemon-side rate limiting and id-only logging.

The injected descriptor is identical across renewals (it addresses the local socket, not
the key), so rotation never perturbs `hostSpawnSig` (`reconciler/reconciler.ts`) and
never forces a respawn.

### 7.3 Tool surface shape

A **separate** server from the reserved `agentconnect` one, with CP tool names passed
through verbatim (so names match what external MCP clients such as the claude.ai
connector see, and prompts/docs transfer). The server name is an implementation detail;
it must not collide with `RESERVED_MCP_SERVER_NAME`.

### 7.4 Approval path: auto-allowed as system tools (decision)

Control-plane calls, **including writes**, are granted without a per-call human
approval, exactly like the daemon's own MCP tools.

This is not free: `daemon.ts:311-347` keys auto-allow on
`rawInput.server === RESERVED_MCP_SERVER_NAME` ∧ tool ∈ the registered builtin set, so
a separate server (§7.3) is **not** covered by accident. The implementation must extend
that predicate deliberately — either by registering the proxied control tools in the
builtin set or by admitting the control server's name explicitly. Getting this wrong
does not fail open: unmatched requests fall through to `resolveAcpPermission`, and on
webchat that means `awaitEditorPermission` — the request is held for an out-of-band
decision in the console's Agent editor, which for a chat-first flow reads as a hang.

Alternatives considered and rejected for v1: a new in-chat approval surface for webchat
(`WebchatEvent` has no permission kind and `chatApprovalEnabled` requires
`p.platform === 'slack'`, so chat approvals are Slack-only today — this would be new
protocol + UI), and routing writes to the existing console approval (splits the
experience across two pages, and stalls any acting user who is not an editor).

---

## 8. Accepted residual risk

With §7.1 (preset ships with writes) and §7.4 (no per-call approval) composed:

> Any content that enters the agent's context — a fetched web page, a repository file, an
> issue body, a tool result — can initiate a **write** against the org with the acting
> user's role, and there is no human on that path. The destructive-confirmation field
> (§6.3) does not close it, because the model can supply the target's name itself.

What remains between an injected instruction and damage: the route allowlist (§6.1), the
no-self-modification rule (§6.2), per-request role resolution (a viewer's session simply
cannot write), the ~15-min lease with liveness gating (§5.3), and an audit trail that
makes it reconstructable afterwards.

This is a deliberate trade for onboarding quality — a preset agent that can actually set
things up on request — and it is recorded here so nobody has to rediscover it. Two
tightenings are available later without redesign: flip the preset's default to
`mcp:read`, or add the webchat in-chat approval surface rejected in §7.4.

The other side of the ledger stays intact: **a daemon never holds an org-wide CP
credential.** A compromised daemon obtains, at most, the current role-bounded authority
of the users chatting with it right now, for ~15 min, over an allowlisted surface, with
every call audited.

---

## 9. Failure modes

| Case                               | Behavior                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Old relay (no `rc/webchat-open`)   | Conversation never marked live ⇒ no grant ⇒ no control tools. Fail-closed; identical to today.                                 |
| Old daemon (no `delegation/*`)     | Never asks ⇒ never injects. Fail-closed.                                                                                       |
| CP down                            | Chat unaffected. `tools/call` returns the daemon's "control tools are temporarily unavailable" message.                        |
| Lease lapsed (renew failed)        | Same message; the next turn re-requests and restores it.                                                                       |
| Last browser tab closed            | Connection count hits zero → lease revoked; an in-flight turn finishes but loses control-plane authority.                      |
| Acting user demoted / removed      | Next call resolves the new role: writes 403, removal reads as 404. No revocation round-trip needed.                            |
| Daemon restart mid-conversation    | Next turn's `session/load` re-requests a lease and re-injects the same descriptor.                                             |
| Two tabs, same conversation        | One daemon session, one lease — tabs share it. Liveness counts connections, so closing one tab does not revoke (§5.4).         |
| CP restart                         | Liveness memory lost; relays re-emit `open` for held connections on reconnect (§5.4). Leases keep verifying (DB rows survive). |
| Agent moved to another daemon      | Admission rule 2 fails on the old daemon; the new one requests its own lease.                                                  |
| Non-webchat ingress (Slack / cron) | No conversation, no lease, no injection — structurally, not by policy check.                                                   |

---

## 10. Change list

**protocol** — `delegation/{request,grant,renew,revoke}` (D→C REQ/REP + C→D EVT),
`rc/webchat-{open,close}` (R→C EVT); redaction rules for `secret`. `rd/*` and
`RcVerifyResult` unchanged.

**control-plane** — `PrincipalType.delegated` + `agentId`/`conversationId` columns
(migration); `mintDelegated` with same-triple revoke; `authenticateUser` support and
`req.delegation`; the route allowlist guard (default-deny) + the self-target refusal
(agents **and** self-bound crons, §6.2); per-connection liveness counting driven by
`rc/webchat-{open,close}` and relay drop; the `delegation/*` handlers on the daemon WS
(renew re-runs admission, fresh secret); audit events; expiry sweeper.

**relay** — emit `rc/webchat-open` per browser connection after a successful verify and
`rc/webchat-close` when that socket ends; clear contributed connections when its CP
link drops, and re-emit `open` for held connections on CP reconnect.

**daemon** — lease store keyed by webchat sessionKey (memory-only) with renew-at-turn-start
and revoke handling; `cp-mcp` passthrough in `mcp/ops.ts` + descriptors in `mcp/tools.ts`;
the `platform === 'webchat'` injection branch in `mcpServersFor`; the auto-allow
predicate extension (§7.4); CP HTTP base derived from `controlPlane.url` (ws→http).

**web** — the Tools-page switch (off / read / write) per agent; make it legible in the
playground that this session acts as the signed-in user.

**tests** — CP unit: grant admission rule (each of the four conditions independently),
re-grant and renew both revoke the old key and re-run admission, allowlist default-deny
(a route not listed 403s), self-target refusal for agent writes AND for cron writes with
`agentId=self` (create, re-target onto self, run), scope confinement on writes, scopes
derived from the CP's agent record (not the request), demotion takes effect without
re-grant, liveness counting (two opens + one close stays LIVE; last close revokes).
Relay unit: open/close per connection, contributed connections cleared on drop, re-emit
on CP reconnect. Daemon unit: injection on webchat + switch alone (present with no lease),
key resolved per call (rotation visible mid-session), fail-closed message when a call
arrives with no live lease, no injection for Slack or cron, auto-allow predicate matches
the control server. Integration: a viewer's conversation cannot write; an agent cannot
modify itself directly or via a self-bound cron.

---

## 11. Relationship to the two live designs (both left unedited)

The assistant-agent cancellation already landed upstream (2026-07-29, shipped with preset
agents M0): no `AgentKind` discriminator exists, `PresetAgentKind` carries only `general`,
and `RESERVED_AGENT_SLUGS` keeps the assistant slugs purely as an impersonation guard
(`control-plane/src/domain/reserved-agent-slugs.ts`). So this document does not have to
argue the merge — it inherits it, and only the delegation mechanics are in question.

**`preset-agents.md` — this document fills its gaps, it does not contradict it**

1. §4 (assistant cancelled) names "the per-session delegated credential of
   agent-assistant.md §4 (P4's webchat half) — still the security prerequisite, still
   unbuilt". This document is that prerequisite, specified.
2. M3 in §8 (phasing) schedules "minimal P4 (per-session delegated key) first, then the
   AgentConnect MCP admin toolset scoped to those sessions". §5–§7 here specify the first
   half and the injection seam for the second; §10 is its change list.
3. §9's open question — how far the admin toolset scopes inside an ordinary,
   shell-capable agent, given the cancelled design's restricted-profile reasoning does not
   transfer — is answered by §1.1 (delegation governs the control plane only, never local
   execution authority), §6 (allowlist + no self-modification), and §8 (what is accepted
   instead of a restricted profile).
4. Still to settle in that document's own territory, not here: the preset's persona must
   say that control-plane actions exist only in Playground sessions (Slack/cron sessions
   get no lease, §9), and the Tools-page switch (§7.1) needs to be reflected wherever the
   preset's shipped defaults are described.

**`agent-assistant.md` — one premise superseded, three rows revised, one gap closed**

5. §4 / §5 / §7.6 (delivery) — "mint during the `rc/verify` leg, deliver through the
   relay→daemon session path" is superseded by a daemon-pulled lease over the control WS
   (§5). Its §5 "Minted by: only webchat-token verification" row becomes "only a
   `delegation/request` grant"; `rd/*` needs no change at all.
6. §5 (credential table) — the `delegated` column stands, but TTL is ~15 min + renew
   rather than 12 h, and scopes are `mcp:read` / `mcp:write` rather than `['assistant']`
   (which lets the existing `org-scope.ts` confinement do the enforcing).
7. §6.3 (deny-list) — inverted to an allowlist, default-deny (§6.1), plus the
   self-modification refusal (§6.2), which is also the concrete form of the "cannot
   unlock itself" property §6.3 says the successor must re-establish.
8. §10.3 (vertical escalation, marked **OPEN** pending "a new answer before the toolset
   ships") — answered: §1.1 keeps local execution authority out of delegation entirely,
   §6.2 blocks self-reconfiguration, and §8 states plainly what is accepted in place of
   the cancelled restricted profile.
9. §10 (blast-radius claim) — "a compromised daemon reaches only currently-active
   webchat users" holds **only** with the liveness gate (§5.3/§5.4). Without
   `rc/webchat-{open,close}` a daemon can lease any conversation it has ever hosted, and
   the claim is false.
10. §12 (IM ingress) — stays out of scope here, and is the committed follow-on: IM
    delegation needs a verified binding between a platform account and an AgentConnect
    user before any of this mechanism can apply.

---

## 12. Settled defaults (no further decision needed)

- TTL ~15 min with `renewBeforeSec` per `secrets.ts`; renew at turn start only.
- Fail-closed text is daemon-authored and names the remedy ("reload the playground").
- Audit reuses the shipped MCP audit path — `audit_event` via `deps.repos.audit.append`
  (`http/mcp/routes.ts`, including its serialized-args cap) — with
  `principalType='delegated'` plus `actingUserId`, `agentId`, `conversationId`. (The
  `assistant_op_log` table `agent-assistant.md` §9.3 proposed was never built; do not
  add it.)
- The v1 tool catalog is the read set of `agent-assistant.md` §6.2 plus agent and cron
  writes — kept identical to the allowlist in §6.1 so catalog and boundary cannot drift.
