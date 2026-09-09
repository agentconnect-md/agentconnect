# Design: Unified Memory Operations and Context

**Status:** Implementation in progress. The common read foundation is implemented; additive model/admin read projections are implemented; the common console, activation-time catalog delivery, and common mutations remain pending. This design does not change the plugin ABI by itself.

**Related:** [Memory evolution](memory-evolution.md), [managed memory](memory-system-plan.md), [Dream](memory-dreaming.md), [product conventions](../product-conventions.md).

**Implementation baseline:** main `b82c936c`. PR [#1861](https://github.com/agentconnect-md/agentconnect/pull/1861) is considered as an independent additive list-tool change.

## Recommendation

Unify **memory entry operations**, their policy enforcement, and their projections into model tools and the console. Keep storage and extraction strategies behind adapters.

One managed topic document is one entry. One external canonical record is one entry. An entry can be a short fact or a Markdown document; the interface must not assume they have equal size or granularity. Managed memory retains its Markdown files, frontmatter, wiki links, generated index, history, and Dream adoption path. An external record does not acquire a fictional filename or filesystem.

The first release should share list/get/create/update contracts and capability discovery, and offer search where actually implemented. It should not require every existing plugin to implement every operation, enable Dream on external backends, add channel scope to the plugin ABI, or move existing data. Those are separate capabilities and migrations.

## 1. What is already shared, and what is not

| Layer              | Managed today                                                 | External today                                                                   | Proposal                                                                   |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Provider lifecycle | ensure, standing index, optional turn distillation            | ensure, per-turn recall, optional queued capture                                 | Preserve common lifecycle; keep capture/recall strategies explicit         |
| Model operations   | readMemory/writeMemory with path and replacement modes        | searchMemory/saveMemory/getMemory/updateMemory/deleteMemory; listMemory in #1861 | One core-owned entry tool family                                           |
| Administration     | FileMemoryAdmin, path/mtime                                   | RecordMemoryAdmin, id/version                                                    | One MemoryEntries port and common DTOs                                     |
| Console            | File browser/editor                                           | Record list/editor                                                               | Shared browse/search/detail shell, format-aware editor                     |
| Identity           | Topic filename within a resolved root                         | Backend record ID within a bound connection and agent                            | Opaque entry reference bound to store and partition                        |
| Content            | Up to 256,000 UTF-8 bytes; Markdown with optional YAML header | Canonical text and metadata; plugin-dependent bounds                             | Text plus format and explicit byte limits; no forced conversion            |
| Scope              | Agent; channel overlay over shared agent base                 | Agent only in admitted v1 plugins                                                | Common resolved view, capability-gated scope availability                  |
| Consistency        | Existing optional mtime precondition; controlled write path   | Optional backend version; no universal CAS guarantee                             | Advertise actual consistency; never pretend a version field guarantees CAS |
| Dream              | Managed agent scope; staged tree and fenced adoption          | Unsupported                                                                      | Keep current restriction initially; define a separate draft capability     |

Current `MemoryProvider` already shares lifecycle hooks. Its residual required file methods and `FileMemoryAdmin | RecordMemoryAdmin` split make callers repeatedly branch. The unification belongs here, not in a new backend service or in raw plugin MCP tools.

M-8 managed `home: control-plane` is now implemented in `memory-evolution.md`. This proposal builds on that home authority. Managed adapters must keep using `MemoryFs` and the chosen authoritative home; changing access DTOs must not introduce a second content store or fallback home.

## 2. Canonical entry and reference

Conceptual types below describe the contract, not an immediately compilable API patch:

```ts
type EntryRef = string

type MemoryEntrySummary = {
  ref: EntryRef
  label: string
  description?: string
  format: 'markdown' | 'text'
  byteSize: number
  createdAt?: string
  updatedAt?: string
  revision?: string
  origin: 'active' | 'inherited'
  editable: boolean
}

type MemoryEntryContent = {
  entry: MemoryEntrySummary
  text: string
  complete: boolean
  nextContentCursor?: string
  metadata?: Record<string, unknown>
  links?: Array<{ label: string; ref?: EntryRef; exists: boolean }>
  backlinks?: Array<{ label: string; ref?: EntryRef; exists: boolean }>
}
```

- `ref` identifies `(store lineage, physical partition/layer, provider-local ID)`. A managed local ID can remain the validated topic filename; no rename feature or mass UUID rewrite is required. External backend IDs remain private adapter coordinates. Labels are presentation, never authority.
- The core encodes or resolves the opaque reference and validates it against the current authorized view on **every** call. Knowing a reference does not grant access. A ref from another agent, connection, partition, replaced store, or abandoned draft is refused. A fresh session cannot use an old connection's coincidentally identical record ID against a new store.
- Store lineage changes on backend replacement/reset. A physical home migration may preserve lineage only when the migration proves it is the same logical store. Content revision is separate and changes when content changes.
- A managed topic's `text` is its **complete stored Markdown including frontmatter**. The adapter derives label/description/type for display without deleting or serializing the original header. Nested metadata, comments and unknown YAML keys survive. Derived display fields are not an independently writable copy of the header.
- External `text` is the canonical record text. Optional backend metadata remains a bounded field only when the adapter can preserve it. Unknown metadata must not be silently dropped on update; omitted metadata means preserve, never clear.
- Links/backlinks are read-side annotations, never appended to `text`. Existing `[[topic]]` links still resolve through the managed overlay. Other adapters may omit graph support.
- Timestamps are optional facts. Do not synthesize creation time from a read, or promise newest-first when the provider does not guarantee it.
- `MEMORY.md` is a **derived overview**, not a normal mutable entry in the new API. It is produced from managed topic headers. Existing generated/legacy index access survives through compatibility routes. Legacy hand-authored indexes require an inventory and explicit preservation path before file tools are retired; they must not disappear merely because the new list excludes the generated index.

This is an entry envelope, not a new storage format. It does not flatten a document into individual facts or rebuild embeddings.

## 3. Common operations and tools

Canonical model tools reuse the existing record-family names:

| Tool         | Contract                                                          | Important rule                                                                      |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| listMemory   | cursor-page entry summaries                                       | No query required; listing is not semantic search                                   |
| searchMemory | query -> bounded hits with summary and snippet                    | Report search kind: lexical, semantic or hybrid; no claim of exhaustive enumeration |
| getMemory    | ref -> content, revision, optional content continuation and links | Missing entry is explicit null/NOT_FOUND, not an empty document                     |
| saveMemory   | create one entry from text, optional label/metadata               | Create only; no implicit overwrite, merge or extraction                             |
| updateMemory | ref + revision when required + exactly one replacement mode       | Replace full text, or optional exact-text edit; never an upsert                     |
| deleteMemory | ref + revision when required                                      | Explicit deletion; an empty text is not deletion                                    |

Six operations avoid overloading one write tool with implicit create/update/delete behavior. If a provider lacks an operation, omit that tool and return `UNSUPPORTED` for a stale/direct call.

`saveMemory` means explicit authored content, while **capture** means observing a completed conversation and allowing an extractor/backend to decide what to remember. Those must not be aliases. If an external backend only exposes extraction, advertise capture, not exact-create; keep existing reviewed v1 create semantics as a compatibility capability until adapter conformance proves stronger guarantees.

`updateMemory` has one validated union: `{text}` OR `{edit:{oldText,newText}}`, never both. Exact edit is available only when the store supports an atomic edit or a conditional read-modify-write. The selected substring must occur exactly once; newText may be empty. Replacements must come from a complete current get or an exact current slice, not a search snippet. A complete replacement must not silently save a truncated get response. Callers preserve the `complete` flag and disable full-save in the UI until all content has loaded.

Existing external tools currently accept `id`/`text`, not `ref`; do not silently change their schema under a live MCP session. Use a versioned tool-contract rollout (§10). For the new contract, all providers expose identical argument/result shapes for the same available operation. A later bounded batch-get can reduce round trips without changing entry identity: cap combined bytes, return per-entry results, and authorize each reference separately.

History remains an optional **console** operation initially. Adding model-readable audit history is a separate product choice. A graph panel is also optional; it must not gate basic editing.

### Enumeration, bytes, cursors and search

- Shared public defaults: list 20 summaries/page, maximum 100; search 5 hits by default, maximum 20. Existing legacy defaults remain unchanged until clients move to the new contract.
- Per-call effective count is min(request, core maximum, provider maximum). Fix the backend request size too: never request 50, emit 20, and forward a cursor that skips the other 30.
- Cursor continuation is authoritative. A provider may return a short or empty page with a continuation. The client stops only when continuation is absent; repeated identical continuation is an error, not an infinite retry loop.
- Cursor is tied to operation, authorized view, store lineage, effective page size and ordering/query. Continuing with a changed page size or another scope fails explicitly. Pinning page size matters for page-number-based services.
- Existing plugin cursors remain at their v1 bound of 2048 characters. The new public cursor is a core-owned bounded opaque token (also at most 2048), not necessarily a raw backend cursor. If wrapping cannot fit, use a bounded durable continuation record; no unbounded in-memory cache. Expiration returns `CURSOR_EXPIRED`; it never silently restarts from page one.
- For managed enumeration, build a bounded snapshot of summary metadata under the store's serialization boundary, page a deterministic topic-key order, and record its source revision. External v1 defaults to backend/live ordering and does **not** claim snapshot consistency. Return the actual consistency/order in page metadata. Snapshot export/Dream require stronger capabilities.
- List returns summaries; search returns explicit snippets; get supplies full text through bounded content pages. Suggested get budget is 32 KiB per page, clamped further to the encoded transport budget. Never reduce the existing 256,000-byte managed item ceiling just to match smaller external records.
- A large external record may already be fetched whole inside the trusted adapter; it can be delivered to the model in revision-bound slices. No byte truncation may masquerade as a complete entry. Serialized envelope size, UTF-8 boundaries and metadata count toward transport bounds.
- If a summary page hits its byte cap partway through a provider page, preserve unreturned records in its continuation or refetch via a proven stable coordinate; do not discard them. If one summary is too large, bound its preview fields without losing its reference. Errors/budget exhaustion are distinct from empty results.
- Managed explicit search can start with deterministic lexical matching of topic name, description and body through `MemoryFs`, with a bounded scan and explicit partial-result indication. No vector DB or semantic claim is necessary. If that implementation is deferred, advertise search=false; do not answer with a fake empty list. Automatic recall remains index-based for managed initially.

## 4. Capability discovery with operational meaning

Expose one core-owned description, with fields consumed by tools, routes and UI:

```ts
type MemoryCapabilities = {
  operations: Array<'list' | 'get' | 'search' | 'create' | 'update' | 'delete' | 'history'>
  searchKind?: 'lexical' | 'semantic' | 'hybrid'
  supportedScopes: Array<'agent' | 'channel'>
  writeConsistency: 'conditional' | 'last-write-wins'
  exactEdit: boolean
  exactCreate: boolean
  enumeration: 'snapshot' | 'live' | 'unavailable'
  graph: boolean
  limits: { maxItemBytes: number; maxPageItems: number }
}
```

Effective capabilities are the intersection of reviewed adapter capabilities, implemented core support, configured policy and caller authority. Read-only inherited entries can further restrict per-entry actions. Every advertised field must have a consumer and conformance test; do not add speculative flags for possible plugins.

Today external v1 advertises operation names, item budgets and capture idempotency, but does not certify all the stronger properties above. Map only proven properties; `version` presence alone cannot imply atomic conditional writes, and capture idempotency cannot automatically imply CRUD idempotency. A future profile revision must negotiate additional properties and pin the new manifest; do not reinterpret existing third-party manifests as claiming them.

Native/none remain distinct lifecycle modes. Native tools are runtime-owned and must not be silently replaced by this entry family. Its existing file browser can remain a compatibility view. None exposes no memory operations.

## 5. Provider and service boundaries

```text
Model tools            Console BFF / authorized admin routes
       \                    /
        Shared memory operation service
        - resolve caller + live binding + view
        - enforce read/write and capability policy
        - validate canonical request and response
        - budgets, revisions, operation receipts, provenance
                     |
               MemoryEntries port
                /              \
       ManagedEntries       ExternalEntries
       MemoryFs + existing  reviewed plugin client
       store primitives     -> registered backend
```

Lifecycle (`runtimeEnv`, ensure, standing context, recall/capture policy) remains a separate facet of `MemoryProvider`. `MemoryEntries` owns describe/list/get/search/create/update/delete/history. Optional operations may be absent, but common service logic must fail closed rather than guessing.

Move core tool descriptors/projection out of provider implementations. Build descriptors and validators from the **same canonical schema**, with per-session capability filtering. `toolsForAgent` can remain a compatibility wrapper during migration. Both model and admin paths call the service with separately authenticated contexts; sharing code does not give the model console administration authority.

The adapters map data and execute storage operations. They do not choose the caller's agent, privacy rule, connection, draft root or write provenance. Plugin credentials and raw plugin MCP tools stay behind the current registry/transport boundary.

### Managed mutation integrity

All mutations must still use the controlled write path: header normalization/stamping, size/path validation, serialized durable write, authoritative write marks, retained history, generated-index refresh, and graph refresh/invalidation. Add create-if-absent, conditional update and explicit delete **at that boundary**, not with raw filesystem writes in an adapter.

Deletion must update the ledger/history/index and obey Dream fences. Managed does not currently expose ordinary per-topic delete; advertise it only after this path exists. Preserve dangling links as such; do not silently rewrite referring documents.

For new managed tools, update/delete require a current revision and create requires atomic create-if-absent. The compatibility surface retains its existing behavior. A revision is a concurrency precondition, not proof that the model comprehended the document. New strong conditional operations require an actual atomic store primitive. A get followed by write under an arbitrary local mutex is insufficient when another daemon or native filesystem writer can mutate the authoritative home. Land the required atomic revision primitives before advertising these stronger managed mutations. Reuse the home authority's transaction/fencing design rather than introducing a second revision database.

### Errors and mutation receipts

A conflict response includes the current revision and, when authority and the byte budget permit, the current text. Otherwise it carries an explicit content continuation. Reconciliation must retain concurrent changes rather than blindly repeat the stale replacement. Shared error codes: `UNSUPPORTED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_ARGUMENT`, `CONFLICT`, `STALE_BINDING`, `CURSOR_EXPIRED`, `TOO_LARGE`, `UNAVAILABLE`, `AMBIGUOUS_WRITE`. Keep diagnostics bounded and free of backend credentials/URLs. Empty list, missing item and unavailable service are distinct states.

Core assigns an operation ID before mutation egress and preserves it through retries of that operation. Receipt states distinguish completed, accepted/pending, failed and ambiguous. If a backend cannot prove idempotent retries, a timeout is ambiguous; do not blindly repeat create and manufacture duplicate memories. A new independent model call is a new operation unless explicitly tied to a prior receipt by a supported retry flow.

### Bounded context and catalog freshness

Entry access alone does not tell a long-lived session that another session, the console or Dream changed the store. Add a separate `MemoryContext` facet:

```ts
interface MemoryContextRequest {
  seenRevision?: string
  maxBytes: number
}
interface MemoryContextResult {
  catalogRevision?: string
  freshness: 'current' | 'cached' | 'unknown'
  coverage: 'complete' | 'partial' | 'unavailable'
  overview: string
  changedRefs?: string[]
}
```

The core resolves the authorized view; the request does not select a store. Keep managed startup-index behavior, then invalidate the catalog on committed writes/adoption and deliver a bounded refresh at the next activation. A channel-overlay catalog revision covers both the channel and base layers. Fetching every topic body or enumerating an external backend on every user message is not the default.

External v1 does not provide a general change feed or store revision. A cached list is an observation, not proof of current completeness; expose cached/unknown freshness and let explicit list/search refresh it. A partial or stale catalog cannot justify a claim that the whole memory is empty. A relevant summary is a retrieval hint: get the entry before answering from its detailed contents.

Descriptions and aliases remain bounded untrusted data, separate from user requests and authoritative instructions. Deliver updates using each harness's supported context mechanism; do not assume arbitrary mid-session system-message replacement. Reuse an authoritative store's revision where available rather than minting a process-local counter and claiming cross-daemon freshness.

## 6. Scope, overlays and access

The service resolves a trusted view, conceptually `{bindingGeneration, readablePartitions, writablePartition, optionalDraftBinding}`. Models never submit agentId, connectionId, channelKey, root path or actor identity. Console selectors are authorized against the agent and allowed partitions before dispatch. Entry refs/cursors never expand that authority.

Preserve today's rules: ordinary reads may use shared agent memory even in private/isolated sessions; shared-memory writes and post-turn capture obey the current privacy gate; Dream excludes private transcripts. Choosing external capture continues to require its existing egress opt-in. Unifying operation names does not consent to exporting conversations.

For managed channel mode, list/search/get see the existing overlay: channel topic shadows a base topic with the same key. Returned entries indicate actual origin. Base entries are readable but not directly writable from the channel view. New operations reject an update/delete of an inherited ref with a clear message; the user/model may explicitly create a channel-local entry instead. This removes the ambiguity where a displayed base file could be mistaken for the object being edited. Legacy writeMemory retains its documented channel-write behavior until retired. Deleting a channel override reveals the base again; hiding inherited content would require a distinct tombstone feature and is outside the first release.

External v1 remains agent-only. Do not encode channel IDs into its agent key and claim that channel memory is supported: this bypasses the reviewed scope contract and makes existing data routing ambiguous. Later channel support requires an explicit profile/binding revision, trusted partition-key derivation, backend conformance, overlay semantics, and a migration plan. Until then, scope controls explain why channel is unavailable for that connection.

## 7. Dream and capture

A common entry API makes Dream's tools reusable, but does not make external Dream safe automatically. Dream needs more than CRUD:

1. A complete, stable snapshot of the chosen store.
2. An isolated draft bound to the extraction session, with no read-through to live memory.
3. Digest-bound review of exact proposed bytes and explicit deletion semantics.
4. A fenced commit against the base revision, preserving cancellation, existing rebase rules, backup and adoption checks.
5. Durable recovery with a truthful committed/conflict/ambiguous result.

Keep current managed Dream behavior and safety checks during the tool migration. Its session uses the same entry operations with a daemon-minted draft binding; sources remain `dream`/`distill`/`tool`/`console`, assigned by the caller context. Compatibility aliases must resolve that binding before any live provider lookup.

Do not simultaneously change the existing empty-staged-store/omission guard while renaming tools. A later proposal API can express a typed create/update/delete change set, with omission meaning unchanged; converting today's full-replacement staging to that model requires its own tests and rollout.

An external adapter qualifies for automated Dream only after it proves snapshot and atomic/fenced apply semantics. Sequential remote CRUD plus compensation is not an atomic adoption. V1 external plugins remain unsupported for Dream. A later suggestion-only experience can be separate, but must never say a proposal was adopted if its mutations only partly succeeded.

### Explicit changes and automatic capture

Coordinate direct mutation, post-turn capture and Dream through durable state. A successful explicit correction must not be undone by delayed extraction of the same source turn. Initially, skip automatic extraction for a turn with a completed explicit mutation; preserving unrelated facts from that turn can come later with finer provenance. Failed and ambiguous writes are separate states, not successful-mutation flags.

Record that outcome before enqueuing automatic capture and recheck it before applying capture. Use the authoritative mutation/outbox state across retries, restart and handoff; an in-process boolean is insufficient. Routine capture changes durable facts when warranted; periodic restructuring belongs to Dream. This is a mutation-slice policy change, not a side effect of introducing read DTOs.

Keep automatic capture strategies distinct: managed distillation generates authored entries through the same writer; external capture may asynchronously extract multiple records. Capture receipts must not be mislabeled as exact-create success. Changing tools must not switch manual capture to automatic capture.

### Entry deletion versus a forget workflow

`deleteMemory` deletes a selected entry. It does not promise that historical transcripts, pending capture, retained history, backups or an external service's replicas can no longer contain or regenerate the fact. A user-facing forget workflow needs its own contract:

1. Authorize the actor and exact target. Shared read access does not imply permission to erase shared memory for everyone.
2. Record suppression against known entry/evidence identities and a source watermark; cancel or filter older queued capture and invalidate affected drafts.
3. Remove live entries through the mutation service and invalidate the catalog/cache.
4. Define retention or erasure of history/backups and distinguish these from live removal in the result.
5. Report external provider-confirmed deletion separately from local suppression.

A suppression record should not retain the removed text as an audit copy. IDs and watermarks can stop known replay, but cannot guarantee semantic forgetting of untracked paraphrases. Stronger guarantees require lineage or exclusion of relevant source material. Specify those limits before offering a stronger product promise; full erasure is not part of the first CRUD release.

### Writer provenance, evidence and aliases

Keep `tool`/`console`/`distill`/`dream` writer provenance, and distinguish it from evidence supporting a claim. Optional evidence can refer to an originating turn, an authorized user decision, or an immutable commit/test artifact. The core stamps origin identity; a model-authored `verified` label is not verification or permission. Evidence references must not leak private source links into a shared catalog.

Persist durable engineering constraints and lessons; retain transient progress in the task system and detailed diagnostics in evidence artifacts. Do not turn a broad acknowledgment into approval of every model-generated detail. Optional subject aliases help retrieval and reduce duplicate topics, but alias equality must not automatically merge subjects or grant authority. Keep logical categories separate from physical paths and ACLs.

Personal preferences require identity and scope support. Do not inject one participant's profile globally into a shared agent. Authorized agent-level operating preferences remain distinguishable from ordinary knowledge; retrieved memory cannot approve actions, alter connection permissions, or override a current authorized instruction.

## 8. Console and admin API

One Memory page offers browse/search, selected-entry content and optional history/links. Entries show label, description/preview, actual updated time when known, and an inherited/read-only indicator where needed. Markdown keeps the existing renderer/editor; plain text uses the same layout with the appropriate content treatment. Backend settings stay collapsed as today.

Use capabilities for actions and availability, not `provider === 'external'` branches throughout the UI. Keep explicit unavailable/error states; a temporarily unreachable backend must not look like an empty memory. Do not render snapshot totals or newest-first labels unless supported. Unknown timestamps display as unknown.

Proposed additive routes under the existing agent resource:

- `GET /agents/:id/memory/capabilities`
- `GET /agents/:id/memory/entries` (summaries, cursor)
- `POST /agents/:id/memory/entries/search`
- `GET /agents/:id/memory/entries/:ref` (bounded content)
- `POST /agents/:id/memory/entries` (create)
- `PATCH /agents/:id/memory/entries/:ref` (conditional update)
- `DELETE /agents/:id/memory/entries/:ref`
- `GET /agents/:id/memory/entries/:ref/history` when available

Add versioned request/reply frames for daemon-owned operations; bounded BFF responses keep current locality and authorization rules. Respect the existing CP-home ownership. No new automatic CP persistence of external memory bodies. Use route schemas/OpenAPI and a negotiated feature bit for mixed-version daemons; do not repurpose old frames with different response shapes.

## 9. Compatibility matrix for the first release

| Capability             | Managed                                                           | External v1                                                          |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| List/get               | Common entry facade; topic summaries; generated overview separate | Only with declared list/get                                          |
| Explicit create/update | Via existing writer plus required mutation primitives             | Only with reviewed create/update; truthful consistency               |
| Search                 | Optional bounded lexical implementation; otherwise unavailable    | Existing recall/search operation; advertised actual search semantics |
| Delete                 | After ledger/index/history-aware primitive lands                  | Declared delete                                                      |
| Graph                  | Existing wiki links/backlinks                                     | Absent unless separately supported                                   |
| Channel scope          | Existing managed overlay preserved                                | Unsupported                                                          |
| Dream                  | Existing managed agent-only path                                  | Unsupported                                                          |
| Automatic recall       | Existing bounded index                                            | Existing auto/tool-only policy                                       |
| Automatic capture      | Existing opt-in distillation                                      | Existing manual/turn policy and receipts                             |

Uniform interface means the same operation means the same thing; it does not mean every backend exposes an identical number of buttons or identical guarantees.

## 10. Delivery plan

**Slice A — common read contract.** Add entry DTOs, service, managed/external adapters, capability discovery, list/get, bounded content/catalog freshness and conformance fixtures. Keep current lifecycle, storage, writes and wire compatibility intact. Include managed lexical search here only if it can be bounded and tested; otherwise omit it honestly. PR #1861 can land independently; it is an additive step toward enumeration, not a dependency on this redesign.

Read-foundation implementation notes:

- `protocol/memory-entries.ts` defines strict v1 requests/results. `daemon/memory/entries/` owns authorization rechecks, current-view resolution, opaque references, bounded list/get/context results, and the two adapters. Legacy tools, routes and capture policies retain their compatibility paths.
- References use a restart-stable daemon key and a managed tree lineage marker. Initial marker publication is exclusive on local, shim, and CP homes; an older peer that cannot perform that operation fails closed. Clearing/replacing a tree changes its lineage. This primitive provides create-if-absent, not atomic conditional replacement or deletion.
- Content pages default to 32 KiB and complete encoded results stay within 64 KiB. Durable continuation slots retain unreturned summaries and full v1 backend cursors: 16 slots per agent, at most 2 MiB each, expiring after 30 minutes or earlier eviction. The existing store retention sweep removes expired rows. An expired/evicted cursor never restarts enumeration silently.
- Managed catalog capture is bounded to 2,048 entries and 16 MiB of topic reads. Captured summaries stay fixed across continuation pages, with deterministic topic order and an inventory digest. The current native-writable filesystem home does **not** certify an atomic store snapshot, so capabilities and results report `live` enumeration. The CP home now supplies transactional file operations, but the common adapter still needs explicit snapshot and strong update/delete integration before advertising those guarantees.
- Managed context reads index bytes and topic metadata rather than scanning bodies on each request; it reports partial catalog coverage and detects changes across fresh provider instances. External v1 reports unknown freshness/unavailable catalog coverage without automatic enumeration. Delivery of these updates into an already-open runtime session belongs to the projection rollout.

Read-projection implementation notes:

- Additive `describeMemoryEntries`, `listMemoryEntries`, and `getMemoryEntry` tools derive argument descriptors from the strict v1 schemas. They use trusted session/channel or synthetic staging bindings and recheck read authority. Legacy `readMemory`/`writeMemory` and external `getMemory({id})` retain their contracts for warm sessions; no old tool name changes shape.
- Managed sessions receive all three reads; external sessions receive declared list/get operations and capability discovery. Native/none keep their existing tool sets. Normal, distillation and Dream sessions share the descriptors and scope resolver; refs never substitute for legacy paths or record ids.
- Additive capabilities/list/get HTTP routes proxy `memory/entries/read/v1` under the current serving daemon epoch and the negotiated `memory-entries-v1` feature. The org/agent read gate runs before dispatch; the daemon rechecks agent ownership. Typed failures retain their codes, including stale binding, cursor expiry and unavailable versus empty/missing results. Older daemons return an explicit unsupported response without receiving an unknown frame.
- The console still uses its existing file/record browsers; catalog refresh delivery and mutations are not implicitly enabled by read projection.

**Slice B — common mutations and model tools.** Add atomic managed create/update/delete guarantees, honest external capabilities, shared error/receipt mapping, explicit-mutation/capture coordination and schema-derived descriptors. Migrate managed tool prompts and normal/distillation/Dream registration together. New sessions negotiate the new tool contract; already-running sessions retain legacy shapes and dispatch aliases. Aliases invoke the common service where semantics match; legacy file/index behavior remains an explicit managed compatibility adapter. No raw-disk bypass or duplicate writer.

**Slice C — common admin/UI.** Add routes/frames with daemon feature negotiation, move both browsers to the entry shell, preserve Markdown editing and capability-specific extras. Keep old file/record routes for older clients and native mode. Do not change backend selection or migrate data as a side effect.

**Slice D — retirement and separate extensions.** Remove legacy methods/descriptors only after supported old sessions/clients are drained or the documented compatibility window ends. Separately design plugin v2 scope/consistency extensions and any external Dream/export/import. Update `memory-evolution.md`, `memory-system-plan.md`, product conventions and `docs/README.md` to resolve representation/scope documentation drift.

Each slice should be independently reviewable and shippable; this is not a request for a single flag-day rewrite. Backend data migration remains an explicit export/import product, with fidelity, links, provenance, scopes and retry safety reviewed separately. Switching providers continues to follow existing behavior until that product exists.

## 11. Acceptance cases

Use the same conformance scenarios for managed and fake external adapters, then a small real registered-plugin integration fixture:

- List/get returns the same stored text; empty content, missing entry and outage are different.
- More than 20 records and varying provider page sizes enumerate fully; no final-page loss, duplicate cursor loop or silent budget truncation.
- UTF-8/JSON escaping, large Markdown, metadata and content paging respect encoded frame budgets; content changes between slices conflict instead of splicing versions.
- Name/header/unknown YAML metadata/wiki-links survive managed round trips; generated index stays derived; every writer retains provenance and history.
- Exact create does not replace; omitted metadata preserves; update does not create; empty text does not delete; stale revisions conflict where promised.
- Foreign refs/cursors, guessed IDs, changed bindings and forged model scope cannot read or write another store; private writes remain blocked.
- Channel overlay list/search/get agree; inherited updates refuse; deleting an override reveals the base; legacy alias semantics remain tested.
- Snapshot/strong-CAS claims fail admission if adapters cannot prove them. Ambiguous remote writes are not blindly retried.
- A Dream alias/new tool always reaches staging, never live; cancellation and digest/revision adoption fences remain intact; no-write extraction cannot wipe the store.
- A console edit during an open session causes a bounded, authorized catalog update; partial or stale catalogs are not treated as proof of absence.
- A delayed capture cannot undo a completed explicit correction, including after worker restart; a stale Dream cannot restore an entry covered by the defined suppression workflow.
- Private evidence links stay private, aliases do not merge identities, and provenance metadata never grants permissions.
- Old model session + new daemon, new client + old daemon, reconnect/provider change, tool-only recall and native/none all retain explicit behavior.

These acceptance cases are requirements for implementation, not claims of implemented behavior. This documentation change adds no runtime tests.

## 12. Source map and assumptions

Local sources inspected at the baseline above:

- `packages/daemon/src/memory/types.ts`: existing lifecycle, MemoryScope, file/record administration.
- `packages/daemon/src/memory/providers/{managed,external,dispatching}.ts`: overlay, trusted external key, provider routing.
- `packages/daemon/src/memory/{tools,store,frontmatter}.ts`: tool shapes, write path, byte limits, generated index and YAML preservation.
- `packages/daemon/src/mcp/ops/memory.ts` and daemon wiring: read/write gate and bound draft scope.
- `packages/daemon/src/memory-plugin/client.ts`, `packages/protocol/src/memory-plugin.ts`: reviewed capability projection, scope/budget validation, plugin v1 limitations.
- `packages/daemon/src/cp/memory-reader.ts`, `packages/protocol/src/frames/memory.ts`, CP agent routes: file/record wire split and limits.
- `packages/protocol/src/frames/memory-connection.ts`: external agent-only binding; channel/Dream restrictions.
- `packages/web/src/components/console/{MemoryPanel,RecordMemoryPanel}.tsx`: split presentation.
- `docs/designs/memory-evolution.md`: existing rationale, future M-8 home, explicit lossy data-migration distinction.
- `docs/product-conventions.md`: privacy, backend selection, editing and prompt provenance.

Some documentation already describes future home behavior while code still uses the older binding; some general UI prose still says agent-only despite managed channel support. Treat those as documentation alignment work, not as permission to silently change current behavior.

### External references

- [Anthropic API memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool): application-owned persistence and on-demand retrieval support separating model operations from physical storage.
- [Claude Code memory](https://code.claude.com/docs/en/memory): bounded index, lazy topic reads and frontmatter overlap with existing managed memory.
- [Public Fable prompt snapshot](https://github.com/asgeirtj/system_prompts_leaks/blob/0f4aeb3e7d04419c7161dd25fbd2dab23341867c/Anthropic/claude-fable-5.1.md#memory_filesystem): third-party material describing catalog-driven reads, conditional editing and background filing. It is an interface/workflow reference, not evidence of a deployed transaction or authorization guarantee. The multi-user scope, capture arbitration and provider requirements in this design are AgentConnect's decisions.

### Atomic CP home publication primitive

The CP-managed home now exposes negotiated `memory/transaction/v1` snapshot and commit operations. A commit references up to two previously staged files (topic and caller-generated index), checks the root fingerprint, target content hashes and staged content hashes under the same agent lock used by legacy file writes, and publishes files, bounded history and a body-free operation receipt in one PostgreSQL transaction. History or receipt failures roll back publication. The binding row stays locked through publication; existing serving-daemon authorization still applies.

Reusing an operation ID with the same request returns its original receipt, including after history retention; a different request conflicts. Receipts persist until their agent or organization is deleted. Large files use bounded staging frames. Snapshots exclude staging and reject roots above 2,048 committed files or 16 MiB. These are current-state fingerprints, not monotonic counters; raw-byte file hashes are distinct from common entry revision tokens.

This is an internal publication primitive, not the common mutation service. Callers still own index generation, entry-token translation, provenance policy, capture suppression and Dream adoption fences. `sourceTurnId` carries the daemon-minted source-turn identity used by the capture fence below. No new model or admin mutation entry points are advertised. Native-writable local/shim homes do not expose this atomic capability, and older CP peers do not receive these frames. Common mutations must integrate those policies before being enabled.

The existing managed `writeMemoryFile` path now uses this primitive for transaction-compatible Markdown names on negotiated CP homes. It prepares the topic and derived index from one root fingerprint, preserves the existing frontmatter/index policy, and lets the home record history inside the commit. A lost response gets one replay of the identical operation and staged references; it never rebuilds a replacement against newer state. An unresolved outcome blocks in-process Dream rebasing conservatively. Local/shim homes, old peers, and legacy filenames outside the transaction path schema retain their compatibility writer. This integration does not yet add common create/update/delete entry points.

### Durable same-turn capture suppression

Negotiated CP homes advertise `memory-capture-fence-v1`. The daemon hashes the trusted active turn identity into an agent-scoped UUID and attaches it to ordinary managed writes and the originating distillation scope; model arguments cannot choose it. A completed explicit `tool` or `console` transaction suppresses later automatic extraction for that same agent, root and source turn. The provider queries this durable status before extraction, including replay from the capture outbox. Every tagged distillation commit checks again under the publication lock, so a capture prepared before the explicit correction cannot bypass suppression with a fresh root fingerprint.

Suppression uses committed mutation receipts, independently of retained history. Failed writes create no suppression record; a completed capture retry still returns its original receipt without writing again. A daemon-side ambiguous outcome is resolved by the home's committed state, not a guessed success flag. Cached distillation sessions resolve the current pass scope, freeze it at tool-call entry and refuse memory access between passes. Existing private-write/capture gates remain in force.

This guarantee covers tagged atomic CP Markdown writes. Older peers, native-writable homes, legacy filenames outside the atomic contract and external plugin capture retain compatibility behavior. It does not implement cross-turn forgetting, history erasure or a new Dream adoption protocol. Common create/update/delete projections remain a subsequent slice.

### Conditional entry service

The common service now has schema-validated create/update/delete methods. Managed adapters expose them only when the caller supplies an explicit write authorization/provenance binding and the active home supports atomic publication plus capture fencing. Existing read projections do not opt in. Authorization and view identity are rechecked per call; inherited refs cannot be updated or deleted from a channel view.

Managed create uses the optional label as a flat Markdown topic filename (adding `.md` when needed), or generates a UUID topic when omitted. It refuses existing files. Update and delete require the revision from the common get result; update never creates missing entries. Exact edits require one non-empty match and treat replacement strings literally. Full text remains the stored Markdown, including unknown frontmatter. Separate metadata fields are explicitly unsupported for managed mutations rather than discarded. The generated overview is excluded from this entry API; the shared writer retains legacy index preservation/adoption rules.

All three operations use the same atomic publication engine as legacy CP writes, including history, index, durable receipts, source-turn suppression and conservative ambiguous-outcome handling. Result refs are minted from the current authorized view. Known revision conflicts carry the current revision internally. New model descriptors and admin mutation routes have not been enabled yet, so running sessions retain their previous argument shapes.

### Additive model mutation projection

Managed sessions expose `createMemoryEntry`, `updateMemoryEntry`, and
`deleteMemoryEntry` alongside the existing entry reads. Their input schemas derive
from the canonical mutation DTOs; the update descriptor preserves the exclusive
full-text/exact-edit modes. Existing file and external-record tool contracts keep
their names and arguments for warm-session compatibility. This is an additive
rollout, not the final retirement of legacy tools.

The descriptor is stable across managed homes; callers use
`describeMemoryEntries` for live operations and limits before choosing a write.
Strong mutations still require the atomic home/capture ports, and external/native
providers gain no new mutation capability. Ordinary model calls bind `tool` source
and the trusted source turn internally. Every mutation goes through the existing
write-access/approval gate, and the entry service rechecks access before resolving
the live provider. A one-call approval permits that payload while a subsequent
policy denial still wins. Synthetic extraction and Dream bindings retain their
constrained legacy writer; entry mutations are forbidden there so topic limits,
staged-root provenance, and adoption checks cannot be bypassed.

Admin HTTP mutation transport and UI remain separate follow-up work. This MCP
projection does not send large mutation bodies in the bounded daemon/CP read frame;
the controlled writer continues using staged chunks and atomic home publication.

### Admin conditional mutation projection

The authorized BFF exposes `POST`, `PATCH`, and `DELETE` on
`/agents/:id/memory/entries`, with the canonical create/update/delete body and an
optional `channelKey` query. Update/delete carry the opaque `ref` in the body.
Agent visibility and edit authorization run before dispatch; read-only callers
also receive capabilities and entry summaries with write operations/editability
removed. The daemon independently rechecks agent ownership and duty before
resolving the active home. Console provenance is trusted server input, never a
field the HTTP caller can choose.

`memory-entries-write-v1` negotiates the new `memory/entries/write/v1` request and
result. The first transport supports JSON requests up to 192 KiB, measured after
normalizing the `{ agentId, channelKey?, operation, request }` payload and including
JSON escaping. `limits.maxMutationRequestBytes` advertises that separate transport
budget; `maxItemBytes` remains the provider's stored-content budget. CP refuses
oversized mutations with `TOO_LARGE`/HTTP 413 before sending, leaving envelope
headroom under the 256 KiB connection cap. The daemon repeats this check. This
initial transport does not support all maximum-size stored documents; a future
chunked admin upload may lift this limit. Home publication itself remains staged
and atomic.

An uncertain reply after dispatch returns `AMBIGUOUS_WRITE`/503 without replay.
Clients must inspect current state before deciding whether to issue a new write;
HTTP retries are not idempotency keys. Confirmed conditional conflicts retain
`currentRevision` where known. Legacy file and record routes remain available.
The console UI and catalog-refresh integration are subsequent slices.

### Unified console entry browser

The Memory panel now defaults to a capability-driven entry browser for providers
that support list/get. Managed and external views share the same paged list and
complete-content reader. The existing settings, channel selector, and Dream panel
remain in place. Unsupported/older peers use the existing view; “More memory
tools” also retains file/history and provider-specific operations during rollout.

The editor loads every content slice before enabling edits, rejecting missing,
repeated, changed-revision, or oversized continuation chains. Reads are bounded to
128 slices and the smaller of the provider item limit or 4 MiB. Scope changes
remount the browser and invalidate outstanding reads. Conditional writes use the
ref/revision of the loaded document; inherited entries and read-only callers have
no edit/delete controls. Create/update respect both item bytes and the advertised
normalized JSON mutation request budget. Delete requires an explicit confirmation.

Conflicts and unconfirmed writes retain the draft and block another mutation until
the user reloads saved memory. No write is automatically retried. Refresh rechecks
capabilities and starts a new list; further pages load explicitly. The initial UI
shows stored text directly, preserving full Markdown/frontmatter during edits.
Activation-time catalog refresh and retirement of compatibility tools remain
separate work.
