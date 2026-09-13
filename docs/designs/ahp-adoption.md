# AHP Adoption — Webchat-First Client Session Sync

> **Status:** Proposal (issue [#1339](https://github.com/agentconnect-md/agentconnect/issues/1339)).
> Nothing in this document is implemented.
>
> **Scope.** How AgentConnect could adopt the
> [Agent Host Protocol (AHP)](https://github.com/microsoft/agent-host-protocol) as the
> client-facing session synchronization layer, starting with webchat. Extends
> [architecture.md](architecture.md) (the CP-off-the-hot-path invariant this proposal
> must preserve) and [session-concept.md](session-concept.md) §1.1 (the outward /
> ACP session id split the mapping in §4 builds on). Read
> [turn-final-context-refresh.md](turn-final-context-refresh.md) before §6 — the
> staged-answer workflow is deliberately **not** replaced here.
>
> **Non-goals.** Replacing IM platform renderers (Slack / Telegram / Discord /
> Feishu), agent-to-agent messaging, or any Control Plane surface. See §7.4.

## 1. Motivation

Issue #1339 asks whether AHP can "unify all session models". This document scopes
that question down to the part of the system AHP is actually shaped for: **how
human-facing clients observe and drive a live session**.

Today that job is done by three homegrown channels, each with its own wire
format, resume story, and consistency rules:

1. **The webchat transport** (`packages/daemon/src/webchat/transport.ts`). A
   daemon-owned streaming protocol over relay `rd/*` frames: per-turn monotonic
   `index` counters, a bounded replay ring (`WEBCHAT_REPLAY_MAX_EVENTS` = 256,
   1 MiB, 64 streams, 5-minute TTL), generation-fenced resume with
   `stream_gap` / `stream_cursor_invalid` / `stream_stale` failure reasons, and a
   `superseded` event that tells the browser to retract a discarded answer
   generation.
2. **CP BFF bounded reads** (architecture.md §"bounded reads"). The console's
   invalidate-and-refetch model: the CP proxies bounded transcript / tool-body /
   memory reads from the owning daemon over the control WS, with SSE pokes
   telling the browser *that* something changed but not *what*.
3. **Per-platform renderers.** Each IM platform folds the ACP update stream into
   platform-native edits through its `OutputConverger`.

Channels 1 and 2 exist because no standard covered "N clients observing one
authoritative agent session". AHP is exactly that standard. Channel 3 is *not*
in scope — an IM thread is a delivery target with platform-owned semantics, not
a synchronized client, and the renderers stay as they are (§7.4).

## 2. Background: what AHP is

AHP is a Microsoft-published protocol for synchronizing session state between an
**AHP host** (the process that owns agent sessions) and any number of **AHP
clients** (editors, web UIs, CLIs). Its core model:

- The host holds an **immutable authoritative state** per session; every change
  is a pure **reducer** application producing a new state.
- Each applied change increments a **`serverSeq`**; clients reconcile against it.
- Client-initiated writes use **write-ahead reconciliation**: the client applies
  optimistically, the host confirms or corrects.
- AHP layers **above ACP**: clients speak AHP to the host, the host speaks ACP
  to agent runtimes. The AHP guide describes the protocol as "a mutex over ACP" —
  it serializes and broadcasts what many clients see, while ACP remains the
  single execution channel underneath.

Client libraries exist in several languages; VS Code is currently the only
shipping *host* implementation. A daemon-side host is therefore real
engineering work, not an SDK drop-in (§8, §9).

## 3. Placement: the daemon is the AHP host

The one decision everything else follows from, and the reason #1339's "unify
all session models" cannot mean "the CP serves sessions":

- **The CP is never on the message hot path** (architecture.md). AHP traffic *is*
  the hot path — it carries live turn output. Hosting AHP on the CP would move
  message content into the CP, violating the defining invariant.
- The daemon already owns everything an AHP host needs: the authoritative
  transcript, the live ACP update stream, the turn queue, and the send boundary.
- The layering matches AHP's own guidance: client → AHP → host → ACP → runtime.

```text
Web console / IDE / CLI ── AHP ──► daemon ── ACP ──► runtime (claude / codex)
                                     │
       CP (unchanged) ◄── WS ────────┘  control signaling + metadata only
```

The CP keeps its current role untouched: registry, orchestration, and
metadata projection. It never terminates AHP.

## 4. Session identity mapping

AgentConnect already splits session identity three ways
(session-concept.md §1.1). AHP adds a fourth name; the mapping keeps the
existing privacy boundaries intact:

| Identity                  | Owner            | Visible to             | AHP mapping                                  |
| ------------------------- | ---------------- | ---------------------- | -------------------------------------------- |
| `acpSessionId`            | runtime + daemon | daemon only            | **never exposed** — host-internal, as today  |
| `outwardSessionId`        | daemon + CP      | console, deep links    | the **AHP session id**                       |
| `sessionKey` (dispatch)   | daemon           | daemon only            | unchanged — admission/serialization keying   |
| webchat `chatId` / stream | daemon + browser | webchat client         | subsumed by the AHP session + `serverSeq`    |

Rules:

- The AHP session id **is** the `outwardSessionId`. Every deep link and status
  payload already addresses this id; AHP clients get the same one.
- `acpSessionId` stays daemon-private. AHP does not change the rule that ACP
  ids never leave the daemon.
- One AHP session maps to one agent-scoped session. A multi-agent webchat
  conversation (webchat-multi-agents.md) is N AHP sessions observed by one
  client, not one merged AHP session — the roster stays a daemon concept.

## 5. Fencing correspondence

The webchat transport hand-built the consistency machinery AHP standardizes.
This table is the migration contract — each homegrown mechanism must map to an
AHP-native one before the old one can be deleted:

| Today (webchat transport)                                | AHP equivalent                                        |
| -------------------------------------------------------- | ----------------------------------------------------- |
| per-turn monotonic `index` on `WebchatOutput`             | `serverSeq` on every state change                     |
| `WebchatDone.lastIndex` gap detection                     | reliable ordered transport + failure-triggered resync (not seq continuity — see below) |
| replay ring (256 events / 1 MiB / 64 streams / 5 min TTL) | host state snapshot + change log since a `serverSeq`  |
| resume: `stream_gap` / `stream_cursor_invalid` / `stream_stale` | reconnect → snapshot fetch → reducer replay     |
| generation fencing on resume (claim before validate)      | host-side session epoch inside the AHP session state  |
| `superseded` event (discarded answer generation)          | a reducer that replaces the staged reply span (§6)    |
| invalidate + refetch SSE pokes (console BFF)              | AHP change notifications carrying the actual delta    |

One correction the reference host forces: **`serverSeq` is an ordering cursor,
not a completeness proof.** The VS Code host sequences across channels while a
client receives only its subscriptions, so a healthy client can observe
legitimate gaps (activity in a session it does not subscribe to). Loss
detection therefore cannot be "adjacent seq numbers", the way
`WebchatDone.lastIndex` works today. Instead, the
[AHP transport requirements](https://microsoft.github.io/agent-host-protocol/specification/transport.html)
put delivery on a reliable ordered relay that surfaces either-hop failure;
detected failure — not seq arithmetic — triggers replay/snapshot recovery. The
old checks are deleted only once the chosen transport meets that bar.

Two consequences worth calling out:

- **Resume gets strictly better.** Today a client that misses more than the
  replay ring's bound is fail-closed (`replayDisabled`). Under AHP the host can
  always serve a full snapshot, so "gap too large" degrades to "fetch snapshot",
  not "reload the page".
- **The console's read model inverts.** Bounded BFF reads are pull-after-poke;
  AHP is push-with-content. The CP's SSE invalidation channel for *live session
  views* becomes redundant in the end state (metadata lists stay on the CP).

## 6. What AHP does not solve: the staged answer

[turn-final-context-refresh.md](turn-final-context-refresh.md) exists because a
long turn can finish against a stale thread. The generation-side root cause is
an **ACP** gap: once `session/prompt` is in flight there is no standard way to
inject new context mid-turn — the only lever is cancel. AHP layers *above* ACP
and never touches the host↔runtime edge, so:

- `stageAnswer` / `webchatRefresh` and the regeneration loop in
  `runPromptLoop` are **retained unchanged**.
- What AHP improves is the **presentation side** of a discarded generation.
  Today `superseded` is a bespoke webchat event every client must special-case.
  Under AHP, discarding a staged generation is an ordinary reducer application:
  the host replaces the staged reply span in the authoritative state, bumps
  `serverSeq`, and every client — including one that reconnected mid-discard —
  converges by the same reconciliation path it uses for everything else.
- Mid-turn context injection remains an upstream ACP conversation (§8), not an
  AHP one.

## 7. Incremental adoption plan

### 7.1 Phase 0 — shadow reducer (spike, no behavior change)

Add an AHP state projection as an additional consumer on the turn's `Pending`
fan-out in `onAcpUpdate`, next to the existing webchat sink / converger /
transcript recorder. It folds the masked update stream into an AHP session
state and logs `serverSeq` progression. Nothing reads it yet. This proves that
one update stream can drive an AHP host without disturbing the existing
surfaces, and it inherits the secret-masking boundary for free (masking runs
before all consumers).

The ACP update stream alone is **not** a sufficient input. Daemon-owned
lifecycle events never traverse `onAcpUpdate`: `runPromptLoop` discards a
staged generation by resetting `p.webchat.replyText` / `p.reply.text` and
emitting `superseded` directly through the webchat sink. A projection attached
only to the update fan-out would retain the discarded generation and append
the replacement. Phase 0 therefore taps both inputs — the masked ACP updates
*and* the daemon's discard/reset events at the same points the webchat sink
learns of them — which is exactly the reducer §6 calls for.

Exit criteria: state parity checks against the webchat `replyText` accumulator
across the daemon test suite, including staged-answer discard turns.

### 7.2 Phase 1 — webchat over AHP

Replace the webchat transport's wire protocol with AHP for new conversations,
behind a feature flag; the `rd/*` relay path keeps carrying the frames (AHP is
transport-agnostic — the relay stays a dumb forwarder and persists nothing).
The replay ring, `index` counters, and resume state machine are deleted only
after the flag defaults on and the fencing table in §5 is fully covered by
tests.

### 7.3 Phase 2 — console live session views

The console's live transcript / tool-body views move from CP-proxied bounded
reads + SSE pokes to an AHP client connection to the owning daemon (reusing
the same authorization the BFF read path enforces today). "Connection to the
daemon" cannot mean a literal browser→daemon dial: self-hosted daemons sit
behind NAT and only dial out, and managed-pool daemons are cluster-internal.
Phase 2 therefore needs an explicit data-plane route — the natural candidate
is the relay path Phase 1 already rides (the relay stays a content-blind
forwarder), which preserves the CP-off-the-hot-path invariant in both
deployment modes. CP-side metadata lists (sessions, agents, orgs) are
unaffected.

### 7.4 Explicit non-goals

- **IM renderers.** A Slack thread is not a synchronized client; convergers
  stay. AHP would add machinery without removing any.
- **Agent-to-agent messaging.** `messageAgent` semantics (trust, hops,
  correlation) are delivery concerns, not state sync.
- **The CP.** No AHP termination, no message content, no new persistence.

## 8. Gaps to raise upstream

Mapping §5 surfaces capabilities AgentConnect needs that AHP (as published)
does not obviously specify. Each should become an upstream issue before
Phase 1 hardens:

1. **Staged-generation discard semantics** — a first-class "replace span X
   atomically" state shape, so §6's reducer is idiomatic rather than bespoke.
2. **Session epoch / host restart fencing** — the daemon restarts and replays
   cold turns; clients need a standard signal distinguishing "same session,
   new epoch" from "gap in the same epoch".
3. **Approval / human-input surfaces** — permission requests are part of the
   live session state a client renders; how they appear in AHP state needs a
   convention.
4. **Multi-session observation** — one webchat client observing a roster of
   agent sessions (§4) wants batched subscription, not N independent sockets.

## 9. Risks and open questions

- **Protocol maturity.** One shipping host implementation (VS Code) means the
  spec may still move; Phase 0's shadow reducer is deliberately cheap to
  rewrite.
- **Host-side state retention.** The authoritative AHP state must be bounded
  (the transcript store remains the durable record); snapshot size vs. reducer
  log length needs a policy before Phase 1.
- **AuthZ and reachability at the AHP edge.** Phase 2 reuses the BFF read
  authorization, but both the token flow and the data-plane route (§7.3 —
  relay-forwarded, since browsers cannot dial NAT'd or cluster-internal
  daemons directly) need their own design pass.
- **Does Phase 2 pay for itself?** If the bounded-read model proves sufficient
  for console UX, Phase 2 can be dropped; Phases 0–1 stand alone.
