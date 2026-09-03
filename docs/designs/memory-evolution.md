# Design: Agent Memory Evolution — MemoryProvider and External Memory Plugins

> Status: M-1 through M-5D are implemented. M-6 (shared scope) and M-7
> (retrieval upgrade) are not implemented; see §8.
> Prerequisites: [memory-system-plan.md](memory-system-plan.md), [architecture.md](architecture.md), [shared-bot-relay.md](shared-bot-relay.md), [high-availability.md](high-availability.md), [centralized-tool-management.md](centralized-tool-management.md), [secret-store-seams.md](secret-store-seams.md)
> Keywords: MemoryProvider abstraction, native/managed/external, out-of-process plugin, MCP profile, per-turn recall/capture, scope (user/agent/session/shared), history, body locality

---

## 1. Background and Current State

The daemon provides **directory-based, per-agent long-term memory**
([`memory/store.ts`](../../packages/daemon/src/memory/store.ts)):
`<agent-root>/memory/`, outside the workspace, contains a `MEMORY.md` index and
one or more `<topic>.md` files. The daemon injects only the index into each
session, capped at 25 KB, and topics are read on demand. The agent maintains
memory **manually** through the `readMemory`/`writeMemory` MCP tools. The console
proxies reads and writes through CP
`GET/PUT /agents/:id/memory[/file]`, while the CP does not persist content. A
unified capability registry in
[`memory/runtime/capabilities.ts`](../../packages/daemon/src/memory/runtime/capabilities.ts)
disables or redirects runtime-native memory to prevent duplicate memory stores.

**Design goal:** the memory system must be **flexible
enough** for users to choose a backend: one **built into the agent** (the
runtime's own memory), one **managed by us**, or **any external system** (with
Mem0 merely the first). The design therefore has two layers:

1. A stable, daemon-internal `MemoryProvider` lifecycle port that absorbs the
   behavioral differences among native, managed, and external memory.
2. An **out-of-process Memory Plugin ABI** behind external providers, which
   administrators can register without an AgentConnect release.

The directory memory, the L1/L2 model, distillation, scopes, and history are
managed-provider internals. Protocol differences among Mem0, Zep, and custom
systems belong in their plugins and must not leak into the core contract.

Automatic managed distillation remains opt-in, and user/session scopes remain
unimplemented pending trusted identity and scope-classification decisions.
External memory and the per-turn, record-shaped provider port are implemented
through M-5D; see §8.

## 2. Core: The `MemoryProvider` Lifecycle Port

`MemoryProvider` is a stable policy boundary inside the daemon, not the
third-party plugin ABI. The daemon must know when to recall, when to record, and
how to pass results safely to the model. It must not know a Mem0/Zep URL,
authentication scheme, entity model, or asynchronous event semantics.

The current implemented port is shown below; see
[`memory/provider.ts`](../../packages/daemon/src/memory/provider.ts).
`injectAtSessionStart()` survives only as a deprecated migration alias.

```ts
/** Constructed only by the daemon from trusted message/session context;
 * neither the model nor a plugin may supply it.
 */
interface MemoryScope {
  agentId: string
  userId?: string
  sessionId?: string
}

interface RecallRequest {
  turnId: string
  query: string
  topK: number
  maxBytes: number
  timeoutMs: number
}

interface MemoryRecord {
  id: string
  text: string
  score?: number
  scope: { kind: 'agent' | 'user' | 'session' | 'shared'; key: string }
  metadata?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  provenance?: { pluginId: string; backendId?: string }
}

interface CaptureReceipt {
  state: 'completed' | 'accepted' | 'failed' | 'ambiguous'
  backendOperationId?: string
}

interface MemoryProvider {
  readonly kind: 'none' | 'native' | 'managed' | 'external'

  /** managed/external/none disable runtime-native memory;
   * native redirects it into the agent root.
   */
  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv): Record<string, string>

  /** managed creates the directory/index; other providers may no-op. */
  ensure(scope: MemoryScope, agentName: string): void | Promise<void>

  /** Standing context injected only into a fresh ACP session.
   * managed returns the index; others return nothing.
   */
  standingContextAtSessionStart(scope: MemoryScope): Promise<string>

  /** Called for every activation after obtaining the current unread/user query.
   * external performs semantic recall here.
   */
  recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]>

  /** Enqueued after the response completes; must not delay the user response. */
  recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<CaptureReceipt | void>

  /** Core-defined tools, never raw MCP tools from a plugin. */
  toolsForAgent(agentId: string): ToolDescriptor[]

  /** The console surface is discriminated and must not be forced into file paths. */
  adminSurface(): FileMemoryAdmin | RecordMemoryAdmin | null
}
```

`FileMemoryAdmin` preserves managed/native
`list/read/write(path,mtime)`. `RecordMemoryAdmin` provides external
`search/list/get/create/update/delete/history(id,version)`. CP, wire, and web
layers recognize three **representation shapes** — `files | records | none` —
but no concrete backend such as `mem0`. This avoids inventing filenames and
prevents backend-specific fields from spreading into the product surface.

Responsibilities of the four providers:

|              | runtimeEnv                                                    | Session standing context | Per-turn recall                   | recordTurn                  | Model tools                  | Console |
| ------------ | ------------------------------------------------------------- | ------------------------ | --------------------------------- | --------------------------- | ---------------------------- | ------- |
| **none**     | Disable runtime-native memory through verified switches       | Empty                    | Empty                             | No-op                       | Empty                        | none    |
| **native**   | Point the runtime memory directory at the agent root          | Empty (runtime loads it) | Empty                             | No-op (runtime records)     | Empty (use runtime-native)   | files   |
| **managed**  | Disable native memory for known runtimes                      | `MEMORY.md` index        | Empty in v1 (future local search) | Distill + append (optional) | `read/writeMemory`           | files   |
| **external** | **Same as managed: disable native memory; never leave blank** | Empty                    | Call plugin every activation      | Capture into local outbox   | Core-defined record tool set | records |

The daemon sequence is therefore: merge `runtimeEnv()` at spawn; build standing
context for a fresh session; call `recallForTurn()` on each turn after composing
the real user/unread query; and connect `recordTurn()` to a provider-neutral
queue after the response completes. Existing `injectAtSessionStart()` behavior
and file-memory frames can remain as M-5 migration compatibility, but cannot
continue defining the final shape for external memory.

## 3. The Four Providers

### 3.0 none — No Persistent Memory

`none` explicitly disables both daemon-managed and runtime-native memory. It
creates no memory directory, injects no prompt content, records no turns, and
exposes no memory MCP tools. Runtime disabling uses an explicit capability
registry, for example Claude's `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, Codex's
`features.memories=false`, and Grok's `GROK_MEMORY=0`. A runtime whose disabling
semantics have not been verified fails closed for `none` rather than silently
retaining its own memory.

This mode fits stateless or privacy-sensitive agents, and agents that should
start every session from a blank slate. Existing memory files are not deleted
and become available again after switching back to their original provider.

### 3.1 native — Use the Runtime's Built-In Memory

The runtime already has memory: Claude Code has **auto-memory**
(`~/.claude/projects/<proj>/memory/MEMORY.md` plus the CLAUDE.md hierarchy), and
Codex has **AGENTS.md**. The native provider **neither injects nor distills**. It
does only two things:

- `runtimeEnv()`: point the runtime's memory/configuration directory **at the
  agent root**. For Claude, set
  `CLAUDE_CONFIG_DIR=<agent-root>/.claude` and
  `autoMemoryDirectory=<agent-root>/memory`, and **enable** auto-memory by
  omitting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` under native. Memory
  remains outside the workspace, isolated per agent, and never leaks into the
  host's `~/.claude`.
- Console access: read and write the runtime's memory files under the agent
  root.

The advantage is zero AgentConnect-side logic and behavior matching the native
runtime experience. The cost is that it is **runtime-specific**: Claude and
Codex differ, capabilities depend on the runtime, and behavior is not unified
across runtimes. This is why native is one **option**, not the default.

### 3.2 managed (Default) — Managed by AgentConnect

This is the system in §4: directories, distillation, scopes, and history, all
daemon-local, based on Markdown, using an existing LLM, with **no new
infrastructure and no violation of body locality**. It is runtime-independent.
Claude still receives `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to avoid duplicate
native and managed memory. This is the default provider.

#### 3.2.1 Where the managed tree lives (per binding and placement)

The managed store is a directory abstraction over a small file-system port
(`memory/fs.ts`, `MemoryFs`): `memory.ts`, the managed provider, the distiller, the
dream runner, and the CP memory reader take the port and never touch `node:fs`, and
one daemon factory (`resolveMemoryFs`) picks the implementation from the agent's
binding and placement, so the tree's home is a single decision. The binding names it
as `home` (§6): `daemon` (the default) keeps the tree on the machine that runs the
agent; `control-plane` keeps it in the Control Plane database, where it follows the
agent through every move and needs no execution unit to be up for a read or a write.

| `home` × placement                | Memory root                                                                                                                                                                                                                                                                              | Reachable                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon` · local daemon (default) | `<agent-root>` on the daemon's disk (`memory/`, `channels/`, `memory-dreams/`, `memory-backups/` beneath it)                                                                                                                                                                             | Always                                                                                                                                                                                                                     |
| `daemon` · cluster (`--k8s`)      | **Refused.** A `--k8s` daemon fails the activation closed, and the CP rejects the binding for an agent placed on the install-wide pool. The former sandbox-volume home (`<workspace mount>/.agentconnect/memory`, #1078 option A) survives only as the source of the one-time copy below | —                                                                                                                                                                                                                          |
| `control-plane` · any placement   | The `agent_memory_file` table in the CP database — one row per file keyed `(agentId, path)`, org-fenced, the same layout beneath a virtual root                                                                                                                                          | While the daemon's CP connection is READY; otherwise every read and write refuses with `MemoryHomeUnavailableError` — one resolution, no fallback to the member's disk, the same shape `MemorySandboxUnavailableError` had |

**Why the CP is allowed to hold it.** #1078 kept agent memory out of the CP on the
ground that it only had to survive member replacement. It now also has to survive a
move between daemons (`agentMove.ts` is a hard cutover and leaves memory in the
source archive) and it must not be the reason a pod has to stay up. Organization
knowledge and managed-skill archives are already CP-persisted: the line the CP keeps
is transcripts, ACP update streams, attachment bytes and workspace content — the
unbounded, streaming kinds — not curated, size-capped Markdown. `control-plane` is
opt-in for self-hosted agents and mandatory on the pool, where the member's root is
an `emptyDir` and the only other durable place was a volume that a pod had to hold.

**The port over the CP.** `CpMemoryFs` is the shim client (`ShimMemoryFs`) over a
different requester — the daemon's CP connection — so the daemon side is an adapter,
not a third implementation. The op set a pod already speaks (`memory-read`, `-append`,
`-commit`, `-stat`, `-readdir`, `-mkdir`, `-rmdir`, `-rename`, `-rm`, `-utimes`,
sliced and chunked to the 256 KiB frame) moves from `shim/memory-fs-channel.ts` into
`protocol` as the payload of one new D→C REQ/REP pair, `memory/store` →
`memory/store/ok`; `root` is relative to the agent's tree rather than pod-absolute.
The CP runs each op as one SQL transaction against the table: `append` concatenates
into the temp row, `commit` checks `ifMatchMtime`, deletes the target and renames the
temp, so the atomic publish and its precondition are one transaction; `rename` of a
directory rewrites the path prefix. Directories are implicit — a prefix with rows:
`mkdir` succeeds, `rmdir` answers whether nothing was left, and an empty directory does
not exist. That is the only observable difference from the two disk ports, and no
memory code depends on one. Authorization mirrors `knowledge/search`: org from the
frame or the connection, and the agent must be served by this daemon
(`placementResolver.mayAct`). That also makes the CP the write fence across daemons
which the in-process directory lock never was — a member that lost the duty gets
`SCOPE_DENIED` instead of racing its successor. The pair is gated by the
`agent-memory-store-v1` server feature in `register/ok`; a daemon whose CP lacks it
refuses to activate a `control-plane` binding with that reason.

**What stays on the daemon.** Everything above the port: the directory lock,
`.history`, retention, frontmatter normalization, index generation, the write ledger,
the dream fence. Console traffic is unchanged in this step — the `memory/*` C→D frames
still go to the owning daemon, which now answers from the CP-backed port instead of
waking a pod (#1077's wake stays for `daemon`-home cluster trees only until those are
gone). Answering list/read/history straight from the table, and so with the daemon
offline, is a later step. Per-file cap stays `MAX_MEMORY_FILE_BYTES`; `.history` is
rewritten whole per write and may reach its 2 MiB cap — sixteen frames, accepted for
now, rows are the follow-up if it hurts. The dream runner is unchanged; on the pool its
`withMemoryHome` still binds the agent pod, for the extraction host now, not the tree.

**Switching `home` copies; switching provider still does not (§6, §9).** Both homes
are the same tree, so this is the one binding change that migrates: when the owning
daemon applies a binding whose `home` differs and the target tree has no `memory/`
yet, it copies the whole tree once through the two ports (`copyMemoryTree(from, to)`,
under the directory lock, files overwritten by path so a retried application is
idempotent) and then rebuilds the session boundary as any memory change does. The
source is never deleted, and a target that already holds a tree is resumed as it is —
switching back to a home that was used before shows that home's tree, not a merge; the
console says so next to the selector. Both directions work.

**Moves.** A `control-plane` agent's memory is not daemon-local any more, so the
hard-cutover move carries it by doing nothing: the target reads the same rows. A
`daemon`-home agent moving onto the install-wide pool is rejected until its home is
switched; between two self-hosted daemons it keeps today's behavior (memory stays in
the source archive).

**Degradation.** With the CP connection down, a `control-plane` agent starts a new
session with no standing context and a warning, memory tools answer an unavailable
error, and a post-turn distillation waits in the memory capture outbox exactly as a
suspended sandbox's did — the outbox's reachability predicate becomes "the home is
reachable", not "the pod is bound". Established sessions are unaffected. No local
cache in this step.

**Rollout.** CP first (table, frames, feature), daemon second (adapter, copy,
refusal). Existing pool agents are flipped by the CP in the same release — every agent
placed on the install-wide pool gets `home: control-plane` — and the member holding
each one copies its tree from the sandbox volume on the next activation. Native
(runtime) memory follows the runtime's HOME on the pod and is unaffected.

### 3.3 external — General Memory Plugin

External memory is not a set of `service:'mem0'` branches. It is this stable
boundary:

```text
Agent binding -> core ExternalMemoryProvider -> Memory Plugin Profile -> backend
                 policy/lifecycle/security      protocol translation    Mem0/Zep/custom
```

The core is backend-agnostic, but **does not outsource policy to the plugin**.
The core owns trusted scope, recall/capture timing, budgets, the prompt trust
boundary, stable agent tools, outbox/retry, and the circuit breaker. The plugin
only translates canonical requests and records to and from a specific backend
protocol.

#### 3.3.1 Three Distinct Objects: Installation, Connection, and Binding

"What code is installed," "which account is used," and "how an agent uses it"
must not be collapsed into one `endpoint + apiKey`:

```ts
interface MemoryPluginInstallation {
  id: string
  pluginId: string // Reverse-DNS stable ID, e.g. "ai.mem0.memory"
  transport: 'streamable-http' | 'stdio'
  endpoint?: string // Remote only
  commandRef?: string // Local only: operator allowlist ref, NEVER a tenant command
  pinnedProfileMajor: 1
  expectedManifestDigest?: string
}

interface ExternalMemoryConnection {
  id: string
  orgId: string
  installationId: string
  config: Record<string, unknown> // Validated against manifest JSON Schema; no secrets
  secretKeys: string[] // Return names only; values use the SecretCipher store
  status: 'probing' | 'ready' | 'degraded' | 'invalid'
}

interface ExternalMemoryBinding {
  connectionId: string
  recall: { mode: 'auto' | 'tool-only'; topK: number; maxBytes: number; timeoutMs: number }
  capture: { mode: 'turn' | 'manual' }
}
```

- An **installation** is installed or registered by a platform/daemon
  administrator and defines the executable plugin and trust boundary.
- A **connection** contains an organization's configuration and credentials for
  one backend instance/account. One plugin may have multiple connections.
- A **binding** alone enters agent configuration. It references a `connectionId`
  and defines product behavior. Endpoints, plugin commands, and upstream
  credentials never enter `AgentSpec`.

Remote v1 may present installation and connection as two consecutive UI steps,
but the domain and wire formats retain the distinction. Otherwise, adding a
second Mem0 account or multiple endpoints for one plugin would require a
breaking migration.

#### 3.3.2 Plugin ABI: AgentConnect Memory Plugin Profile over MCP

MCP is used to reuse
[version/capability negotiation and lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
request correlation, timeout/cancellation,
[`stdio` / Streamable HTTP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
and
[structured tool output](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
It does **not** mean every MCP server is a memory plugin.

In addition to the manifest, every operation's structured input contains
core-constructed context. Secret values are never JSON arguments: the relay
injects headers for remote plugins, while daemon-private credential context
injects them for stdio.

```ts
interface PluginCallContext {
  requestId: string
  connection: { id: string; config: Record<string, unknown> }
  scope: { kind: 'agent' | 'user' | 'session' | 'shared'; key: string }
}
```

A plugin must implement the `agentconnect.memory/v1` profile:

| MCP tool                                                    | Requirement | Semantics                                                              |
| ----------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `agentconnect_memory_manifest`                              | Required    | Plugin/version/profile, connection schema, capabilities, and limits    |
| `agentconnect_memory_recall`                                | Required    | Context + query/budget → `{records:MemoryRecord[]}`                    |
| `agentconnect_memory_capture`                               | Required    | Context + stable operationId + turn/text observation → receipt         |
| `agentconnect_memory_health`                                | Optional    | Connection credential/backend readiness, without reading memory bodies |
| `agentconnect_memory_operation_status`                      | Optional    | Query accepted/completed/failed state of asynchronous capture          |
| `agentconnect_memory_list`, `agentconnect_memory_get`       | Optional    | Entry console/read tool                                                |
| `agentconnect_memory_create`, `agentconnect_memory_update`  | Optional    | Manual creation/editing                                                |
| `agentconnect_memory_delete`, `agentconnect_memory_history` | Optional    | Deletion and audit history                                             |

Minimum canonical manifest:

```ts
interface MemoryPluginManifest {
  profile: 'agentconnect.memory/v1'
  plugin: { id: string; version: string }
  connection: {
    configSchema: Record<string, unknown>
    secretFields: Array<{ name: string; required: boolean; transportHeader?: string }>
  }
  capabilities: {
    scopes: Array<'agent' | 'user' | 'session' | 'shared'>
    operations: Array<'recall' | 'capture' | 'list' | 'get' | 'create' | 'update' | 'delete' | 'history'>
    asyncCapture: boolean
    idempotency: 'operation-id' | 'none'
  }
  limits: { maxQueryBytes: number; maxRecordBytes: number; maxBatchItems: number }
  declaredEgressHosts?: string[]
}
```

Profile requirements:

- Every successful result must include profile-defined `structuredContent` and
  `outputSchema`. Returning only free text is a protocol error.
- Operation failure uses `isError:true`, with `content` containing only the
  profile's exact machine token, for example the optimistic-concurrency token
  `agentconnect.memory.error/conflict`. The core does not propagate free-text
  plugin/upstream errors, preventing record bodies or credentials from entering
  logs or HTTP responses.
- The manifest declares `pluginId`, semantic `pluginVersion`, supported profile
  majors, a non-secret configuration JSON Schema, secret field names, declared
  egress hosts, `recall/capture/CRUD/history/scopes/async` capabilities,
  `idempotency:'operation-id'|'none'`, and limits.
- Connection schema accepts only AgentConnect's bounded JSON Schema subset: no
  remote `$ref`, scripts/HTML, or plugin-defined executable UI. The console
  renders it safely using its own controls.
- After MCP initialize + `tools/list`, the daemon reads the manifest, validates
  required tools/schema/capability consistency, and compares it against the
  installation pin. An incompatible major or digest marks the connection
  `invalid`; there is no silent fallback.
- Additive optional capabilities may evolve within the same major. Breaking
  changes to required operations or canonical records require a new profile
  major.
- The daemon is the MCP server's **internal client**. Raw plugin tools never
  enter the agent's `mcpServers`/ACP session. The model sees only stable memory
  tools generated by the core.

The official Mem0 MCP can validate product value, but it does not implement this
profile, trusted scope, budgets, or receipt semantics. It therefore cannot be
used directly as a product plugin without a wrapper.

#### 3.3.3 Two Runtime Modes and Their Trust Boundaries

**v1: Remote Streamable HTTP (preferred)**

- The plugin is deployed independently; an organization owner/admin registers
  the connection.
- Reuse the relay proxy/grant/secret/SSRF primitives from
  [`centralized-tool-management.md`](centralized-tool-management.md), but with a
  separate `purpose=memory-plugin` registry/binding. Never reuse the model-facing
  `Agent.mcpServers` enable-list.
- The CP sends
  `{connectionId,pluginUrl,injectedHeaders,grantHash}` to the relay and sends
  `{connectionId,relayUrl,grant,nonSecretConfig,manifestPin}` to the daemon's
  **private memory-connection registry**.
- The daemon's internal MCP client calls the relay with a grant. After validation,
  the relay injects plugin/upstream headers. Neither the daemon nor the agent
  receives upstream credentials.
- The relay discards client attempts to override upstream authentication/headers
  before injecting connection headers. Reserved headers such as `Host`,
  `Content-Length`, and hop-by-hop headers cannot come from a manifest or user
  configuration.
- The relay forwards without recording request/response bodies. The CP is not on
  the recall/capture hot path. Cached relay bindings and daemon specs continue
  to work during a CP outage.

Every connection must have its own grant. It cannot reuse centralized MCP v1's
organization-wide shared grant: a memory binding is referenced per agent, and
the next call must fail after a connection is revoked. The CP statically
validates the remote URL. On every connection, the relay pins DNS, rejects
private and metadata addresses, and revalidates redirects under the same rules
as the centralized MCP SSRF gate. Deployment-level exceptions for private
plugins use the separate `RELAY_MEMORY_ALLOWED_UPSTREAMS`; they never inherit
model-facing `RELAY_MCP_ALLOWED_UPSTREAMS`.

**Later: Local stdio**

- A binary/package may enter the allowlist only after a daemon operator
  preinstalls it. Tenants may reference only `commandRef`; they cannot upload
  code, paths, or arbitrary commands/arguments.
- The plugin is an independent child process. Crashes and timeouts do not crash
  the daemon. Processes or credential contexts are isolated per connection.
- Connection secrets use a dedicated daemon-private lease/registry and are
  provided only to the plugin child, never written to `AgentSpec.secrets`,
  `agent.json`, or the agent runtime environment.
- Even if Node in-process packages are supported later, they are explicitly
  trusted extensions with full daemon authority, not an ordinary third-party
  plugin path.

Remote connection definitions without a `transport` normalize to
`streamable-http` for wire compatibility. Stdio definitions use an explicit
discriminator and may be sent only when the target daemon advertises the
corresponding capability.

For a remote plugin's second-hop egress, `egressHosts` is merely an
administrator-visible **declaration**, not a security boundary AgentConnect can
enforce. The relay can enforce only the plugin endpoint to which it connects.
Choosing a third-party plugin means trusting its server-side behavior, which the
UI must state accurately.

#### 3.3.4 Distribution, Health Probing, and Placement

Agent disk stores only
`provider:'external' + connectionId + policy`. The daemon separately holds a
CP-owned connection registry, analogous to CP-pushed MCP definitions, converged
through the `register/ok.memoryConnections[]` snapshot plus
`memoryconnection/upsert/remove`. The spec includes at least:

```ts
interface MemoryConnectionSpec {
  id: string
  revision: number
  pluginId: string
  profileMajor: 1
  transport: 'streamable-http' | 'stdio'
  proxyUrl?: string
  grantHeaders?: Array<{ name: string; value: string }> // Relay grant, not upstream key
  commandRef?: string
  config: Record<string, unknown>
  manifestPin?: string
}
```

The daemon builds an internal MCP client, probes manifest/health, then reports
facts as
`{connectionId,pluginId,version,profile,capabilities,status}`. Placement and
admission have two layers:

1. **Static fail-closed**: if a connection is missing, the profile/capabilities
   are incompatible, a local plugin is not installed, or the runtime lacks a
   verified native-memory off switch, do not start an agent that merely
   _appears_ to have memory.
2. **Runtime fail-open**: if a previously verified plugin temporarily returns
   a timeout/429/5xx, answer the current turn without memory and mark the
   connection/agent degraded.

Runtime recovery must match the current reason. For example,
`recall_unavailable` is cleared only by a later successful recall. A successful
records-page list/get must not mark an untried recall path Ready. Although a
single connection status is not a per-capability state vector, it must not
degrade into a noisy "last arbitrary operation succeeded/failed" signal.

The connection/plugin/capability revision from a binding enters the session/host
signature. Switching connections or visible tool capabilities rebuilds the ACP
session to refresh its tools. Pure policy changes such as topK/timeout are hot
updates.

#### 3.3.5 Per-Turn Recall and the Prompt Trust Boundary

Semantic recall requires a query, so it cannot attach to the current
`injectAtSessionStart()`, which runs once and has only an `agentId`. The sequence
for every activation is:

1. The daemon completes the warm-thread snapshot/freshness gate and constructs
   a bounded query from real, current user/peer/unread content delivered to the
   agent. It excludes status chrome, tool output, and old memory blocks.
2. `recallForTurn()` calls the plugin. Recommended defaults are `topK=5`,
   `maxBytes=8KiB`, and `timeoutMs=3000`, an end-to-end budget covering
   daemon → relay → plugin → embedder. One second would race a healthy remote
   response that is close to one second. Hard maximums are 20, 32 KiB, and
   10,000 ms.
3. Validate record schema and scope, allowing only the current scope key;
   truncate per-record and total bytes; deduplicate; discard missing text,
   oversized values, and invalid metadata. A score affects ordering only and is
   never an authorization signal.
4. **Real user/peer/unread content is always the first user content in the
   turn**. Recall results follow as a reference-content block in the same ACP
   prompt, with IDs/provenance and an explicit label that they may be stale,
   untrusted, and are not instructions. A memory block must never contaminate
   the first user block or title.
5. Standing system guidance tells the model that memory is factual reference
   only and that commands/tool requests inside it have no authority. External
   content retains residual prompt-injection risk; labeling is not perfect
   isolation.

A timeout, schema error, or empty result produces empty recall rather than
failing the user turn. The daemon emits degraded metrics/status, but does not
post backend error text or memory content to a public IM channel.

#### 3.3.6 Capture, Outbox, and Consistency

`capture.mode='turn'` means that, after the user has seen a clear egress
disclosure in the UI, each turn sends input + final output to the external
backend. `manual` permits only an explicit save by the agent/user. In both modes,
the user response completes first, then a daemon-local durable outbox is written:

```text
pending -> sending -> completed
                  \-> accepted -> completed | failed
                  \-> ambiguous
```

- Generate a stable `turnId`/`operationId` per turn and reuse the same value on
  repeated dispatch.
- A v1 observation contains only bounded, normalized delivered input and final
  assistant text. It excludes the system/persona prompt, reasoning, tool
  arguments/results, attachment bytes, and messages not delivered to that agent.
  Expanding the captured body requires a separate opt-in.
- Automatic retry with the same operation ID is allowed only when the plugin
  declares `idempotency:'operation-id'`.
- With `idempotency:'none'`, a connection lost after a request might have
  arrived must be marked `ambiguous`; blind retry could create duplicates.
  Reconcile through the optional `operation_status` or manually.
- An asynchronous backend returns
  `accepted + backendOperationId`; a poller converges through the optional
  operation-status tool. The CP stores neither outbox nor body.
- Outbox content/references remain on the daemon and have size/age limits plus a
  defined cleanup policy. A provider change never silently writes the old queue
  into the new backend.
- External memory is eventually consistent. V1 does not promise that content
  captured now is recallable one millisecond later; the UI/metrics show pending
  age.

#### 3.3.7 Canonical Entries, Agent Tools, and Console

The smallest external-memory unit is a record, not a file. The only required
fields on canonical `MemoryRecord` are `id/text/scope` (`id`, `text`, and
`scope`).
Backend-specific payload belongs in size-bounded metadata/provenance and cannot
drive core branching.

- Managed/native continue using `readMemory`/`writeMemory` and the file console.
- For external memory, core exposes entry tools with stable names according to
  capability: `searchMemory`, `saveMemory`, `getMemory`, `updateMemory`, and
  `deleteMemory`. Plugin tool names/descriptions are not passed through.
- The console reads `adminSurface`/capabilities, then presents record search,
  pagination, ID, text, scope, timestamps, and history. It does not render an
  update/delete action when the capability is absent.
- Record-shaped CP↔daemon frames and REST endpoints route files or records
  according to the active provider. The CP may proxy an administrative request
  transiently, like the current memory console, but does not persist bodies or
  enable body capture in logging/tracing.
- Record `version`/backend ETag is optional. A plugin supporting update must use
  it for optimistic concurrency rather than reusing file `mtime`.

#### 3.3.8 V1 Scope: Agent Only

M-3's trusted user/session classification remains deferred, and stable
cross-platform identity is not yet available to daemon memory policy.
Consequently, M-5 v1 sends only a daemon-derived opaque agent key unique within
the connection, for example `ac:agent:<agentId>`:

- Scope is not a free input to an agent tool or plugin request.
- Future user/session keys must derive from normalized message/session context.
  Raw platform user IDs should first receive an organization/connection-scoped
  HMAC to prevent third-party cross-connection correlation.
- A plugin declares only the canonical scopes it supports. It does not decide
  whether a memory is promoted from user to agent/shared.
- Shared scope remains separately designed under §5; a backend's claim of
  multi-agent support does not enable it automatically.

#### 3.3.9 First Plugin: Mem0

The first-party `ai.mem0.memory` plugin ships as an independently deployable
Streamable HTTP server/package and is not imported by the daemon. It supports
**Mem0 Cloud V3** first, followed by an OSS REST dialect. They must not pretend
to be one `endpoint + apiKey` client:

- Cloud add is `POST /v3/memories/add/` and returns `event_id`. Map this to
  `CaptureReceipt{state:'accepted',backendOperationId:event_id}`, then converge
  through `GET /v1/event/{event_id}/`.
- Cloud search is `POST /v3/memories/search/`; list is
  `POST /v3/memories/`. Single-record update/delete/history remains V1.
  Authentication is `Authorization: Token`.
- OSS REST uses `/memories`, `/search`, and `X-API-Key`. Its response and async
  capabilities differ and require a separate adapter/capability probe.
- Each v1 write selects one primary entity:
  `agent_id=ac:agent:<agentId>`. Metadata includes
  `ac_turn_id/ac_session_id/ac_connection_id`. Do not send several primary
  entities and assume AND search.
- Future multi-scope recall searches scopes separately, then core merges and
  deduplicates. Mem0 entity rules must not become AgentConnect scope rules.
- Mem0 documents no add idempotency key, so the Cloud plugin declares
  `idempotency:'none'` and does not retry an ambiguous add automatically.

References: [Cloud add](https://docs.mem0.ai/api-reference/memory/add-memories),
[search](https://docs.mem0.ai/api-reference/memory/search-memories),
[event](https://docs.mem0.ai/api-reference/events/get-event),
[entity scope](https://docs.mem0.ai/platform/features/entity-scoped-memory),
[OSS REST](https://docs.mem0.ai/open-source/features/rest-api), and
[official MCP](https://docs.mem0.ai/platform/mem0-mcp).

#### 3.3.10 Security and Observability Invariants

- External memory is an explicit per-agent opt-in; managed remains the default.
  The UI states which plugin/backend receives recall queries and captured turns,
  along with retention/egress declarations.
- Upstream/plugin secrets use [`SecretCipher`](secret-store-seams.md). Values
  never enter DTOs, `AgentSpec.secrets`, the agent child environment,
  `agent.json`, logs, or error strings. In remote mode, values exist only in the
  CP store, relay memory, and plugin endpoint.
- Internal MCP calls have per-operation timeout/cancellation, concurrency
  limits, response/body caps, schema validation, a circuit breaker, and process
  crash backoff. Daemon/agent shutdown must close the client/process.
- Metrics include at least recall latency/error/result count/injected bytes;
  capture completed/accepted/failed/ambiguous; operation age; outbox depth and
  oldest age; auth/429/5xx; plugin restart and manifest mismatch.
- Traces/logs contain only connection/plugin/operation IDs and status, never
  queries, record text, turn bodies, or auth headers.
- External memory permits content to leave the daemon through the relay/plugin,
  so it does not satisfy managed memory's strict body locality. Its guarantee is
  instead: explicit user opt-in, no CP persistence or hot-path involvement, and
  content flowing only through the declared data plane.

## 4. Managed Provider Internals (Distillation, Scopes, and Change Log)

### 4.1 Extract→Append Distillation (Solves M1)

Inspired by Mem0 v2.0.11's **single additive pass**. Note: the widely reported
"two LLM calls for reconciliation" was dead code in that version.

1. **Trigger**: at turn end, session end, or compaction, the daemon makes **one
   small LLM call** with the current turn plus relevant memory (index + a few
   topics). The prompt follows `ADDITIVE_EXTRACTION_PROMPT`: "extract
   self-contained, context-rich memory statements; preserve proper nouns and
   numbers; skip semantic duplicates; connect related facts; ADD only." Prefer
   reusing the agent runtime, or make a separate small daemon-side call for
   runtime independence.
2. **Deduplication**: use MD5 to block literal duplicates, then provide existing
   similar memories to the LLM under integer IDs so it can skip semantic
   duplicates without hallucinating identifiers.
3. **Write**: append to the target scope's topic, or create a topic and update
   the index.
4. `memory.autoDistill` is **opt-in**, disabled by default to avoid an extra LLM
   cost on every turn. Manual `writeMemory` is always available.

### 4.2 Scopes (Solves M2)

Use one vocabulary combining Mem0 scopes and the L1/L2 model, represented by
filesystem directories without a database:

```
<agent-root>/memory/
  MEMORY.md / <topic>.md       # Persistent L2 (per-agent, current behavior)
  users/<userKey>/…            # User scope (Mem0 user_id)
  sessions/<sessionKey>/…      # L1 session/working memory (Mem0 run_id)
```

Injection consists of the L2 index, the matched user-scope index, and the
session's L1 index under one total byte limit. Put the **scope dimension in the
interface now** (`MemoryScope`), following the warning that it is hard
to retrofit later, even if implementation begins with L2 only.

### 4.3 Change Log (Solves M3)

For every ADD/UPDATE/DELETE, append a row to
`<agent-root>/memory/.history`, backed by sidecar SQLite or JSONL:
`{path, event, before?, after, at, scope, source: tool|distill|console}`.
This provides provenance and undo at negligible cost. Managed JSONL history uses
system defaults rather than per-user configuration: retain the newest 100 changes
per file, cap the whole sidecar at 2 MiB, and prune oldest rows first.

## 5. Shared / Cross-Agent Memory (Shared Scope)

Cross-agent and cross-daemon shared memory needs a mutually reachable location,
but body locality forbids putting content in the CP. It therefore uses the
shared-bot data plane (relay), **not the CP**. `memory-sync` is another
relay payload reusing the shared-bot ingress/data-plane infrastructure.
Discovery already exists through
[`channel/agents`](../../packages/protocol/src/frames/channel.ts); the
missing capability is shared writes + reads. These are two uses of the same
layer as shared-bot agent collaboration (Path B).

Shared scope is a **cross-provider concept above providers**. Managed shared
scope synchronizes files through the relay. External may declare shared-storage
capability, but visibility, authorization, and promotion remain decisions of
AgentConnect core and do not inherit a third party's "multi-agent" switch.
Native usually cannot share because runtime memory is local.

## 6. Provider Selection and Configuration

Agent configuration uses a discriminated shape across protocol `AgentSpec`, CP
`AgentDto`, and web. Managed is the default:

```ts
type MemoryConfig =
  | { provider: 'none' }
  | { provider: 'native' }
  | { provider: 'managed'; autoDistill?: boolean; home?: 'daemon' | 'control-plane' }
  | {
      provider: 'external'
      connectionId: string
      recall?: { mode?: 'auto' | 'tool-only'; topK?: number; maxBytes?: number; timeoutMs?: number }
      capture?: { mode: 'turn' | 'manual' }
    }
```

- `home` (§3.2.1) defaults to `daemon`. The CP writes the resolved value on create so
  a later placement change never flips it implicitly; an agent placed on the
  install-wide pool must carry `control-plane`, and the console fixes the selector
  there. Changing `home` is the one binding change that copies memory (§3.2.1).
- `connectionId` must belong to the agent's organization, and the caller must
  be authorized to use it. The CP does not accept per-agent
  `endpoint/apiKey/command`.
- The binding uses existing `agent/upsert` / `register/ok.agents[]`; the
  connection spec uses the daemon-private registry in §3.3.4. The two wire
  formats remain separate.
- The console first selects a provider. For external, it then selects a ready
  connection and presents plugin/backend, recall/capture egress, and
  capabilities. `capture.mode` requires explicit confirmation and may not send a
  turn body through a hidden default.
- **V1 does not support seamless provider switching** (product decision).
  Changing a provider or external connection is an **explicit
  reconfiguration**. The console warns: "Memory in the old backend will not be
  migrated, and incomplete capture will not be redirected to the new backend."
  Old data remains in its original location but is no longer injected. Migration
  is future work; see §9.

### 6.1 Memory Capabilities for New Runtimes / Agent Harnesses

Disabling and redirecting runtime-native memory, as well as locating its files,
are harness-specific capabilities registered centrally in
[`memory/runtime/capabilities.ts`](../../packages/daemon/src/memory/runtime/capabilities.ts). They
must not be scattered as provider-specific string checks. One runtime policy
drives the off switch for `managed`/`none` and the redirect/read root for
`native`, preventing two allowlists from drifting. Matching prefers registry ID,
with command/argument signature as a fallback for `npx`/`uvx` wrappers and
custom aliases.

When adding a harness we promise to support, explicitly declare expected
`managed`/`none`/`native` behavior in the ACP matrix profile, and compare the
contract test to the production registry. `managed` is always available.
`none` is available only after verifying an off switch (or verifying the absence
of persistent native memory). `native` is available only after both redirect
and console read root are verified. Like `none`, `external` requires a verified
off switch: selecting a third party as the only store must not let an unknown
runtime secretly retain another persistent copy. See the complete product
invariant in
[`product-conventions.md`](../product-conventions.md#runtime-memory-provider-compatibility).

## 7. Explicit Non-Goals

- **Embeddings + vector database + semantic retrieval** inside managed memory:
  this conflicts most strongly with "Markdown, no embeddings, content remains
  at the edge." Selecting files through the index is sufficient. The cheapest
  future opt-in is **BM25 over Markdown** (the Mem0 scoring formula can be
  adapted without embeddings). Vectors remain later work. `MemoryProvider`
  lets a stronger managed retrieval implementation replace the current one
  without affecting upper layers.
- **Entity database / graph layer** (Mem0g, which did not exist in the referenced
  Mem0 SDK version): skip it.
- **Dynamically importing the Mem0 SDK or arbitrary tenant packages into the
  daemon**: real third-party extensions use the out-of-process profile.
  In-process code can only be explicitly operator-trusted built-in code.
- **Treating arbitrary MCP servers as memory plugins or exposing raw plugin tools
  to the model**: a plugin must conform to `agentconnect.memory/v1`, and agents
  see only core tools.
- **Passing external credentials through `AgentSpec.secrets` or the runtime
  environment**: doing so would expose the key to the model child. Use the
  connection secret store and relay/daemon-private path.
- **Having M-5 also promise user/shared isolation, cross-provider migration, or
  exactly-once capture**: v1 is agent-only and eventually consistent. The latter
  topics remain in §9 and future capability/idempotency work, respectively.

## 8. Implementation Status

| Phase                                                    | Scope                                                                                                                                                                                                                     | Body locality                                                              | New infrastructure           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| **M-1 · MemoryProvider + managed (complete)**            | Wrap directory memory in the provider port.                                                                                                                                                                               | ✅                                                                         | None                         |
| **M-2/M-2.1 · native/none (complete)**                   | Provider selection, runtime-memory capability registry, native redirect/none off switch, and console.                                                                                                                     | ✅                                                                         | None                         |
| **M-3 · managed scope/history (partial/deferred)**       | `.history`; user/session scopes await trusted identity/classification decisions.                                                                                                                                          | ✅                                                                         | None                         |
| **M-4 · managed extract→append (complete, default off)** | Additive distillation + deduplication; current post-turn queue remains gated by managed/autoDistill.                                                                                                                      | ✅                                                                         | None (existing LLM)          |
| **M-5P · plugin profile (complete)**                     | Canonical schema, manifest/version/capability, daemon internal MCP client, fake remote plugin conformance tests; provider port adds per-turn recall + record admin surface, and post-turn queue becomes provider-neutral. | ✅ (fake/local fixture only)                                               | None                         |
| **M-5A · connection data plane (complete)**              | Installation/connection/binding model, SecretCipher, per-connection relay grant/SSRF, connection snapshot/upsert, probe facts/placement, and egress UX.                                                                   | ⚠️ Probe reaches plugin                                                    | Reuse relay/MCP proxy        |
| **M-5B · Mem0 Cloud plugin (complete)**                  | Agent-only per-turn recall, capture outbox, Cloud V3 event polling, failures/metrics; CRUD console deferred.                                                                                                              | ⚠️ Content leaves daemon for third party by explicit user choice           | External plugin + Mem0       |
| **M-5C · record product surface (complete)**             | Core entry tools + provider-aware record REST/frames/console, with CRUD/history driven by capability.                                                                                                                     | ⚠️ Same as above                                                           | None                         |
| **M-5D · dialect/runtime expansion (complete)**          | Mem0 OSS adapter; operator-installed stdio host + daemon-private secret lease.                                                                                                                                            | OSS/local depends on deployment                                            | stdio host                   |
| **M-6 · shared scope (through data plane)**              | Depends on shared-bot relay; `memory-sync` payload; managed shared-scope sync + conflict semantics; external reuses canonical shared policy.                                                                              | ✅ / explicit external egress                                              | Reuse relay                  |
| **M-8 · `home: control-plane` (designed, not built)**    | `agent_memory_file` in the CP, `memory/store` D→C pair over the shim op set, `CpMemoryFs` adapter, home switch copy, pool mandates it (§3.2.1).                                                                           | Curated Markdown in the CP by explicit binding; default stays daemon-local | CP table                     |
| **M-7 · optional retrieval upgrade**                     | BM25 over Markdown; leave vector seam.                                                                                                                                                                                    | ✅                                                                         | None for BM25; vectors later |

The plugin profile remains backend-agnostic, and the Mem0 implementation stays
behind that ABI. Automatic recall/capture and the record administration surface
remain separate capabilities.

## 9. Memory Migration Research (Future Work, Not in V1)

V1 does not migrate on provider switch, but this section studies how future
migration would work. Migration means **transforming memory from provider A's
representation into provider B's representation**. The hard part is that the
three providers use fundamentally different **shapes**:

|              | Memory shape                                                                                  | Exportability                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **native**   | Runtime-private format (Claude auto-memory `MEMORY.md` + topics / CLAUDE.md; Codex AGENTS.md) | Readable files, but runtime-defined structure and semantics                          |
| **managed**  | Our directory: `MEMORY.md` index + topics + scope directories + `.history`                    | Fully controlled, because these are our files                                        |
| **external** | Private representation behind canonical plugin records (Mem0: vectors + payload + entity)     | Depends on plugin/backend export; may expose only distilled results, not source text |

**Pairwise analysis:**

- **managed → native**: write topic content into the runtime's memory files
  (Claude: CLAUDE.md/memory directory under `<agent-root>/.claude`; Codex:
  AGENTS.md). Index/scope structure is flattened because native usually lacks
  our scope model. **Relatively feasible** because both are files, but lossy
  because scope/history disappears.
- **native → managed**: reverse the operation, reading runtime memory files as
  managed topics and rebuilding the index. **Feasible but lossy**, because
  runtime organization may not map to our scopes.
- **managed → external**: convert each topic/memory item into a canonical record
  and write it through plugin `create/import` with its scope. **Capability
  dependent**. The external system then distills/deduplicates in its own way and
  no longer preserves our file semantics.
- **external → managed / native**: depends on service export. The result is
  usually **distilled memory statements** — Mem0 stores extraction output rather
  than the original conversation. These can become topic files, but **the
  original context cannot be recovered**. Full export availability depends on
  the service.
- **Any direction involving native or external** is **lossy and friendlier in
  one direction**, because managed is the only representation fully controlled
  by us.

**Candidate approaches:**

1. **Canonical intermediate format**: extend §2 `MemoryRecord` into a
   provider-independent export format (memory entry + scope + optional
   provenance). Each provider/plugin implements `export()→canonical` and
   `import(canonical)`. Migration becomes A.export → B.import. This also provides
   memory backup/export, addressing HA open question 2.
2. **Managed as a hub**: implement bidirectional "any provider ↔ managed" only.
   A→B becomes A→managed→B, cutting the number of pairs roughly in half.
3. **Explicitly accept loss**: document migration as best-effort and lossy
   because scope, history, or source text may disappear. Show exactly what will
   be lost before migration in the UI.

**Direction:** if implemented, choose candidate 1's **canonical export format**,
which also solves backup, and add `export/import` to `MemoryProvider`. Until
then, switching means abandoning old memory and starting blank (§6). **This
migration work is not implemented.**

## 10. Tests

- **Core/provider unit**: standing/recall/record/admin-surface matrix for all
  four providers; managed distillation parsing + deduplication + scope-path
  isolation + `.history`; item/byte/schema caps on all recall/canonical records;
  ACP-matrix harness capabilities match the runtime-policy registry; external
  fails closed on a runtime without an off switch.
- **Plugin conformance**: fake Streamable HTTP plugin covers required
  manifest/recall/capture contract; reject missing tools, incorrect output
  schemas, manifest/tool capability contradictions, major/digest mismatch,
  oversized response, and timeout/cancellation; cover every optional
  CRUD/history capability independently.
- **Daemon lifecycle**: every activation recalls with the current query; real
  delivered content precedes memory reference; fresh titles do not derive from
  memory; recall failure still prompts/replies; raw plugin MCP tools do not
  appear in ACP `session/new`; binding capability changes rebuild the session,
  while policy-only updates do not.
- **Capture/outbox**: response does not wait for capture; stable operation ID;
  retry only for `idempotency:'operation-id'`; post-send timeout becomes
  ambiguous; async accepted→poll→completed/failed; provider/connection switch
  does not redirect old capture; restart recovery, queue caps, and retention.
- **Connection data plane**: register snapshot + upsert/remove converge;
  per-connection grant returns 401 on the next call after revocation; CP/relay
  SSRF cases (DNS rebinding/private/metadata/redirect); plugin secrets absent
  from DTO/AgentSpec/agent.json/runtime environment/log/error; relay/CP body
  logging disabled.
- **Mem0 contract fixture**: Cloud V3 add/search/list/event and V1 single-record
  endpoint; Token authentication; event receipt mapping; no retry of ambiguity
  without idempotency; separate OSS dialect suite for
  `/memories`/`/search` + `X-API-Key`.
- **CP/web**: same-organization connection binding validation; files/records
  surface routing; capability-driven actions; external recall/capture egress
  disclosure and explicit capture confirmation; provider/connection switch
  warning that no migration occurs.
- **M-6**: shared memory round-trip through relay; conflicts do not overwrite
  each other; the relay may hold payloads in memory while forwarding but does
  not persist them, and the CP neither receives nor persists that content.

## 11. Open Questions

1. **Distillation trigger timing** (managed): every turn (real-time but costs
   tokens) vs session end/idle (cheaper but delayed) vs hybrid. The latter is
   recommended by default.
2. **Which LLM performs distillation**: reuse the agent runtime or make a
   separate small daemon-side call.
3. **Cross-platform normalization for user-scope keys**: how to unify Slack
   userId and webchat identity.
4. **Relationship between L1 and the daemon transcript**: whether to derive L1
   from the existing transcript to avoid duplication.
5. **Shared-memory consistency model** (M-6): optimistic locking vs
   owner-serialized access, modeled after the shared-bot centralized egress.
6. **Native capability differences**: runtimes differ in native-memory
   capability and location. How should `MemoryProvider` declare and the UI show
   what native memory supports for a runtime?
7. **Installation supply chain**: should M-5A allow only owners to register
   remote endpoints + manifest pins, leaving a signed catalog/package
   distribution until a second third-party plugin exists? Recommended.
8. **Outbox retention**: copy bounded turn payload or save only a transcript
   reference + content hash; each option needs separate validation against
   transcript GC and crash recovery.
9. **Recall budget**: `5 hits / 8KiB / 1s` is the initial safe default and needs
   calibration against real plugin latency and answer-quality evaluation.
10. **Agent-only v1**: should M-5 deliver agent scope first without also solving
    promotion/privacy classification in multi-user threads? Recommended: yes.
11. **First-party Mem0 hosting**: publish only a self-hostable plugin
    package/container, or also host an official endpoint as a deployment
    component? Recommendation: deliver an independent artifact and optional
    deployment component first; do not promise a multi-tenant managed plugin
    service in this design.

The fixed boundaries are: external memory uses a third-party, out-of-process MCP
profile rather than a compiled Mem0 switch; raw plugin tools do not reach the
model; credentials do not enter AgentSpec or the runtime environment;
provider/connection switches do not migrate memory (§6/§9); and the plugin
registry uses separate memory-specific tables
(`memory_plugin_installation`, `ExternalMemoryConnection` plus its secret
table, and `ExternalMemoryGrant`) rather than the model-facing enable-list.
