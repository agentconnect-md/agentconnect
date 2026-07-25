# Transcript: Complete Tool Call Bodies

**Status:** Implemented

The daemon records the complete evolving body of each ACP tool call for session
audit and Console display. Tool bodies remain daemon-local and are fetched
through frame-budgeted, on-demand reads.

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

Text and reasoning rows leave these columns null. Existing databases add the
columns and index through the daemon's idempotent local-store migration.

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

## 8. Compatibility

- New transcript columns are nullable, so existing title-only rows continue to
  render.
- Tool-body fields on `SessionMessage` are optional.
- A daemon that does not provide bodies degrades to title-only tool rows.
- The `text` field remains the human-readable title.
- Session replay remains text-only.

---

## 9. Validation requirements

Tests cover:

- merging partial tool-call updates;
- stable row sequence across updates;
- the 1 MiB write ceiling and `truncated` marker;
- 32 KiB valid-JSON previews;
- frame-budgeted history pagination;
- UTF-8-safe body chunks and offsets;
- end-to-end complete-body retrieval;
- title-only compatibility; and
- exclusion of tool bodies from transcript replay.
