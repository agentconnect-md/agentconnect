# Transcript: Complete Tool Call Bodies

**Status:** Implemented

The daemon records the complete evolving body of each ACP tool call for session
audit and Console display. Tool bodies remain daemon-local and are fetched
through frame-budgeted, on-demand reads. §8 covers the one other row that
carries a body — the turn's plan — which reuses this chain end to end.

---

## 1. Data flow and trust boundary

```text
ACP session/update
  -> TranscriptRecorder
  -> daemon LocalStore (SQLite)
  -> session/history preview
  -> optional session/tool-body chunk reads
  -> authenticated Control Plane proxy
  -> Console session detail
```

The Control Plane does not persist transcript rows or tool bodies. It proxies
authorized reads to the daemon that owns the session. Tool bodies can contain
commands, file paths, input, output, and other sensitive runtime data, so they
must not be logged, copied into control-plane metadata, or included in
telemetry.

Tool rows are display and audit data only. Transcript replay into an agent
prompt remains text-only; tool bodies are never replayed.

---

## 2. Stored representation

The daemon transcript table includes:

```sql
tool_call_id TEXT
body TEXT
```

A partial unique index on `(channel, thread, tool_call_id)` identifies one row
per tool invocation. The row's `seq` and timestamp are fixed by the first
insert; subsequent ACP updates modify its title and body in place.

`body` is serialized `ToolBody` JSON:

```ts
interface ToolBody {
  toolCallId: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown[]
  locations?: { path: string; line?: number }[]
  truncated?: boolean
}
```

Text and reasoning rows leave these columns null; a plan row reuses both (§8).
Existing databases add the columns and index through the daemon's idempotent
local-store migration.

---

## 3. Streaming merge behavior

`TranscriptRecorder` keeps one accumulated body per `toolCallId` and processes
both `tool_call` and `tool_call_update`.

- The first event emits an `insert`.
- Later events emit an `update`.
- Present, non-null scalar fields replace their previous values.
- `content` and `locations` replace their previous arrays as a whole.
- An update that omits the title retains the last non-null title.
- Reasoning accumulated before a tool event is flushed first, preserving the
  natural activity order.

The daemon writes the first row immediately instead of waiting for a terminal
status. This lets the Console show an in-progress tool and preserves the latest
known body if a turn is interrupted.

The store exposes separate `insertToolCall` and `updateToolCall` operations.
They keep the initial sequence position stable while filling in streamed
results.

---

## 4. Write-size limit

Each serialized body has a hard-coded 1 MiB ceiling
(`MAX_TOOL_BODY_BYTES` in `transcript-recorder.ts`) to bound daemon-local
database growth.

When a body exceeds the ceiling, serialization sets `truncated = true` and
removes the largest free-form fields in this order until the value fits:

1. `rawOutput`
2. `content`
3. `rawInput`

This is a storage limit. Chunked reads cannot recover fields removed at write
time, and the Console must surface the stored `truncated` marker.

---

## 5. WebSocket frame limits

Every protocol frame must stay below `MAX_FRAME_BYTES` (256 KiB). A single tool
body or a page containing several bodies may be larger than that, so history
reads enforce two independent limits:

1. Each inline tool-body preview is capped at 32 KiB and remains valid JSON.
2. The complete `session/history/page` is assembled under a reply budget below
   the protocol frame ceiling.

When the complete stored body is larger than the inline preview,
`SessionMessage` includes:

```ts
{
  toolCallId?: string
  toolStatus?: string
  toolKind?: string
  body?: string
  bodyTruncated?: boolean
  bodyBytes?: number
}
```

Pagination may return fewer rows than the requested `limit` when the byte
budget is reached. `nextCursor` remains the continuation mechanism.

All byte slicing is UTF-8-boundary-safe.

---

## 6. Complete-body retrieval

The Console fetches a complete stored body only after an explicit action such
as “View all.”

Request:

```ts
{
  agentId: string // CP-authorized owner; daemon verifies the session binding
  sessionId: string
  toolCallId: string
  offset: number // defaults to 0
}
```

Response:

```ts
{
  sessionId: string
  toolCallId: string
  data: string
  totalBytes: number
  nextOffset?: number
}
```

`session/tool-body/chunk` slices the entire serialized `ToolBody` JSON by byte
offset. It does not select individual fields. Each chunk independently obeys
the frame budget; absence of `nextOffset` marks the final chunk.

Before reading the row, the daemon verifies the `(agentId, sessionId)` binding
and requires the tool row's sender to be the same agent. Stored tool-row
identity and updates also include that agent because ACP tool-call ids are only
session-local. A peer sharing the channel and thread can neither overwrite nor
read another agent's body.

The request's `agentId` is wire-optional only for a rolling upgrade where a new
daemon still talks to an older CP. That legacy path is logged and uses the
pre-binding session lookup; current CPs always send their persisted,
already-authorized session owner.

The Control Plane exposes the authenticated HTTP proxy for this request, and
the Console concatenates chunks before parsing and rendering the JSON.

---

## 7. Console rendering

For a tool row, the Console renders:

- tool kind, title, and status;
- structured `rawInput` and `rawOutput`;
- content blocks, including text, diffs, and terminal references;
- source locations as path and optional line;
- the write-time and preview-truncation states.

The inline preview is sufficient for the default collapsed view. Complete-body
retrieval is lazy so large diagnostic payloads do not consume the shared
control channel unless requested.

---

## 8. The plan row

The turn's task list rides the same machinery, with one difference that shapes
everything else: an ACP `plan` update carries the WHOLE entry list every time,
so a plan is a snapshot, not a stream of deltas.

- **One row per turn, rewritten in place.** `TranscriptRecorder` mints a
  namespaced `plan:<uuid>` id per turn — a recorder is built per turn — and the
  store's `upsertPlan` claims the row on first sight and overwrites it on every
  later update. `seq` and `ts` keep their first-seen values, so the plan holds
  the position it took when the agent first published it, ahead of the work it
  planned. Both statements are fenced on `kind = 'plan'`, so a session-local
  tool id can never address a plan row.
- **`text` is the summary, `body` is the list.** The row's text is
  `Plan · <completed>/<total>`; `body` is serialized `PlanBody`
  (`{ entries: { content, status, priority? }[] }`, protocol
  `frames/session.ts`). A reader that has only the text — an older Console, or a
  Control Plane that forwards no plan body — still shows that a plan existed and
  how far it got.
- **Inline or not at all.** A plan body has no complete-body fetch behind it, so
  the reader passes it through verbatim under the 32 KiB preview cap and drops
  an implausibly larger one rather than serving a truncated list.
- **Console placement is the point.** The plan renders as its own checklist
  above the answer, NOT inside the collapsed "Thought through N steps" panel:
  it is what the agent set out to do, not a step it took. `PLAN_LANE` is
  deliberately a distinct lane value from the work-lane `PLAN` the playground's
  live stream uses.
- Like tool and reasoning rows, plan rows are recorded in every output mode and
  never replayed into a prompt: only `text` and `tool` rows rebuild model
  context.

**The live stream carries the same list.** Recording alone would surface the plan
only on the read that switches a page to history — a live turn would show tool
rows for work whose plan it was hiding. `WebchatEvent` therefore has a `plan`
kind carrying the same entries, emitted from the same normalizer the transcript
row uses (`daemon/src/session/plan-entries.ts`), so the two can never disagree.
It is the one event kind in that union that is a snapshot: the client REPLACES
its block rather than appending, keeping the position the block first took.

The compatibility cost is real and deliberate. A relay predating the kind fails
that one frame's decode, answers with an error frame, and keeps the connection —
so the chunk is dropped, every other chunk still flows, and the turn degrades to
showing its plan only after the fact. There is no relay capability echo to gate
on: `rd/hello` advertises the DAEMON's capabilities and `rd/hello/ok` returns
only `relayId`. Gating would mean adding that echo first, which buys nothing
until relays upgrade anyway.

---

## 9. Compatibility

- New transcript columns are nullable, so existing title-only rows continue to
  render.
- Tool-body fields on `SessionMessage` are optional.
- A daemon that does not provide bodies degrades to title-only tool rows.
- The `text` field remains the human-readable title.
- Session replay remains text-only.

---

## 10. Validation requirements

Tests cover:

- merging partial tool-call updates;
- stable row sequence across updates;
- the 1 MiB write ceiling and `truncated` marker;
- 32 KiB valid-JSON previews;
- frame-budgeted history pagination;
- UTF-8-safe body chunks and offsets;
- end-to-end complete-body retrieval;
- title-only compatibility;
- exclusion of tool bodies from transcript replay;
- one upserted plan row per turn, holding its position and the latest entries;
- a plan row rendering outside the collapsed work panel, and falling back to its
  summary when no body arrives; and
- each live plan revision streaming as a whole-list snapshot that replaces the
  browser's block in place rather than appending a second one.
