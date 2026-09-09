# AgentConnect Memory System

**Status:** Implemented.

The [unified memory interface](unified-memory-interface.md) now supplies common reads, conditional managed mutations, model/admin projections, and a capability-driven console. Supported new/native-resumed sessions receive a bounded catalog; continuously live refresh remains pending. The lifecycle and compatibility paths below remain relevant.

Agent memory is isolated per agent, lives outside the workspace, and is
selected through a provider-neutral lifecycle. The implementation authority is
`packages/daemon/src/memory/provider.ts`; see
[memory-evolution.md](memory-evolution.md) for the external-plugin contract and
provider lifecycle.

---

## 1. Goals and Invariants

- Memory belongs to an agent, not to a workspace checkout.
- Workspace reset, replacement, or repository operations must not modify agent
  memory.
- The Control Plane proxies memory administration. Managed memory with
  `home: control-plane` is the curated-content exception: its home authority
  persists memory bodies, history, and atomic mutation receipts.
- Runtime-native memory must be isolated per agent or explicitly disabled so
  two memory systems do not run concurrently.
- Agent-facing tools expose a stable AgentConnect contract rather than
  backend-specific APIs.
- File paths, record scopes, recall budgets, and capture timing are enforced by
  trusted daemon code.

## 2. Provider Model

Each agent selects one provider:

| Provider       | Behavior                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **`managed`**  | AgentConnect owns Markdown memory, exposes common entries, and retains file compatibility tools.  |
| **`native`**   | The runtime owns memory; the daemon redirects its memory/configuration directory into agent root. |
| **`external`** | A registered memory plugin supplies per-turn recall and capture through the canonical plugin ABI. |
| **`none`**     | Persistent memory is disabled, including verified runtime-native memory mechanisms.               |

`managed` is the default. Provider selection is persisted with the session so a
provider change causes the ACP host/session boundary to be rebuilt rather than
mixing memory from different providers.

## 3. Managed Memory Layout

Daemon-local home layout (`--root`, default `~/.agentconnect`); a Control Plane
home stores the same logical topics at its authority instead:

```text
~/.agentconnect/
  agents/<agent-id>/
    agent.json
    memory/
      MEMORY.md
      <topic>.md
      .history
    workspace/
```

`MEMORY.md` is the index. Topic files are flat, one level below `memory/`.
The daemon creates the index when absent and injects only that index into a
fresh ACP session, with a bounded size. The agent reads topic files on demand,
so a large memory collection does not inflate every prompt.

Every managed write also appends a bounded provenance row to the hidden
`.history` JSONL sidecar. Rows retain the file, change kind, before/after
snapshots, timestamp, scope, and source. The sidecar is not a topic and is never
injected into an agent prompt. Retention is a fixed system policy rather than a
user setting: keep the newest 100 changes per memory file and cap the complete
sidecar at 2 MiB, pruning oldest rows first. The daemon compacts after writes and
on history reads so legacy oversized sidecars are tightened automatically.

File operations accept only safe relative Markdown paths within the memory
directory. They reject traversal, subdirectories, symlink escapes, unsupported
extensions, and writes that exceed the configured limits. Writes replace the
whole named file and use modification-time checks where the caller supplies an
expected version. These are legacy file semantics. Common entry mutations on
capable Control Plane homes require create-if-absent or a current revision, and
commit topic/index/history together. Native-writable and older homes do not
advertise those strong guarantees.

## 4. Runtime Integration

The provider supplies spawn-time environment overrides:

- `managed`, `external`, and `none` disable verified runtime-native memory
  features to avoid duplicate or unintended persistence.
- `native` redirects the supported runtime's memory/configuration directories
  into the agent root.
- Unsupported combinations fail closed instead of silently falling back to a
  host-global memory directory.

Managed memory is runtime-neutral. It supplies standing context through prompt
injection and exposes common entry tools through the daemon-owned MCP server,
with `readMemory`/`writeMemory` retained for compatibility and bound extraction
workflows. Common mutations are preferred when capability discovery supports
them; a conflict or unknown outcome must not fall back to an unconditional write.
The daemon resolves the agent identity and path; the model cannot
select an arbitrary filesystem location.

External memory uses record-oriented recall and capture rather than pretending
records are files. Recall runs for each activation with a trusted scope and
bounded query, result count, byte budget, and timeout. Capture is queued after
the response so it does not delay delivery to the user.

## 5. Daemon, Protocol, and Console Flow

File-oriented providers use the daemon-control protocol:

- `memory/list` → `memory/list/page`
- `memory/read` → `memory/read/content`
- `memory/write` → `memory/write/ok`
- `memory/history` → `memory/history/page` (managed files only)

The Control Plane exposes agent-scoped memory routes and forwards requests to
the owning daemon. Authorization uses the same organization and agent
visibility rules as the rest of the agent API. An offline or unplaced daemon is
reported as unavailable. Proxying does not change content ownership; a managed
Control Plane home is the explicit persistence exception.

The console first uses common capability discovery and list/get, exposing only
actual supported mutations. The common `memory/entries/read/v1` and
`memory/entries/write/v1` transport projects the same service with console
authority. Conditional writes are not automatically replayed after an unknown
outcome. Unsupported peers and the explicit additional-tools view retain these
provider-specific compatibility surfaces:

- `files`: index/topic list with read and edit operations; managed files also
  expose lazy, newest-first change history with expandable before/after snapshots;
- `records`: search, inspect, create, update, delete, and history operations;
- `none`: no memory administration surface.

Representation-specific tools preserve index editing, links/history, external
record operations, and native administration. They cannot be removed until old
sessions/clients are drained or a documented compatibility window ends, and
legacy hand-authored indexes have an explicit preservation path.

## 6. Security and Privacy Boundaries

- Memory bodies belong to the configured managed home (daemon-local or Control
  Plane), the isolated native runtime store, or the selected external backend.
- Provider configuration contains references and non-secret settings only.
  Credentials use the platform secret store and are never returned in read
  DTOs.
- `MemoryScope` is built from trusted agent, user, and session context; neither
  the model nor a plugin may choose another principal's scope.
- External recall is untrusted context and is bounded and labeled before prompt
  composition.
- External capture uses a durable outbox, stable operation identity, retries,
  and circuit breaking so ambiguous backend outcomes do not create unbounded
  duplicate writes.
- Switching providers does not delete existing memory. Data becomes available
  again only when its provider is selected and authorized.

## 7. Extension Boundary

`MemoryProvider` owns product policy: runtime environment, standing context,
per-turn recall and post-turn capture. The common entry service owns entry
authorization/contracts; core projections own model descriptors and the common
console. Provider-specific representations remain compatibility capabilities.
External plugins translate the canonical memory profile to a
backend protocol; they do not control scope, prompt trust, retry policy, or
agent-visible tool definitions.

Installations, organization connections, and agent bindings are separate
objects. This permits multiple accounts or endpoints for one plugin without
placing executable commands, endpoints, or upstream credentials in the agent
specification.
