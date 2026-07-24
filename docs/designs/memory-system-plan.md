# AgentConnect Memory System

**Status:** Implemented.

Agent memory is isolated per agent, lives outside the workspace, and is
selected through a provider-neutral lifecycle. The implementation authority is
`packages/daemon/src/agents/memory-provider.ts`; see
[memory-evolution.md](memory-evolution.md) for the external-plugin contract and
provider lifecycle.

---

## 1. Goals and Invariants

- Memory belongs to an agent, not to a workspace checkout.
- Workspace reset, replacement, or repository operations must not modify agent
  memory.
- The Control Plane proxies memory administration but does not persist memory
  bodies.
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
| **`managed`**  | AgentConnect owns Markdown memory, injects the index, and exposes file-oriented memory tools.     |
| **`native`**   | The runtime owns memory; the daemon redirects its memory/configuration directory into agent root. |
| **`external`** | A registered memory plugin supplies per-turn recall and capture through the canonical plugin ABI. |
| **`none`**     | Persistent memory is disabled, including verified runtime-native memory mechanisms.               |

`managed` is the default. Provider selection is persisted with the session so a
provider change causes the ACP host/session boundary to be rebuilt rather than
mixing memory from different providers.

## 3. Managed Memory Layout

Daemon root (`--root`, default `~/.agentconnect`):

```text
~/.agentconnect/
  agents/<agent-id>/
    agent.json
    memory/
      MEMORY.md
      <topic>.md
    workspace/
```

`MEMORY.md` is the index. Topic files are flat, one level below `memory/`.
The daemon creates the index when absent and injects only that index into a
fresh ACP session, with a bounded size. The agent reads topic files on demand,
so a large memory collection does not inflate every prompt.

File operations accept only safe relative Markdown paths within the memory
directory. They reject traversal, subdirectories, symlink escapes, unsupported
extensions, and writes that exceed the configured limits. Writes replace the
whole named file and use modification-time checks where the caller supplies an
expected version.

## 4. Runtime Integration

The provider supplies spawn-time environment overrides:

- `managed`, `external`, and `none` disable verified runtime-native memory
  features to avoid duplicate or unintended persistence.
- `native` redirects the supported runtime's memory/configuration directories
  into the agent root.
- Unsupported combinations fail closed instead of silently falling back to a
  host-global memory directory.

Managed memory is runtime-neutral. It supplies standing context through prompt
injection and exposes `readMemory` and `writeMemory` through the daemon-owned
MCP server. The daemon resolves the agent identity and path; the model cannot
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

The Control Plane exposes agent-scoped memory routes and forwards requests to
the owning daemon. Authorization uses the same organization and agent
visibility rules as the rest of the agent API. An offline or unplaced daemon is
reported as unavailable; content is never copied into Control Plane storage.

The console selects the admin surface from the provider:

- `files`: index/topic list with read and edit operations;
- `records`: search, inspect, create, update, delete, and history operations;
- `none`: no memory administration surface.

The web and protocol layers discriminate on these representation shapes and do
not expose a concrete external backend name.

## 6. Security and Privacy Boundaries

- Memory bodies remain daemon-local for managed/native providers or in the
  selected external backend.
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
per-turn recall, post-turn capture, model tools, and the console
representation. External plugins translate the canonical memory profile to a
backend protocol; they do not control scope, prompt trust, retry policy, or
agent-visible tool definitions.

Installations, organization connections, and agent bindings are separate
objects. This permits multiple accounts or endpoints for one plugin without
placing executable commands, endpoints, or upstream credentials in the agent
specification.
