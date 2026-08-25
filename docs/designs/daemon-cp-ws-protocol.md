# Daemon ↔ Control Plane WebSocket Protocol

**Status:** Implemented living wire specification. `packages/protocol/src/frame.ts`
and its `FRAME_SCHEMAS` registry are authoritative.
**Scope:** The single bidirectional WebSocket contract between a **Daemon (D2 CP-Client)** and the **Control Plane (C3 Orchestrator / C4 Registry / C5 Secrets)**. This is the wire the whole control plane is built against. It carries control, orchestration, and telemetry, plus bounded correlated reads that proxy daemon-local session, tool-body, memory, or workspace content to an authorized BFF caller. Live platform messages and ACP update streams remain on the data plane, and proxied content is not persisted by the Control Plane.

The core frame families cover registration, heartbeat, routing, agent
lifecycle, crons, secrets, configuration, drain, fencing, capability facts,
degraded operation, and fleet control.

> **Wire scope:**
>
> - Prompt delivery runs entirely on daemon ingress and never over this
>   WebSocket. Fencing uses `sessionEpoch` and `launchId`.
> - The console session list uses CP-stored `session_meta` synchronized by
>   `event/session`; transcript and tool bodies remain live daemon pulls.
> - `packages/protocol/src/frame.ts` is the complete registry for relay roster,
>   collaboration, hooks, reviews, integrations, MCP, memory, git credentials,
>   workspace reads, tool bodies, usage, and the core frames described here.
> - The zod snippets below are schematic. Use
>   `packages/protocol/src/frames/*` for exact current fields and the shared
>   `Platform` enum.

---

## 1. Transport & framing

- **One connection.** The daemon **dials out** a single WSS connection to the CP (`wss://cp.example.com/daemon/ws`). The CP never dials the daemon (NAT/firewall friendly). All downlink control reuses this socket.
- **Subprotocol:** `agentconnect.v1` (sent in `Sec-WebSocket-Protocol`). The CP echoes it on accept; mismatch → close `4400`.
- **Encoding:** UTF-8 **JSON text frames**. One protocol envelope per WS frame. Binary frames are reserved (future MsgPack negotiation) and currently rejected with close `4415`.
- **Validation:** every payload is a **zod**-discriminated union keyed on `type`. Unknown `type` from a peer → `error` reply with `code: "UNKNOWN_FRAME"` (not a connection close — forward-compat).
- **Unknown KEYS are forward-compat too, and asymmetrically so.** The daemon reads this socket with the tolerant reader (`decodeCpEnvelope`, over `packages/protocol/src/tolerant.ts`): every object in a CP-authored payload strips a key it does not know instead of failing the frame. That is not a nicety — the CP upgrades first, so one added optional field inside a `.strict()` object nested anywhere in `register/ok` fails the handshake, identically, on every retry, until the daemon is upgraded too. The CP reads the daemon with the strict reader (`decodeEnvelope`), where refusing an unknown key is an input check on what a peer sends in. Field-level validation — types, required fields, refinements — is identical on both sides.
- **Size:** soft cap **256 KiB** per frame. Anything larger (e.g. a big facts blob) must be chunked or moved off-band (attachment/object-store, see §3.2). Over cap → `error` `FRAME_TOO_LARGE`.
- **Compression:** `permessage-deflate` enabled if both sides offer it; never assumed.

### 1.1 Envelope

Every frame, both directions, is the same envelope:

```ts
const Envelope = z.object({
  v: z.literal(1), // protocol major; bump = breaking
  id: z.string().uuid(), // unique per frame (sender-generated)
  ts: z.string().datetime(), // RFC3339, sender clock (advisory only)
  type: z.string(), // frame discriminator, e.g. "register"
  corr: z.string().uuid().optional(), // correlation: set on a reply to the request's `id`
  orgId: z.string().optional(), // required on org-scoped frames over an install-wide cloud connection
  payload: z.unknown() // validated by the per-type schema below
})
```

An API-key or envelope-daemon connection is bound to one organization at auth time, so `orgId` may be omitted for rolling compatibility. Each cloud-daemon Pod has an install-wide connection and must carry `orgId` on every organization-scoped request, event, control frame, and correlated reply. Member-scoped frames such as auth, register, heartbeat, runtime facts, relay roster, collaboration routes, duty lease frames, and daemon lifecycle control omit it — and on the install-wide connection must not carry it. The classification and the checks both peers run live in `packages/protocol/src/frame-scope.ts` (`INSTALL_WIDE_FRAME_TYPES`, `checkInboundFrameOrg`, `checkReplyFrameOrg`); [`org-scoped-data-layer.md`](org-scoped-data-layer.md) §4.1 spells out the contract.

**Reply correlation.** A request-shaped frame (anything expecting an `ack`/result) is answered by a frame whose `corr` == the request's `id`. Fire-and-forget frames (most telemetry) carry no reply. Each frame type below is tagged **REQ** (expects a correlated reply), **REP** (is a reply), or **EVT** (fire-and-forget).

**Direction tags:** `D→C` daemon→CP, `C→D` CP→daemon, `↔` either.

---

## 2. Connection lifecycle

```mermaid
sequenceDiagram
  participant D as Daemon (D2)
  participant C as Control Plane (C4/C3)
  D->>C: WSS connect (subprotocol agentconnect.v1)
  D->>C: auth {apiKey, machineId?, ...}             %% REQ
  C-->>D: auth/ok {sessionEpoch, heartbeatSec, resume?}  %% REP
  D->>C: register {capabilities, maxAgents, ...}     %% REQ
  C-->>D: register/ok {routingEpoch, assignments[], agents[], crons[], leases[]}  %% REP (reconcile snapshot)
  loop steady state
    D-->>C: heartbeat {load, health, activeSessions}  %% EVT (every heartbeatSec)
    C-->>D: route/assign | cron/upsert | secrets/grant | ... %% C→D control
    D-->>C: event/session | facts/* | agent/* acks      %% D→C telemetry/acks
  end
  note over D,C: on socket drop → daemon enters local autonomy (§7);<br/>on reconnect → auth(resume) then register reconcile
```

### 2.1 States

`CONNECTING → AUTHENTICATING → REGISTERING → READY → (DRAINING) → CLOSED`, plus the off-socket state `DEGRADED` (local autonomy, §7).

- **READY** is the only state in which the CP issues ordinary orchestration control. Before READY, `auth`/`register` are valid, plus the narrowly scoped `daemon/bootstrap/result` while `REGISTERING`; anything else → `error PROTOCOL_STATE`.
- **DRAINING** is entered on `daemon/drain` (§6) — daemon stops accepting new `route/assign`, finishes in-flight, then closes.

### 2.2 Heartbeat & watchdog

- WS-level `ping`/`pong` (library keepalive) **plus** app-level `heartbeat` EVT carrying a load snapshot.
- CP sends `heartbeatSec` in `auth/ok` (default **15s**). Daemon emits `heartbeat` every `heartbeatSec`.
- **Watchdog:** if CP misses **3×heartbeatSec** of both pongs and heartbeats, it marks the daemon `unreachable`, freezes its routing assignments (does **not** reassign yet — see §7 split-brain), and surfaces it in the dashboard. Reassignment only after a `reassignGraceSec` (default 60s) to avoid double-serving.

---

## 3. Auth & identity

### 3.1 `auth` (REQ, D→C) → `auth/ok` (REP, C→D)

First frame after the socket opens. Establishes **who this daemon is** before any registration.

```ts
const AuthReq = z.object({
  // Long-lived, revocable API key — a bare opaque `<secret><crc>`, hashed at rest and looked
  // up by that unique hash (daemon-api-key-auth.md). Absent on an in-cluster daemon.
  apiKey: z.string().optional(),
  // An in-cluster daemon's projected ServiceAccount token, verified by TokenReview and
  // taking precedence over `apiKey` (k8s-daemon-pool.md, "Identity is per Pod, not per org").
  serviceAccountToken: z.string().optional(),
  daemonId: z.string().uuid().optional(), // OPTIONAL echo; if present must equal the daemonId the ApiKey row resolves to. The daemon adopts its id from `auth/ok`.
  machineId: z.string().uuid().optional(), // reserved scope-attestation identity (§3.2), not the auth credential
  attestation: z.string().optional(), // reserved signed proof (JWS), see §3.2
  agentVersion: z.string(), // daemon build/version
  bootstrapProtocolVersion: z.literal(1).optional(), // auth-only upgrade recovery support
  resume: z
    .object({
      // present only on reconnect
      lastEpoch: z.number().int() // sessionEpoch the daemon last held
    })
    .optional()
})

const AuthOk = z.object({
  daemonId: z.string().uuid(),
  sessionEpoch: z.number().int(), // monotonic; bumped each successful (re)auth — fencing token
  heartbeatSec: z.number().int(), // cadence the daemon must emit heartbeat at
  serverTime: z.string().datetime(),
  organizationMode: z.enum(['connection', 'frame']).default('connection'),
  webAppUrl: z.string().optional(), // optional console-base override for session deep links;
  // daemon fallback order is local config, this value, then http://localhost:3000
  orgSlug: z.string().optional(), // org slug for those links (console routes are org-scoped)
  lifecycle: z
    .object({
      operationId: z.string(),
      action: z.literal('upgrade'),
      targetVersion: z.string()
    })
    .optional(), // durable upgrade intent, only for bootstrap-capable callers
  resume: z
    .object({
      accepted: z.boolean() // false ⇒ daemon must do a full register reconcile
    })
    .optional()
})
```

`bootstrapProtocolVersion: 1` is a frozen recovery handshake implemented by the
thin daemon entry before the full daemon graph loads. When a pending upgrade
exists, the CP arms it at auth delivery and returns `lifecycle`; the daemon
installs through its local CLI and reports
`daemon/bootstrap/result {operationId,status:'installed'|'failed',reason?}`.
`installed` is progress only. Success still requires a later authenticated
connection to reach `READY` with `agentVersion == targetVersion`.

**`sessionEpoch` is the global fencing token.** Every C→D control frame that mutates routing or sessions carries the `epoch` it was issued under (see §4 envelope-ext). A daemon **rejects** any control frame whose `epoch < its current sessionEpoch` (a late frame from a pre-reconnect CP view) with `error STALE_EPOCH`.

**Auth failure (`4401`, fatal — don't auto-retry):** a malformed / unknown / bad-secret / **revoked** / **expired** key — or a `user`-principal key presented on the WS — → close `4401` `AUTH_FAILED`. The daemon goes fatal and stops reconnecting; the operator re-onboards (mints a fresh key) or rotates ([daemon-api-key-auth.md](daemon-api-key-auth.md) §7). It does **not** hammer-reconnect on `4401`. **On the projected-identity path this becomes an exit, not a wait:** that credential is re-read from the pod's volume at every boot and the process is restart-supervised, so there is no operator step to stay up for — and a container that took a `4401` can never register at all, because boot blocks on the first registration. The daemon exits non-zero and the restart redials, which puts the retry on the supervisor's backoff instead of on nothing.

**Server-internal (`1011`, retryable):** a DB/lookup/persistence error _during_ verify or the epoch bump → close `1011` `SERVER_INTERNAL`. The daemon backs off and retries — a transient DB blip must **not** be reported as `4401` (that would wedge the whole fleet on a dead-credential verdict).

### 3.2 Reserved machine identity and scope attestation

Uses a scope-attestation endpoint pattern. **Two distinct credentials on two planes** — do not conflate them ([daemon-api-key-auth.md](daemon-api-key-auth.md) §10):

- **`apiKey` (bare opaque token)** — the **control-channel** credential: authenticates the _daemon process_ to the CP on the `auth` frame (§3.1). Long-lived, hashed-at-rest, revocable. This is the WS auth credential.
- **`machineId` + `attestation` (`sk_machine_*`)** — reserved **data-plane** fields for a scoped machine capability. The implementation is stubbed (`signScopeAttestation` throws `NOT_IMPLEMENTED`), so callers must not depend on these fields. If implemented, a CP-signed short-TTL capability reaches the object store; the raw API key does not.

```ts
// CP→D, on request: a scoped, short-lived upload/download grant
const ScopeAttestation = z.object({
  machineId: z.string().uuid(),
  scope: z.enum(['attachment.put', 'attachment.get', 'facts.put']),
  resourceRef: z.string(), // opaque object key/prefix
  jws: z.string(), // signed capability the store verifies offline
  exp: z.string().datetime()
})
```

### 3.3 `register` (REQ, D→C) → `register/ok` (REP, C→D)

Capability upload + the **reconcile snapshot**. Sent immediately after `auth/ok`, and again on any reconnect where `resume.accepted == false`.

```ts
const RegisterReq = z.object({
  host: z.string(), // hostname (display only)
  capabilities: z.object({
    platforms: z.array(z.enum(['slack', 'telegram'])), // D3 adapters present
    runtimes: z.array(z.string()), // e.g. ["claude","codex"] — ACP/CLI harnesses installed
    acp: z.boolean(), // can this daemon host ACP sessions (D6)?
    features: z.array(z.string()).default([]) // e.g. ["cli-wrapper-fallback","worktree-iso"]
  }),
  maxAgents: z.number().int(), // concurrency ceiling for placement (C3)
  localState: z.object({
    // what the daemon currently believes it owns (for reconcile)
    assignments: z.array(z.string()), // sessionKeys it is actively serving
    crons: z.array(z.string()), // cronIds it has scheduled
    leases: z.array(z.string()) // leaseIds it holds
  })
})

const RegisterOk = z.object({
  routingEpoch: z.number().int(), // version of the routing table this snapshot reflects
  // Authoritative reconcile snapshot — daemon converges its local cache (D11) to this:
  assignments: z.array(RouteAssign), // the route/assign set the daemon SHOULD own (see §5)
  agents: z.array(AgentSpec.extend({ agentId: z.string().uuid() })).default([]), // full agent-config replica the daemon converges to — direct-edge launch needs it (§8.2a)
  crons: z.array(CronUpsert), // the cron set it SHOULD run
  leases: z.array(SecretsGrant), // secret leases it SHOULD hold
  drop: z.object({
    // things in localState the CP says to release
    assignments: z.array(z.string()),
    crons: z.array(z.string())
  })
})
```

The example shows only the reconciliation fields relevant to this section.
`localState` also reports daemon replicas, and `register/ok` carries the
configuration, integration, MCP, memory, relay, and collaboration snapshots
defined in `packages/protocol/src/frames/register.ts`.

**Reconcile contract:** `register/ok` is the **source of truth**. On receipt the daemon: (1) starts/keeps every assignment & cron in the snapshot, (2) releases everything in `drop`, (3) adopts `routingEpoch` as its current routing fence. **CP wins all conflicts.** This makes reconnect convergence idempotent — re-issuing the same snapshot is a no-op.

**Multi-org reconnect (install-wide members).** On a frame-mode connection `register/ok` is the **combined multi-org snapshot** (k8s-daemon-pool.md D9): the frame itself is install-wide and carries no envelope `orgId`, while every payload entry — agent spec, cron, integration, MCP and memory definition, collaboration route — names its own organization, and the roster is the union `pinned-to-me ∪ agents in the duties I hold` across every org the member serves, with ownership-aware `drop` sets for what moved or was deleted while it was away. Agent entries carry the current `Agent.configRevision`, so the daemon's `stale|conflict|idempotent|apply` compare converges edits missed offline. Two revision-fenced streams on the same connection finish the job: the register-time visibility replay re-sends the capture-gate set per organization as org-scoped `session/visibility/snapshot` frames, and the first heartbeat's duty exchange re-issues missing or stale-term grants revision-stamped (`frames/duty.ts`; k8s-daemon-pool.md §5), so the member refetches only frozen bundles. There is no `subscribe(org)`, org room, or per-org socket; `packages/control-plane/test/protocol/multi-org-reconnect.test.ts` pins the property end to end.

### 3.3a `capabilities/update` (EVT, D→C)

A fire-and-forget full-replace of the connection's registered
`RegisterReq.capabilities`. `register` computes the daemon's feature set
_before_ the reconcile roster is applied and _before_ the background runtime
probe sweep runs, so any feature derived from either would otherwise stay
hidden until the next reconnect. The daemon re-announces whenever its computed
capability set changes mid-connection (after an agent reconcile or a probe sweep;
suppressed when nothing changed); the CP replaces its live-index copy and the durable C4 row,
exactly like the register value it refreshes. An older CP answers
`error{UNKNOWN_FRAME}`, which the daemon ignores — the feature then simply
waits for the next register.

---

## 4. Fencing and delivery locality

The daemon↔CP WebSocket carries no live platform prompts or ACP update streams.
Platform adapters, relay ingress, and local crons admit work directly at the
daemon, so thread ordering and freshness remain daemon-local. Explicit,
authorized BFF read requests may proxy bounded daemon-local content as described
in section 7.6. The control wire protects orchestration state with
`sessionEpoch`, correlated request IDs, idempotent reconciliation, and
`launchId`.

### 4.1 Ordering and reconciliation

There is no per-agent control-wire sequence number. Surviving control frames are
idempotent, and `register/ok` supplies the authoritative full snapshot after a
reconnect. Requests that require acknowledgement use the envelope `id`/`corr`
pair; a retry reuses the same request ID so handlers can converge without
duplicating state.

### 4.2 Control-frame envelope extension

Fenced C→D frames carry an extra block alongside `payload`:

```ts
const ControlExt = z.object({
  epoch: z.number().int(), // sessionEpoch this frame was issued under (§3.1 fencing)
  agentId: z.string().uuid().optional(), // present on agent-scoped frames
  launchId: z.string().uuid().optional() // per-launch fence, see §4.4
})
```

Daemon validation order on any control frame: **epoch** (reject `STALE_EPOCH` if `< current`) → **launchId** (reject `STALE_LAUNCH` if not the active launch) → apply. Each rejection is a correlated `error` reply; the CP reconciles.

### 4.3 Body-locality boundary

No frame in `FRAME_SCHEMAS` delivers an agent prompt. Sessions start and take
turns through daemon-owned ingress: platform adapter → local router → ACP host,
webchat/shared-bot/hook relay → daemon, or the local cron scheduler. This
structurally prevents CP from observing or retransmitting message content.

### 4.4 `launchId` fencing (agent lifecycle)

A **launch** is one running instance of an agent process/session on the daemon.
When the daemon starts or restarts an agent, it mints a new `launchId` and
reports it through `agent/launched`. CP records that value as the current fence.
Later agent-scoped lifecycle or activity frames carrying an older `launchId`
are rejected as `STALE_LAUNCH`, so a dead process cannot mutate the state of its
replacement.

```ts
const AgentLaunched = z.object({
  // D→C, EVT
  agentId: z.string().uuid(),
  launchId: z.string().uuid(), // new fence value
  acpSessionId: z.string().optional(), // present for a long-lived ACP session
  startedAt: z.string().datetime(),
  runtime: z.string() // e.g. "claude" / "codex"
})
```

The launch remains stable across turns for the running ACP host.
`acpSessionId`, when present, identifies the long-lived ACP session associated
with that process.

### 4.5 Thread freshness

The daemon both observes the live conversation position and prompts the agent.
No CP-computed thread watermark crosses this wire, so thread convergence and
same-session admission remain entirely daemon-local.

---

## 5. Routing & orchestration (C→D control)

These are the C3 Orchestrator → daemon frames. They mutate the daemon's local
routing table (cached in D11). Control requests are epoch-fenced; frames tied to
a running process may additionally carry `agentId`/`launchId`.

### 5.1 `route/assign` (C→D, REQ) → `route/assign/ack` (D→C, REP)

"This session belongs to you — take over its platform send/recv yourself." (design §6.1)

```ts
const SessionKey = z.object({
  platform: z.enum(['slack', 'telegram']),
  channel: z.string(),
  thread: z.string().optional() // absent = channel-root
})

const RouteAssign = z.object({
  // also appears in RegisterOk.assignments[]
  sessionKey: SessionKey,
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(), // which D9 workspace to prepare
  bindRules: z
    .array(
      z.object({
        // trigger matching for this binding
        match: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('mention') }),
          z.object({ kind: z.literal('dm') }),
          z.object({ kind: z.literal('keyword'), value: z.string() }),
          z.object({ kind: z.literal('auto') }) // alert-channel auto-handle
        ])
      })
    )
    .default([])
})

const RouteAssignAck = z.object({ ok: z.boolean(), sessionKey: SessionKey, reason: z.string().optional() })
```

### 5.2 `route/update` (C→D, EVT)

Bulk routing-rule / table refresh (e.g. trigger-rule change from the Web UI). Carries `routingEpoch`; the daemon applies and bumps its cached table version. Idempotent — re-applying the same `routingEpoch` is a no-op.

```ts
const RouteUpdate = z.object({
  routingEpoch: z.number().int(),
  rules: z.array(z.object({ match: z.unknown(), agentId: z.string().uuid() }))
})
```

### 5.3 `daemon/drain` (C→D, REQ) → `drain/progress` (D→C, EVT\*) → `drain/done` (D→C, REP)

Graceful scale-down / rebalance (design §6.1 `drain`). The daemon stops accepting new assignments matching the scope, lets in-flight turns finish (or hard-stops at `deadline`), releases the assignments back to the CP, then the CP reassigns elsewhere.

```ts
const Drain = z.object({
  scope: z.union([
    z.object({ kind: z.literal('agent'), agentId: z.string().uuid() }),
    z.object({ kind: z.literal('daemon') }), // whole-daemon drain (shutdown/upgrade)
    z.object({ kind: z.literal('session'), sessionKey: SessionKey })
  ]),
  deadline: z.string().datetime() // hard cutoff; in-flight turns past this are cancelled
})
const DrainProgress = z.object({ remaining: z.number().int(), drained: z.array(SessionKey) })
const DrainDone = z.object({ released: z.array(SessionKey) }) // CP may now reassign — fenced by new epoch
```

**Rebalance safety:** the CP only issues fresh `route/assign` for a released session **after** `drain/done` (or `deadline` + watchdog). Combined with `sessionEpoch` fencing, this guarantees no two daemons serve one session across a rebalance.

### 5.4 `cron/upsert` (C→D, REQ→ack) · `cron/remove` (C→D, REQ→ack)

A cron periodically triggers **one agent** with a synthetic prompt (`trigger`) to carry out some work. Cron sinks to the daemon (D5) so it fires even when the CP is down (design §6.1). The CP owns the _definition_ and routes it to the **owning agent's daemon** (via `agentId` placement, same scope rule as `integration/upsert`); the daemon owns _firing_ + last-run persistence (D11).

```ts
const CronUpsert = z.object({
  cronId: z.string().uuid(),
  agentId: z.string().uuid(), // the agent this cron drives — routes the def to its daemon
  schedule: z.string(), // croner expression interpreted in timezone
  timezone: z.string(), // resolved IANA timezone; daemon computes UTC fire instants
  // target comes from the owning agent's integrations: integrationId picks the bot
  // connection that posts the anchor; absence selects the first integration.
  target: z
    .object({
      platform: z.enum(['slack', 'telegram']).default('slack'),
      channel: z.string(),
      integrationId: z.string().uuid().optional()
    })
    .optional(),
  trigger: z.string(), // synthetic prompt text injected on fire
  enabled: z.boolean().default(true)
})
const CronRemove = z.object({ cronId: z.string().uuid() })
```

On receipt the daemon keeps the definition in its in-memory CP cron registry and
reconciles the local Scheduler (D5). `register/ok.crons[]` re-converges the set
after reconnect or daemon restart; `drop.crons[]` prunes stale entries. No CP cron
definition is written to `agent.json`.

On fire — **no CP round-trip**:

- **With `target`**: the daemon posts the `trigger` text as a real message in that channel (the anchor), then starts/resumes the agent's session **threaded under the anchor** so the agent's replies land there — equivalent to a user posting the trigger in-channel.
- **Without `target`**: a headless fire — the agent runs the work in its workspace session with no platform output (transcript still recorded, outcome visible in the console).

The outcome is reported via `event/session` / `usage/report`. Each fire of a CP-owned cron is additionally reported via **`cron/report`** (D→C EVT, fire-and-forget) so the console's `lastRunAt` and run history converge: the FIRE report (`{cronId, agentId, firedAt}`) stamps `lastRunAt` (latest-wins, scoped to the owning agent's daemon) and opens a run row, and the COMPLETION report (same key + `{status, durationMs, sessionId?, reason?}`) closes it when the dispatched turn ends. The CP copy is advisory display history; D11 stays authoritative, and the daemon re-asserts its stored fire stamps on reconnect to cover fires while the CP was unreachable. The console's "Run now" sends **`cron/run`** (C→D REQ `{cronId}` → ack): the daemon acks acceptance and fires asynchronously — outcome arrives as normal `cron/report`s. Missed-fire compensation (daemon was down across a scheduled tick) uses D11 last-run: default policy is skip stale, fire next.

---

## 6. Secrets (C5 ↔ D10)

Lease-based, no plaintext on the wire or in PG (design §6.6). The frame carries a **reference** to a Vault/KMS path, not the secret.

```ts
const SecretsRequest = z.object({
  // D→C, REQ — daemon asks for a lease at session start
  scope: z.object({ platform: z.enum(['slack', 'telegram']), workspaceId: z.string().uuid() })
})
const SecretsGrant = z.object({
  // C→D, REP (also in RegisterOk.leases[])
  leaseId: z.string().uuid(),
  scope: z.object({ platform: z.string(), workspaceId: z.string().uuid() }),
  ref: z.string(), // Vault/KMS path or handle — NOT the secret
  ttl: z.number().int(), // seconds
  renewBeforeSec: z.number().int() // daemon should renew this many sec before expiry
})
const SecretsRenew = z.object({ leaseId: z.string().uuid() }) // D→C REQ → new SecretsGrant
const SecretsRevoke = z.object({ leaseId: z.string().uuid(), reason: z.string() }) // C→D EVT (hot revoke)
```

**Lease-expiry behavior.** If renewal fails before TTL expiry the daemon **fails closed** for that scope: it stops platform send/recv on bindings using that lease, marks them `degraded` in the next `heartbeat`, and surfaces it for the dashboard — it does **not** continue on an expired credential. Existing in-memory secret material is zeroized on revoke/expiry. On `SecretsRevoke` the daemon drops the material immediately and pauses affected bindings.

---

## 7. Telemetry, facts & local-autonomy (D→C)

### 7.1 `heartbeat` (D→C, EVT)

```ts
const Heartbeat = z.object({
  load: z.object({ cpu: z.number(), mem: z.number(), agents: z.number().int() }),
  health: z.enum(['ok', 'degraded']),
  activeSessions: z.number().int(),
  degradedScopes: z.array(z.string()).default([]) // e.g. expired-lease bindings (§6)
})
```

### 7.2 `event/session` (D→C, EVT) — session-metadata sync (dashboard + deep links)

This frame carries the converged session lifecycle — start / plan / problem /
end + link. It is _not_ the message stream; it is the metadata feed the Web UI
renders. Sessions are created on daemon ingress, so this is also how the CP
learns a session exists: it upserts one `SessionMeta` row per `sessionId`
(latest-wins, idempotent). The `sessionKey` echo
(platform/channel/thread) identifies the source conversation.

```ts
const EventSession = z.object({
  sessionId: z.string(), // ACP session id (agent-assigned string, NOT a UUID — matches usage/report)
  agentId: z.string().uuid(),
  launchId: z.string().uuid().optional(), // ties the event to its launch (§4.4)
  phase: z.enum(['start', 'plan', 'problem', 'end']),
  platform: Platform.optional(), // sessionKey echo — where the session lives
  channel: z.string().optional(),
  thread: z.string().optional(),
  link: z.string().optional(), // deep-link to detail view
  summary: z.string().optional(), // short, human-facing milestone text
  ts: z.string().datetime()
})
```

The exact schema in `packages/protocol/src/frames/telemetry.ts` also carries
the dashboard metadata and effective execution configuration. It remains
metadata-only. The reporting daemon is not echoed; CP stamps `daemonId` from
the authenticated WebSocket connection. CP accepts `event/session` and
`usage/report` only when the reported agent is currently placed on that daemon,
with placement moves excluded while the write runs. A `sessionId` is bound to
the first accepted `agentId` and can never be reassigned by a later report.

A usage report's `costAmount` is money, so it may be either a fixed-point
decimal STRING (unsigned, non-exponential, up to 20 integer and 18 fractional
digits) or a JSON number, and the CP's ingress normalizes it to the decimal
string before anything accumulates. Storage is `NUMERIC(38,18)` and range
aggregates diff and sum in decimal, so no cost passes through binary floating
point after the edge. The number branch exists for daemons that predate the
string; an amount that cannot be normalized drops the cost and keeps the
session's token counts.

Phase state machine: `start → (plan ↔ problem)* → end`. The daemon collapses
ACP `session/update` streams into these milestones; CP persists the metadata,
never the stream. `GET /sessions/:id` and `GET /sessions` read that stored
metadata. `GET /sessions/:id/messages` remains a live daemon pull (§7.6).

### 7.3 `facts/runtime-profile` (D→C, EVT) — runtime-profile facts feed (deprecated)

CP accepts this per-runtime frame for protocol compatibility. Daemons publish
the authoritative full snapshot through `facts/daemon-runtimes` (§7.3a), whose
entries use `FactsRuntimeProfile`.

Uses an observed runtime-profile pattern. The daemon reports the **observed capabilities of an installed runtime** (model ids, context window, tool-calling support, ACP coverage), so the CP/registry knows what each machine can actually run without the CP probing the harness itself.

```ts
const FactsRuntimeProfile = z.object({
  runtime: z.string(), // "claude" / "codex" / ...
  version: z.string(),
  models: z.array(z.string()),
  contextWindow: z.number().int().optional(),
  acpSupport: z.enum(['full', 'partial', 'none']),
  toolCalling: z.boolean()
})
```

### 7.3a `facts/daemon-runtimes` (D→C, EVT) — full runtime snapshot (replace)

The daemon's only runtime-facts feed: emitted right after each register (with
whatever models are cached — empty on first connect) and again once the
background probe sweep completes with the learned `models[]`. Carries
**replace semantics**: the CP reconciles its stored runtime list for the
daemon to exactly `runtimes[]` — every entry upserted, absent runtimes
**pruned** — so a runtime uninstalled from the machine stops being offered by
the console. Idempotent (latest-wins). A single full snapshot keeps pruning and
upsert ordering atomic.

```ts
const DaemonRuntimes = z.object({
  runtimes: z.array(FactsRuntimeProfile),
  mcpServers: z.array(FactsMcpServer).default([]), // daemon-level MCP snapshot, REPLACE
  seq: z.number().int().optional() // per-connection monotonic ordinal; CP drops stale snapshots
})
```

`FactsRuntimeProfile` also carries the discovered model/config capability
matrix, the source of the model list, and an optional `authRequired` flag. The
flag is set only by an ACP authentication rejection; a timeout or unrelated
probe failure does not establish login state. An auth-rejected curated runtime
is excluded from launch admission but remains in the reported snapshot so the
console can show that interactive login is required. Exact fields and emission
rules live in `packages/protocol/src/frames/telemetry.ts`; see also
[runtime-model-catalog.md](runtime-model-catalog.md).

### 7.4 `agent/activity` (D→C, EVT) — activity-probe

Lightweight "is this launch actually doing work" signal between `event/session` milestones, so the dashboard distinguishes _working_ from _stuck/idle_. Cheap; throttled (≤1/agent/heartbeat).

```ts
const AgentActivity = z.object({
  agentId: z.string().uuid(),
  launchId: z.string().uuid(),
  state: z.enum(['thinking', 'tool_call', 'awaiting_permission', 'idle']),
  ts: z.string().datetime()
})
```

### 7.5 Local autonomy and degraded operation

On WS drop the daemon enters **DEGRADED** (local autonomy, D1):

- **Keeps serving** existing assignments from the D11 routing cache; cron keeps firing; in-memory secret leases used until TTL.
- **Pauses** consuming new orchestration: no new `route/assign` (none arrive anyway), no rebalance.
- **Buffers** outbound telemetry (`event/session`, `facts/*`, acks) in D11; flushes on reconnect.
- **Reconnect:** `auth{resume:{lastEpoch}}` → the CP answers `resume.accepted:false` and a full `register` reconcile (§3.3) re-aligns everything. **Split-brain guard:** the CP withholds reassignment of this daemon's sessions for `reassignGraceSec` after it goes unreachable, and `sessionEpoch` fencing rejects any control that crossed the gap.

### 7.6 `session/list` + `session/history` (C→D, REQ → REP) — console session views

The CP stores **session metadata only** — `session_meta` rows synced by the
`event/session` snapshots above (§7.2). Sessions are created on daemon ingress,
while transcripts, tool payloads, and attachment bytes live solely in the
daemon's local store. The two console views therefore split:

- **The list** (`GET /sessions`) is a **CP database read** of the stored metadata — cursor-paginated (activity-ordered) and filtered by each Session's audience, independently from owning-Agent Team visibility — with no daemon round-trip; it works with every daemon offline.
- **The transcript** (`GET /sessions/:id/messages`, plus large tool bodies) remains an on-demand pull from the owning daemon over `session/history` / `session/tool-body`, proxied to the UI and never persisted. `session/list` is a daemon-side read-back frame and does not serve the console list.

```ts
// ── list: the daemon's live sessions (read-back; the console list is a DB read, see above) ──
const SessionListItem = z.object({
  sessionId: z.string(), // ACP session id — opaque string, NOT a UUID
  sessionKey: SessionKey, // platform/channel/thread — the "integration · channel" column
  agentId: z.string().uuid(),
  title: z.string().optional(),
  status: z.string().optional(), // "plan" / "completed" / "awaiting approval" / …
  lastActivityAt: z.string().optional(),
  tokenUsage: z.number().int().optional(), // the TOKENS column
  triggeredBy: z.string().optional() // the "who triggered the run" sub-line
})
const SessionListReq = z.object({ agentId: z.string().uuid().optional() }) // C→D REQ; omit ⇒ all this daemon's
const SessionListPage = z.object({ sessions: z.array(SessionListItem) }) // D→C REP (corr = req id)

// ── history: one cursor page of a session's transcript ──
const SessionHistoryReq = z.object({
  // C→D REQ
  agentId: z.string().uuid().optional(), // current CP sends the authorized owner; optional only for rolling upgrades
  sessionId: z.string(), // ACP session id — opaque string, NOT a UUID
  cursor: z.string().optional(), // opaque; omit ⇒ newest page
  limit: z.number().int().positive().max(200).default(50)
})
const SessionMessage = z.object({
  seq: z.number().int(),
  sender: z.string(),
  ts: z.string(),
  kind: z.string(),
  text: z.string()
})
const SessionHistoryPage = z.object({
  // D→C REP (corr = req id)
  sessionId: z.string(),
  messages: z.array(SessionMessage), // oldest→newest within the page
  nextCursor: z.string().optional() // absent ⇒ no older messages
})
```

The exact shapes in `packages/protocol/src/frames/session.ts` include structured
usage, display and deep-link metadata, sender names, and tool-body references.
`session/tool-body` / `session/tool-body/chunk` stream large tool payloads
separately.

**List** (`GET /sessions`): a **CP database read** of the
`event/session`-synced metadata — cursor-paginated, ordered by last activity,
scoped by each Session's audience; `agentId`/`platform`/`channel` filters narrow
the set. An Agent id is only a storage/filter key here and its Team visibility
does not hide an otherwise readable Session. No daemon is contacted.

**History** (`GET /sessions/:id/messages?cursor=&limit=`): the CP loads the
`session_meta` row, authorizes its Session audience, and resolves its recorded
daemon; `session/history` carries the owner `agentId` so the daemon can verify
the `(agentId, sessionId)` binding before returning content. Cursor-based,
newest-first. If the agent is unplaced or its daemon is offline → 503 (the list
still works; only that transcript is unavailable). This is an explicit, bounded
content-read path: the Control Plane proxies the reply without persisting it.
The memory and workspace read families follow the same locality rule.

`agentId` remains optional on these two wire requests only so a new daemon can
still serve an older CP during a rolling upgrade. The daemon logs that legacy
path and uses the pre-binding lookup. Current CPs always send the owner; once
present, the daemon fails closed on an `(agentId, sessionId)` mismatch.

### 7.7 `channel/agents` (D→C, REQ → REP) — agent collaboration directory

So agents can collaborate, an agent needs to know **which peers it may reach** and what each does. A daemon-side agent tool (`listAgents`, deprecated alias `listChannelAgents`) issues `channel/agents`; the CP is the **only authority for the full roster** (peers may run on different daemons — `register/ok.agents[]` is scoped to each daemon's own agents, §3.3), so the daemon asks the CP rather than answering locally. Metadata only (name / displayName / description / status) — never message content. Direction is daemon→CP (like `auth`/`register`): the daemon sends the REQ, the CP replies `channel/agents/ok` (corr = req id).

```ts
const ChannelAgent = z.object({
  agentId: z.string().uuid(),
  name: z.string(), // slug
  displayName: z.string().optional(),
  description: z.string().optional(), // what the agent does
  status: z.enum(['active', 'inactive', 'paused'])
})
const ChannelAgentsReq = z.object({
  platform: Platform,
  channel: z.string().optional(), // OPTIONAL — absent ⇒ the org-wide directory
  requesterAgentId: z.string().uuid()
}) // D→C REQ
const ChannelAgentsOk = z.object({
  platform: Platform,
  channel: z.string().optional(), // echoes the REQ's scope; absent when org-wide
  agents: z.array(ChannelAgent)
}) // C→D REP
```

**`channel` is optional, and that is the whole scope switch — two scopes, one roster.**
Both are computed from the same org read and the same filter, so they can never
answer differently about a given agent:

- **absent → the ORG-WIDE peer directory** (`AgentRepo.orgDirectory`). The default.
  Channel membership plays no part, so a session with no IM integration at all
  (`webchat` / `hook` / `dream`, or a memory-only agent) can still discover peers.
  The REP omits `channel`.
- **present → the same directory, additionally narrowed to agents in that
  channel** (`IntegrationRepo.agentsInChannel`). A filter, never a gate. A
  session-identity platform has no persisted integration, so a channel filter on
  one of those yields an empty roster (short-circuited before persistence — a repo
  throw here would close the whole control socket).

The daemon derives `requesterAgentId` and `platform` from trusted MCP session
context; `channel` is the only agent-supplied field and it can only narrow the
answer. The roster is **policy-filtered, not membership-gated**: within the
requesting daemon's own organization, an entry survives iff the requester's
outbound policy admits it **and** its own inbound `callPolicy` admits the
requester — and the requester is required to appear in the roster it asks about,
so an unknown requester fails **CLOSED** (empty). A requester always sees itself.
Discovery _is_ the authorization surface: a peer that fails the predicate is
omitted entirely, never listed-but-uncallable, so an agent still cannot probe
peers it may not call and cross-org never resolves. `Agent.visibility` /
`sharedWith` is deliberately **not** consulted — that governs human console
access, so a `restricted` agent is still a discoverable, callable peer.

`listAgents` cannot use tool input to impersonate another requester or probe
another platform.

**Feature negotiation.** Only a CP advertising `agent-directory-org-scope-v1` in
`register/ok.serverFeatures` (§3.3) accepts the channel-less form and ships the
flat `collabRoutes.agents[]`. A daemon that does not see the feature substitutes
the caller's trusted **current** channel — today's pre-change behavior — rather
than sending a payload an older CP would reject. An explicitly requested `channel`
filter is passed through to either CP unchanged. See
[`agent-collaboration-implementation.md`](agent-collaboration-implementation.md)
§2.2/§2.5 for the predicate and the rest of the rolling-upgrade rules.

---

## 8. Capability scoping & fleet control

### 8.1 Per-launch capability scoping

`AgentLaunch.capabilities` carries the active-capability pin in each launch directive. This is the **enforcement locus** for our otherwise-unenforced `Agent.permissions`: the daemon enforces that array at the MCP/CLI tool boundary (D8) and on platform actions, then reports violations as `agent/scope-denied`.

```ts
const AgentLaunch = z.object({
  // Other launch fields omitted here; see §8.2 for the complete shape.
  agentId: z.string().uuid(),
  capabilities: z.array(z.string()) // e.g. ["message.send","task.claim","attachment.put"]
})
```

A tool/action outside `AgentLaunch.capabilities` → the daemon refuses locally and emits `agent/scope-denied` (D→C, EVT) `{agentId, launchId, capability}` for audit. No CP round-trip on the hot path.

### 8.2 Launch control: `agent/launch` (C→D, REQ) → `agent/launched` (D→C, REP/EVT)

The CP tells the daemon to bring an agent up. The frame carries the runtime,
capability pin, and **agent spec** — the CP-owned definition the daemon needs
to run it (prompt / model / **workspace**). The daemon synthesizes the system
prompt locally from that spec.

```ts
// Where the agent runs. The PATH is always daemon-generated — never specified
// by the caller. Two modes (§8.2b):
const AgentWorkspace = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('scratch'), // fresh empty working dir, no default repo
    gitCredential: z.enum(['github-app']).optional() // explicit authorized repos only
  }),
  z.object({
    mode: z.literal('github'), // daemon clones the repo and runs the agent in agentDir
    gitRepo: z.string(), // e.g. github.com/acme/infra
    branch: z.string().default('main'),
    agentDir: z.string().optional() // subdir within the repo (repo-root if omitted)
  })
])
const AgentSpec = z.object({
  name: z.string(),
  description: z.string().optional(), // system-prompt seed; daemon appends to its standing prompt
  runtime: z.string().optional(), // which ACP runtime to run, e.g. "claude" / "codex"
  model: z.string().optional(), // runtime model, e.g. "opus"
  reasoningEffort: z.string().optional(),
  executionMode: z.string().optional(), // e.g. "byoc"
  workspace: AgentWorkspace.optional(), // where it runs; absent ⇒ daemon defaults to scratch
  env: z.record(z.string(), z.string()).optional()
})
const AgentLaunch = z.object({
  // C→D, carries ControlExt(epoch)
  agentId: z.string().uuid(),
  runtime: z.string(), // must be in RegisterReq.capabilities.runtimes
  workspaceId: z.string().uuid(),
  capabilities: z.array(z.string()), // the active-capability pin (§8.1)
  spec: AgentSpec, // prompt/model/workspace arrive at start — no separate CRUD needed
  mode: z.enum(['long_lived', 'per_turn']).default('long_lived')
})
const AgentStop = z.object({ agentId: z.string().uuid(), launchId: z.string().uuid(), reason: z.string() })
```

> **§8.2b Workspace modes (daemon-owned path).** The agent's working directory is **always allocated by the daemon** — the CP/UX never sends a path. The UX picks one of two modes:
>
> - **`scratch`** — the daemon creates a fresh empty working dir on the machine; there is no default repo. When `gitCredential: 'github-app'` is present, git/gh may request only repositories in the agent's explicit repo allowlist; a repo-less credential request is rejected.
> - **`github`** — the daemon clones `gitRepo` at `branch` (path daemon-generated) and runs the agent in `agentDir`, a subdir of the checkout (repo-root if omitted).
>
> **Multiple agents may share one repo.** "Shared repo" is not a shared entity — it is simply two agents whose `workspace.gitRepo` matches but whose `agentDir` differs. So workspace config lives **inline on each agent** (it rides `AgentSpec`); there is no standalone workspace object on the wire. The daemon may de-dupe a single checkout per `(gitRepo, branch)` under the hood and point each agent at its `agentDir`, but that is a daemon-local optimization, invisible to this protocol.
>
> **Editable only through an explicit cold action.** `PATCH /agents/:id` still rejects workspace identity fields so they cannot silently change under a live session. The dedicated `PUT /agents/:id/workspace` action may switch either direction between scratch and GitHub, select another repository or branch, change `agentDir`, change `read|write` access, or bind a manual checkout to an App installation. Every edit drains and re-activates the agent and clears cached credentials. A mode, repository, or branch change deliberately replaces daemon-local workspace files and must be presented as irreversible before submission; an access- or `agentDir`-only edit preserves the existing checkout.
>
> `workspaceId` in `AgentLaunch`, `RouteAssign`, and `SecretsGrant.scope` is an
> opaque scope identifier whose value is the `agentId`. Workspace configuration
> itself is inline on the agent (`workspaceMode`, `gitRepo`, `gitBranch`, and
> `agentDir`).

> `mode` defaults to `long_lived`: one `agent/launch` brings up a persistent ACP
> host, daemon ingress supplies prompt turns, and `agent/stop` tears it down.
> `per_turn` launches and stops the host around one turn for stronger isolation
> at higher latency and lifecycle traffic.

> The spec rides `agent/launch` and is also replicated proactively through the
> reconcile roster plus `agent/upsert` / `agent/remove`. This lets daemon ingress
> launch an agent without a CP round-trip.

### 8.2a Live agent CRUD: `agent/upsert` · `agent/remove` (C→D, EVT)

The console edited an agent's spec; the CP pushes it. `agent/upsert` carries the full new spec; `agent/remove` tears the agent down. The CP remains source of truth (REST C2); the daemon applies the spec in memory and deletes only a same-id local `agent.json`. Other local agent files remain user-owned.

```ts
const AgentUpsert = z.object({ agentId: z.string().uuid(), spec: AgentSpec }) // C→D, ControlExt(epoch,agentId)
const AgentRemove = z.object({ agentId: z.string().uuid() }) // C→D, ControlExt(epoch,agentId)
```

> **Direct-edge launch requires a local replica.** Platform ingress connects
> directly to the daemon, which can start an agent with CP off the hot path. The
> daemon therefore holds a complete, current local replica of every assigned
> agent's configuration. CP keeps that replica converged through two mechanisms:
>
> 1. **Reconcile roster (authoritative).** `register/ok.agents[]` (§3.3) ships the full spec-set the CP wants this daemon to own on every connect/reconnect; the daemon converges its local replica to it (CP wins). This is the backstop that heals any missed delta.
> 2. **Live deltas (incremental).** On every REST mutation the CP emits `agent/upsert` (create/edit) or `agent/remove` (delete) to the agent's **owning daemon** (`Agent.daemonId`), best-effort. An unplaced agent (no owner yet) emits nothing — the roster carries it once placed; an offline daemon's `NoConnection` is swallowed — the roster heals it on reconnect.
>
> Together with the roster, `agent/upsert` / `agent/remove` form the
> agent-configuration replication path. Hot-apply differs by field:
> `name`/`description`/`model` take effect live; `runtime`/`capabilities` apply
> on the next launch.

### 8.2c Explicit placement cutover: `agent/detach` · `agent/activate` (C→D, REQ→ack)

An operator can move an agent to another READY daemon through the explicit placement API. This is a **hard cutover**, not daemon-local state transfer: the source closes admission, cancels active turns without waiting for a final reply, stops the host, closes integrations that lose their final reference, and archives the agent root outside discovery. Workspace, memory, transcript, and attachment bytes are not copied; the archived source `agent.json` has platform integrations scrubbed so stale bot credentials do not linger.

```ts
const AgentDetach = z.object({
  agentId: z.string().uuid(),
  moveId: z.string().uuid(),
  // Source placement cutover: cancel admitted turns instead of draining them.
  discardActiveTurns: z.boolean().optional(),
  // Optional scratch→GitHub guard.
  requireEmptyWorkspace: z.boolean().optional()
})

const AgentActivate = z.object({
  agentId: z.string().uuid(),
  moveId: z.string().uuid(),
  spec: AgentSpec,
  integrations: z.array(IntegrationSpec),
  crons: z.array(CronUpsert),
  // Optional scratch→GitHub materialization request.
  prepareWorkspace: z.boolean().optional(),
  // Preserve the checkout when mode/repo/branch matches the recorded materialization;
  // otherwise replace it with the authoritative scratch or GitHub target.
  reconcileWorkspace: z.boolean().optional()
})
```

For a placement move, the CP first sends an acknowledged source detach with `discardActiveTurns`. The source closes admission synchronously, cancels admitted turns without waiting for a final reply, stops their runtime authority, and archives its local replica. The CP then releases the source session assignments and compare-and-sets `Agent.daemonId`. No ACP session state, transcript, workspace, or memory bytes are copied or replayed; subsequent messages create fresh target sessions. The CP stages the target with `agent/detach` (an absent agent is valid), followed by one acknowledged authoritative `agent/activate` bundle. Both target requests use the same fresh `moveId`; a daemon persists that fence and rejects a late activate from a superseded move. Activation exact-converges CP integrations and CP crons, validates capacity/runtime/model/MCP support, warms the ACP host, and only then opens the dispatch gate.

An explicit force reassign is available only while the source is not READY. It
still attempts `agent/detach`, but an unavailable or negative source response is logged
and does not block the placement CAS. Session affinities are released before the CAS,
and every target-side readiness, capacity, compatibility, staging, activation, and
rollback fence above remains unchanged. The operator must separately confirm that the
source machine is permanently stopped: while it is disconnected, the CP cannot fence a
direct platform connection or erase its credential copies. If it reconnects after the
CAS, the authoritative placement snapshot gives it an ownership-aware `drop.agents`
detach for the stale local copy.

If target activation fails, the CP must positively detach the target before rolling placement back and reactivating the source; without that ACK it fails closed on the target to avoid split brain. A same-target API retry replays the authoritative bundle as a repair operation. Daemons advertise this hard-cutover lifecycle with the `agent-move-v1` feature; single-agent mode does not advertise it.

The workspace action reuses the same fence on the current daemon. Before detach, the daemon initializes a missing mode/repo/branch materialization marker without overwriting an existing one; the persisted spec may already be the target after a crash while the checkout still belongs to the recorded source. Activation with `reconcileWorkspace` preserves the current checkout when those fields are unchanged, so access and `agentDir` edits do not discard files. When mode, repository, or branch changes, a GitHub target is cloned and its `agentDir` validated in a sibling staging directory before the old workspace is removed; a scratch target is recreated empty. The ACP host starts only after reconciliation so its runtime and sandbox bind the new directory. A known activation NACK restores the DB definition and a valid empty base for the prior workspace, but intentionally cannot restore local files discarded by an acknowledged replacement; this is why the UI requires an irreversible warning. Clone/auth failure occurs before replacement and leaves the old workspace intact. An unknown response is never rolled back blindly, and the durable materialization marker makes a same-target retry preserve work created after a successful but unacknowledged activation. Memory, sessions, integrations, and other agent configuration are preserved. Supporting daemons advertise `workspace-edit-v2` and accept the workspace guard fields shown above.

### 8.3 Fleet control

CP-initiated daemon management is limited to restart, upgrade, and non-secret
configuration updates.

```ts
const DaemonRestart = z.object({ reason: z.string(), drainFirst: z.boolean().default(true) }) // C→D REQ
const DaemonUpgrade = z.object({ targetVersion: z.string(), drainFirst: z.boolean().default(true) }) // C→D REQ
// both → daemon drains (§5.3) then exits; the supervisor/installer (out of band) restarts/upgrades,
// and the new process reconnects with auth(resume). Reply: {accepted:boolean, willDrainUntil:datetime}
const ConfigPush = z.object({ keys: z.record(z.string(), z.unknown()) }) // C→D EVT — non-secret config (design §6.1 config/push)
```

Actual binary upgrade is **out of band** (npm/installer/supervisor). This
protocol triggers graceful drain and exit; it does not ship binary content.

---

## 9. Error model

Every REQ can be answered by an `error` REP (`corr` = request `id`). Errors are **typed and actionable**, not free text.

```ts
const ErrorFrame = z.object({
  code: z.enum([
    // protocol / framing
    'UNKNOWN_FRAME',
    'FRAME_TOO_LARGE',
    'PROTOCOL_STATE',
    'BAD_PAYLOAD',
    // auth / identity
    'AUTH_FAILED',
    'ATTESTATION_INVALID',
    // fencing / ordering
    'STALE_EPOCH',
    'STALE_LAUNCH',
    // delivery
    'NO_SESSION',
    'SCOPE_DENIED',
    // secrets
    'LEASE_EXPIRED',
    'LEASE_DENIED',
    // generic
    'RATE_LIMITED',
    'CONFLICT',
    'INTERNAL'
  ]),
  message: z.string(), // human-readable, redacted of secrets
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional() // machine-actionable context
})
```

The authoritative error enum is
`packages/protocol/src/frames/error.ts`.

**Close codes:** `4400` bad subprotocol/handshake · `4401` auth failed (don't auto-retry) · `4409` epoch conflict on handshake (do full reconcile) · `4415` unsupported encoding · `4429` rate-limited (backoff) · `1009` message too big (soft 256 KiB cap exceeded — a ws-library close, §1) · `1011` server internal · `1012` server restarting (reconnect with backoff). Reconnect uses exponential backoff with jitter, capped (e.g. 1s→30s), **except** `4401`, which requires a fresh credential first — an in-cluster daemon exits non-zero there instead, so its restart redials (§3.1).

---

## 10. Frame registry

`packages/protocol/src/frame.ts` and its `FRAME_SCHEMAS` object are the
complete frame registry. The table below is a navigation aid for the families
described in this document; integrations, relays, collaboration, hooks, review
delivery, MCP, memory, git credentials, workspace reads, tool bodies, and usage
have dedicated schemas under `packages/protocol/src/frames/`.

| Family                                                    | Direction     | Request/reply pattern                                 | Purpose                                                                       |
| --------------------------------------------------------- | ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `auth`, `register`                                        | D→C           | correlated replies                                    | establish identity and reconcile daemon state                                 |
| `heartbeat`, `facts/*`, `event/session`, `agent/activity` | D→C           | events                                                | report health, capabilities, metadata, and activity                           |
| `route/*`, `agent/*`, `cron/*`, `daemon/*`, `config/push` | C→D or paired | correlated requests, acknowledgements, and events     | mutate fenced daemon control state                                            |
| `secrets/*`                                               | paired        | request/grant plus revoke event                       | manage scoped secret leases                                                   |
| `session/*`                                               | paired        | correlated paginated reads                            | fetch daemon-local session data                                               |
| `session/visibility`, `session/visibility/snapshot`       | C→D           | correlated requests (`session/visibility/ok` / `ack`) | push CP-authoritative session privacy gate state (session-visibility.md §5.1) |
| `channel/agents`                                          | D→C           | correlated reply                                      | resolve collaboration directory metadata                                      |
| `error`, `ack`                                            | either        | correlated replies                                    | provide generic protocol outcomes                                             |

---

## 11. Implementation notes

- **Shared `protocol` package:** the zod schemas under
  `packages/protocol/src/frames/` are the single source of truth. They produce
  `z.infer` types for both daemon and CP, and `FRAME_TYPES` in `frame.ts` is the
  runtime guard at the socket edge.
- **Idempotency everywhere:** `register/ok`, `route/*`, `cron/*` are all reapply-safe (keyed by epoch/cronId/sessionKey) so reconnect reconcile is a convergence, not a replay hazard.
- **Body-locality invariant:** no frame carries live platform
  `NormalizedMessage.text` or ACP update streams through the message hot path.
  Explicit read families such as `session/history`, `session/tool-body`,
  `memory/*`, and `workspace/*` may return bounded daemon-local content to an
  authorized BFF request; the Control Plane proxies those replies and never
  persists them.
