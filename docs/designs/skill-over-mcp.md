# Skill over MCP: Built-in System Skills via the Daemon MCP Bridge

> **Summary:** This document specifies the engineering design for serving AgentConnect's four built-in system skills (`agentconnect-images`, `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team`) progressively on demand through a `readSkill` tool on the daemon's built-in `agentconnect` stdio MCP bridge, rather than installing them as files into agent workspaces. The design covers static asset packaging at build time, race-free dynamic capability filtering (`hasAdminMcp` and `shareFile`), `/skill` and `!skill` slash-command translation, ledger-backed cleanup of previously installed workspace directories and sandbox pod volumes, and a two-phase retirement of the Control Plane's preset `agentconnect` Git `SkillSource`. Every detail is aligned with current symbols, database schemas, and build scripts so implementation can ship in three independent pull requests.

- **Status:** Draft
- **Baseline commit:** `5ce7770b2ecbac0a5dc79bddbdbde038534d91f8` (`origin/main`; verified against initial design baseline `dd0dc6a41ed1a9db983fb826c97acf0332df24bf`)
- **Related design documents:**
  - [`docs/designs/shared-skills.md`](shared-skills.md)
  - [`docs/designs/send-message-guide.md`](send-message-guide.md)
  - [`docs/designs/webchat-generated-images.md`](webchat-generated-images.md)
  - [`docs/designs/webchat-preset-agentconnect-mcp.md`](webchat-preset-agentconnect-mcp.md)
  - [`docs/designs/preset-agents.md`](preset-agents.md)

---

## 1. Background, goals, non-goals, and locked decisions

### 1.1 Background and current problems

AgentConnect currently distributes four built-in system skills to tenant agents across two separate filesystem installation paths:

1. **Daemon built-in skill (`agentconnect-images`)**: Source files live at `packages/daemon/builtin-skills/agentconnect-images/SKILL.md`. During workspace preparation (`prepareAgentWorkspace` / `reconcileSandboxSkills`), the daemon appends `builtin:agentconnect-images:<sha256>` to `managedSkills` and invokes the bundled `skills@1.5.21` CLI to copy the files into `.claude/skills/` or `.agents/skills/` inside the agent's workspace.
2. **Control Plane preset Git skill source (`agentconnect-md/agentconnect-skill`)**: Contains `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team`. When an organization is created or backfilled at startup (`PresetAgentBackfill`), the Control Plane inserts an ordinary `skill_source` row named `agentconnect` and writes `["agentconnect/*"]` into the preset `@agentconnect` agent's `runtimeOverrides.skills`. The daemon then resolves the `main` branch through the GitHub API and runs `skills@1.5.21` to materialize the files on disk.

Distributing built-in system skills through workspace files causes six operational problems:

- **Runtime compatibility gaps:** Runtimes outside the `AUDITED_RUNTIME_SKILLS_AGENTS` allowlist (such as `antigravity-acp`, `open-interpreter`, `maki`, `zeroclaw`, `omp`, and custom runtimes) have `skillsAgentId: null`. The daemon silently skips all filesystem skill installation for these runtimes, dropping even `agentconnect-images`.
- **Cold-start and sandbox synchronization overhead for sessions without custom skills:** Even when an organization configures no custom Git or managed skills, the presence of `builtin:agentconnect-images` or preset `agentconnect/*` forces local sessions to spawn an offline sandbox running `node skills.mjs add` and `skill-workspace-mutator`, and forces Kubernetes Sandbox Pods and Microsandbox VMs to run `ClusterSkillCoordinator` (`begin -> upload -> reconcile`) across process and network boundaries and mutate `.git/info/exclude`.
- **Workspace pollution and name collisions:** Writing `0500`/`0400` read-only skill directories into a user repository's `cwd` requires a SQLite/JSON install ledger and `.git/info/exclude` bookkeeping.
- **No awareness of session capabilities:** `agentconnect-create-agent` and `agentconnect-create-team` depend exclusively on the `agentconnect-admin` MCP catalog and native Console configuration dialogs that exist only in webchat, yet they are installed on disk for Slack, GitHub, and Cron sessions alike. Conversely, user-created agents chatting in webchat automatically receive `agentconnect-admin` MCP, but lack the platform administration and agent-creation skills unless an operator manually binds `agentconnect/*` to them.
- **Console noise and accidental deletion risk:** Every organization's Tools & Skills library is pre-populated with an editable and deletable `agentconnect` Git skill source row, leaking an internal platform mechanism into tenant configuration.
- **No invocation observability:** When a model reads a local `SKILL.md` with its native filesystem `Read` or `cat` tool, the daemon cannot observe skill or reference-file trigger rates in the ACP tool stream.

Meanwhile, the daemon's built-in `agentconnect` stdio MCP bridge is available on every MCP-capable ACP runtime, and `getToolGuide` (`packages/daemon/src/mcp/ops/tool-guide.ts`) has already established the pattern of serving detailed documentation on demand over MCP while keeping tool descriptions under the Codex 1,024-character limit.

### 1.2 Goals

1. **Universal runtime compatibility:** Expose `readSkill({ name, path? })` on the daemon's built-in `agentconnect` stdio MCP bridge so Claude Code, Codex, Antigravity, Muse, DSH, OpenCode, Cline, Pi, and every other stdio-MCP-capable runtime can load built-in system skills on demand.
2. **Zero-extra-round-trip discovery:** Inline one-line trigger summaries for the current session's active system skills directly in `readSkill`'s dynamic `description` and `inputSchema.properties.name.enum` (strictly within the OpenAI/Codex `<= 1,024`-character ceiling), allowing the model to call `readSkill` directly without a prior `listSkills` round trip.
3. **Capability-scoped exposure per session:** Dynamically expose matching system skills to **all agents** in an organization based on the session's live `SessionContext` (whether `shareFile` is offered and whether `agentconnect-admin` MCP is attached).
4. **Zero disk materialization and faster cold starts:** Stop writing the four built-in system skills to workspace disk; eliminate `skills@1.5.21` CLI subprocesses and `ClusterSkillCoordinator` RPCs for sessions and Kubernetes Sandbox Pods that have no custom skills, while safely uninstalling residual built-in skill directories from upgraded workspaces.
5. **Two-phase retirement of the preset `agentconnect` Git `SkillSource`:** Stop creating the `agentconnect` `SkillSource` row and `agentconnect/*` binding for new organizations, and retire existing rows across two phases (daemon deduplication and workspace cleanup first, Control Plane database migration second).

### 1.3 Non-goals

1. **No change to user- or organization-defined custom skills:** User-configured Git `SkillSource` entries, Console-uploaded `ManagedSkill` ZIP bundles, and accepted agent-local Dream skills continue through the existing `installSkills` / `reconcileSandboxSkills` filesystem pipeline because they may contain executable scripts (`scripts/*`).
2. **No migration of repository developer skills (`.claude/skills/*`):** The `.claude/skills/{agentconnect-debug,agentconnect-release,agentconnect-setup,update-model-pricing}` skills in the `agentconnect` source repository are for developers working on AgentConnect itself, not tenant runtime system skills.
3. **No changes to Control Plane `/v1/mcp` (`agentconnect-admin`) in this iteration:** We do not extract a cross-package static skill bundle or expose `readSkill` on the Control Plane HTTP MCP endpoint in this iteration, avoiding duplicate tool names in webchat sessions that attach both the daemon `agentconnect` bridge and `agentconnect-admin`.

### 1.4 Locked architectural decisions

| Decision area                                          | Locked option                                                                     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| :----------------------------------------------------- | :-------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Default exposure scope**                          | **Option A: Capability-scoped exposure across all agents**                        | - `agentconnect-images`: exposed when the current session offers the `shareFile` tool;<br>- `agentconnect-platform`: exposed by default to all ordinary sessions with the `agentconnect` MCP bridge (excluding restricted internal subsessions);<br>- `agentconnect-create-agent` and `agentconnect-create-team`: exposed only when the session attaches `agentconnect-admin` MCP (entitled webchat conversations and their coordinator-delegated page tasks on a runtime with HTTP MCP support).                                                                                                                     |
| **2. Content source and packaging**                    | **Option A: Static build-time packaging**                                         | All four built-in system skills (4 `SKILL.md` files and 12 `references/**/*.md` files, 16 files / ~172 KB total) live under `packages/daemon/builtin-skills/` and are copied into `packages/daemon/dist/builtin-skills/` at build time by `prepare-bundled-skills.mjs`.                                                                                                                                                                                                                                                                                                                                               |
| **3. Preset `agentconnect` `SkillSource` disposition** | **Option A: Stop creation for new orgs + two-phase retirement for existing orgs** | - **Phase 1:** `provisionPresetAgents` stops creating the `agentconnect` `SkillSource` row and `agentconnect/*` binding for new orgs; the daemon recognizes and skips unmodified `agentconnect-md/agentconnect-skill` (`githubRepoId: 1322557433`) entries at the filesystem installer entry point while cleaning up previously installed workspace directories.<br>- **Phase 2:** Once online daemons have upgraded, a Control Plane database migration removes unmodified preset `agentconnect` `SkillSource` rows and `agentconnect/*` bindings while atomically incrementing `configRevision` on affected agents. |
| **4. Control Plane `/v1/mcp` boundary**                | **Option B: Leave `/v1/mcp` untouched in this iteration**                         | Expose `readSkill` exclusively on the daemon's `agentconnect` stdio MCP bridge; `/v1/mcp` exposure for external clients and MCP delivery for Markdown-only `ManagedSkill` bundles are deferred to Future Work (§9).                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 2. Architecture and end-to-end data flow

### 2.1 Architecture across all execution backends (Local Host / SRT / Microsandbox VM / K8s Sandbox Pod)

Because `readSkill` is served by the daemon's built-in `agentconnect` stdio MCP bridge, it reuses every existing cross-sandbox and cross-cluster MCP tunnel with **no new network ports, credential proxies, or shim protocol frames**:

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                 ACP Runtime Process (Claude / Codex / Antigravity / Muse)         │
│                                                                                   │
│  1. Session startup (session/new or session/load):                                │
│     Connects over stdio to `agentconnect` MCP Bridge -> list_tools returns        │
│     dynamic `readSkill` (description and name.enum tailored to session            │
│     capabilities: images / platform / create-*)                                   │
│                                                                                   │
│  2. Progressive on-demand invocation (tools/call):                                │
│     Step A: readSkill({ name: "agentconnect-create-agent" })                      │
│             ──► Returns SKILL.md body + Bundled reference files manifest          │
│     Step B: readSkill({ name: "agentconnect-create-agent",                        │
│                         path: "references/templates/qa.md" })                     │
│             ──► Returns the requested secondary reference document body           │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │ stdio (JSON-RPC)
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                   `agentconnect-daemon mcp-bridge` (bridge.ts)                    │
│                   Carries env: AC_MCP_ENDPOINT, AC_MCP_TOKEN                      │
└───────────┬─────────────────────────────┬─────────────────────────────┬───────────┘
            │                             │                             │
   [Local Host mode]             [Local SRT mode]          [K8s Pod / Microsandbox VM]
   Connects directly to          Connects to SRT shim      Connects to in-container/VM
   daemon UDS / Windows          tunnels.mcp UDS           /run/agentconnect/tunnels/mcp
   Named Pipe                    (shimPaths().tunnels.mcp) ──► Forwarded over Shim WS/vsock
   (mcpSocketPath(root))                                       tunnel to daemon
            │                             │                             │
            └─────────────────────────────┼─────────────────────────────┘
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                         Daemon Main Process (`McpControlServer`)                  │
│                                                                                   │
│  1. Authentication and context lookup (`control-server.ts`):                      │
│     Resolves 18-byte `AC_MCP_TOKEN` in `this.sessions.get(token)`                 │
│     ──► `SessionContext`                                                          │
│                                                                                   │
│  2. Entitlement gate and dispatch (`mcp/ops.ts` -> `executeTool`):                │
│     Verifies `ctx.tools` includes `readSkill`                                     │
│     ──► Dispatches to `mcp/ops/skill-guide.ts`                                    │
│                                                                                   │
│  3. In-memory static skill bundle lookup (`skills/builtin-skills.ts`):            │
│     Validates against the preloaded in-memory Map (`BUILTIN_MCP_SKILLS`):         │
│     - `name` is in the active system skill set allowed for this `ctx`             │
│     - `path` (if provided) exists in the skill's exact `references` allowlist Map │
│     ──► 0 disk I/O, 0 network requests; assembles and returns Markdown response   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 End-to-end turn flow (session setup -> discovery -> primary load -> reference load)

1. **Turn admission and Admin MCP entitlement check (`daemon.ts:23980`)**:
   - When handling an inbound message, the daemon calls `this.adminMcpEntitlement(agentId, key, msg, webchat)` and `this.remoteWebchatGrants.provision(...)` to issue or renew `remoteMcpServer` (`name: 'agentconnect-admin'`).
   - It passes `additionalMcpServers: remoteMcpServer ? [remoteMcpServer] : undefined` into `this.sessions.handle(...)`.
2. **Tool set assembly and dynamic `readSkill` generation (`session-manager.ts:765` -> `daemon.ts:6315` `toolContextFor`)**:
   - `toolContextFor` receives a boolean `hasAdminMcp` flag (true when `additionalMcpServers` contains `agentconnect-admin` and `this.runtimeFacts.mcpCapabilities(agent.runtime).http === true`).
   - `sessionBridgeTools` builds the baseline tool list (including `shareFile` when applicable), which is then filtered by the `coordinator` / `check` / `research` / `gettingToKnow` narrowing gates.
   - For non-restricted sessions, the daemon computes `availableSkills: readonly BuiltinMcpSkillName[]` (2 to 4 skills) from whether `tools` contains `shareFile` and whether `hasAdminMcp` is true, calls `buildReadSkillTool(availableSkills)` to build the tailored `ToolDescriptor`, appends it to `tools`, and records `builtinSkills: availableSkills` on the `SessionContext` registered with `McpControlServer.register({...})`.
3. **Slash-command pre-translation (`session-manager.ts:1080`)**:
   - When a user message starts with `/<skill>` or `!<skill>` (for example, `/agentconnect-create-agent create a code review agent`), `matchSkillInvocation` checks the runtime's `advertisedCommandsFor(agentId)` first and then matches against the session's active `availableSkills`.
   - If it matches an active MCP system skill that is not advertised as a native runtime command, `renderSkillInvocation` rewrites the prompt into an explicit instruction telling the model to call the `readSkill` MCP tool.
4. **Primary and secondary on-demand reads (`mcp/ops/skill-guide.ts`)**:
   - The model calls `readSkill({ name: 'agentconnect-create-agent' })` and receives the MCP header banner, the `SKILL.md` body (with YAML frontmatter stripped), and the list of valid `references/...` paths bundled with that skill.
   - Guided by `SKILL.md`, the model calls `readSkill({ name: 'agentconnect-create-agent', path: 'references/templates/code-reviewer.md' })` to load the secondary reference document.

---

## 3. Static asset layout, build packaging, and upstream synchronization

### 3.1 `packages/daemon/builtin-skills/` directory structure

All four built-in system skills (16 Markdown files totaling ~172 KB) live under `packages/daemon/builtin-skills/`:

```text
packages/daemon/builtin-skills/
├── agentconnect-images/
│   └── SKILL.md
├── agentconnect-platform/
│   ├── SKILL.md
│   └── references/
│       ├── admin-operations.md
│       └── platform-guide.md
├── agentconnect-create-agent/
│   ├── SKILL.md
│   └── references/
│       ├── code-hosts.md
│       ├── elicitation.md
│       ├── integrations.md
│       ├── tools-and-skills.md
│       └── templates/
│           ├── code-reviewer.md
│           ├── coder.md
│           ├── customer-service.md
│           ├── lead.md
│           └── qa.md
└── agentconnect-create-team/
    ├── SKILL.md
    └── references/
        └── teams/
            └── engineering-pod.md
```

### 3.2 Build scripts, npm packaging, and container image verification

Inspection of the repository build and release pipeline confirms:

1. **`packages/daemon/package.json`**:
   - Declares `"files": ["dist"]` and `"build:package": "tsdown && pnpm run build:shim && node scripts/prepare-bundled-skills.mjs && node scripts/prepare-release-image.mjs && node scripts/assert-self-contained.mjs"`.
   - Staging the skill directories into `packages/daemon/dist/builtin-skills/` inside `prepare-bundled-skills.mjs` ensures that both npm tarballs (`pnpm pack` / `npm publish`) and the production daemon Docker image (`docker/Dockerfile` lines 184–189, which runs `pnpm --filter "@agentconnect.md/daemon..." build:package` followed by `pnpm deploy --prod /daemon`) carry `dist/builtin-skills/**`.
2. **`docker/runtime-sandbox.Dockerfile` (sandbox pod and VM image) does not need `builtin-skills`**:
   - The sandbox image copies only `dist/shim/*` (lines 47–52). Because `agentconnect-daemon mcp-bridge` inside a sandbox is a thin JSON-RPC forwarder between stdio and `/run/agentconnect/tunnels/mcp` (`bridge.ts`), `listTools` and `callTool('readSkill')` execute entirely inside the **daemon main process**. The sandbox runtime image never reads `builtin-skills` from disk.
3. **Updating `packages/daemon/scripts/prepare-bundled-skills.mjs`**:
   - Today (lines 46–52), `prepare-bundled-skills.mjs` copies only `SKILL.md` for `builtinSkills = ['agentconnect-images']`, omits `references/**`, and does not clean stale files under `dist/builtin-skills`.
   - Replace lines 46–52 with a recursive copy across all four skill directories, and add a build-time completeness assertion to `packages/daemon/scripts/assert-self-contained.mjs`:

```javascript
// packages/daemon/scripts/prepare-bundled-skills.mjs (replaces lines 46-52)
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
// ...
// Daemon-owned builtin MCP system skills (SKILL.md + references/**/*.md) ship beside the bundle in dist/builtin-skills.
const builtinSkills = [
  'agentconnect-images',
  'agentconnect-platform',
  'agentconnect-create-agent',
  'agentconnect-create-team'
]
const distBuiltinRoot = fileURLToPath(new URL('../dist/builtin-skills', import.meta.url))
rmSync(distBuiltinRoot, { recursive: true, force: true })
for (const name of builtinSkills) {
  const srcDir = fileURLToPath(new URL(`../builtin-skills/${name}`, import.meta.url))
  const destDir = join(distBuiltinRoot, name)
  cpSync(srcDir, destDir, { recursive: true })
}
```

Append the asset verification loop to `packages/daemon/scripts/assert-self-contained.mjs`:

```javascript
// packages/daemon/scripts/assert-self-contained.mjs
for (const skill of [
  'agentconnect-images/SKILL.md',
  'agentconnect-platform/SKILL.md',
  'agentconnect-platform/references/platform-guide.md',
  'agentconnect-platform/references/admin-operations.md',
  'agentconnect-create-agent/SKILL.md',
  'agentconnect-create-agent/references/code-hosts.md',
  'agentconnect-create-agent/references/elicitation.md',
  'agentconnect-create-agent/references/integrations.md',
  'agentconnect-create-agent/references/tools-and-skills.md',
  'agentconnect-create-agent/references/templates/code-reviewer.md',
  'agentconnect-create-agent/references/templates/coder.md',
  'agentconnect-create-agent/references/templates/customer-service.md',
  'agentconnect-create-agent/references/templates/lead.md',
  'agentconnect-create-agent/references/templates/qa.md',
  'agentconnect-create-team/SKILL.md',
  'agentconnect-create-team/references/teams/engineering-pod.md'
]) {
  if (!existsSync(new URL(`../dist/builtin-skills/${skill}`, import.meta.url))) {
    console.error(`✗ daemon bundle is missing builtin system skill asset ${skill}`)
    process.exit(1)
  }
}
```

### 3.3 Single source of truth and synchronization with `agentconnect-md/agentconnect-skill`

**Policy: `packages/daemon/builtin-skills/` in this monorepo is the single source of truth; `agentconnect-md/agentconnect-skill` remains as a read-only mirror for pre-upgrade daemons and standalone external installs.**

Rationale:

1. `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team` document MCP tool names, argument schemas, and elicitation conventions defined in `packages/control-plane/src/http/mcp/tools.ts` and `packages/daemon/src/mcp/tools.ts`. Hosting the skill markdown in the same monorepo allows a single pull request to update an MCP tool schema and its skill instructions atomically, with unit tests verifying reference-link integrity at the commit gate.
2. During the Phase 1 -> Phase 2 transition window, unupgraded daemons still fetch `agentconnect-md/agentconnect-skill@main` over Git, and external users may run `npx skills add agentconnect-md/agentconnect-skill`. Keeping `agentconnect-md/agentconnect-skill` as a one-way mirror updated whenever `packages/daemon/builtin-skills/agentconnect-{platform,create-agent,create-team}` changes preserves backward compatibility.

### 3.4 Adapting `references/*.md` citations inside `SKILL.md`

An audit of every `references/` citation across the four `SKILL.md` files shows:

- `agentconnect-images/SKILL.md`: no secondary reference files.
- `agentconnect-platform/SKILL.md`: lines 44, 95, and 131 link to `[references/platform-guide.md](references/platform-guide.md)` and `[references/admin-operations.md](references/admin-operations.md)`.
- `agentconnect-create-agent/SKILL.md`: lines 26–30, 171, 190, 222, 257, and 266 link to `[references/...](references/...)` for `references/templates/*.md` and `references/{code-hosts,elicitation,integrations,tools-and-skills}.md`.
- `agentconnect-create-team/SKILL.md`:
  - Line 29 links to its own `[references/teams/engineering-pod.md](references/teams/engineering-pod.md)`;
  - **Cross-skill citations (lines 86 and 92)**: cite `` `agentconnect-create-agent/references/code-hosts.md` `` and `` `agentconnect-create-agent/references/elicitation.md` `` directly (and `references/teams/engineering-pod.md` contains similar cross-skill references).

To ensure models **always call `readSkill({ name, path })` and never attempt local filesystem `Read` or `cat` calls**, we apply a three-layer defense:

1. **Layer 1: Server-side response framing (§4.5)**:
   - Every `readSkill` response prepends a high-priority MCP notice header:
     `> [MCP System Skill: <name>] This skill is served in memory via the AgentConnect MCP server (it is NOT on the workspace filesystem). To read any reference file cited below, call the \`readSkill\` tool with \`{"name": "<name>", "path": "references/..."}\` — do not use filesystem Read/cat tools.`
   - When `path` is omitted (reading `SKILL.md`) and the skill has bundled reference files, `readSkill` appends a `## Bundled reference files in <name>` section listing the exact `path` strings accepted by `readSkill`.
2. **Layer 2: Explicit cross-skill instructions in `SKILL.md`**:
   - At lines 86 and 92 of `agentconnect-create-team/SKILL.md` (and in `references/teams/engineering-pod.md`), clarify cross-skill citations inline:
     `` `agentconnect-create-agent/references/code-hosts.md` (load via `readSkill` with `{"name": "agentconnect-create-agent", "path": "references/code-hosts.md"}`) ``.
3. **Layer 3: Automatic cross-skill prefix routing in `readSkill` path normalization (§4.4)**:
   - If a model calls `readSkill` with a skill-prefixed `path` (such as `{ name: "agentconnect-create-team", path: "agentconnect-create-agent/references/code-hosts.md" }` or `{ name: "agentconnect-create-agent", path: "agentconnect-create-agent/references/code-hosts.md" }`), the path normalizer extracts `<targetSkill>/references/...` and routes the lookup to `<targetSkill>`'s reference map whenever `<targetSkill>` is also in the session's authorized `availableSkills` set.

---

## 4. `readSkill` MCP tool contract and dynamic session filtering

### 4.1 In-memory static skill loader (`packages/daemon/src/skills/builtin-skills.ts`)

We extend `packages/daemon/src/skills/builtin-skills.ts` to preload the four built-in system skills into an immutable in-memory map (`BuiltinMcpSkillBundle`) while retaining `BUILTIN_IMAGES_SKILL`, `BUILTIN_SKILL_KEY_PREFIX`, and `reserveBuiltinSkills`:

```typescript
// packages/daemon/src/skills/builtin-skills.ts
import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalSkillSource } from './install-skills.js'

export const BUILTIN_IMAGES_SKILL = 'agentconnect-images'
export const BUILTIN_PLATFORM_SKILL = 'agentconnect-platform'
export const BUILTIN_CREATE_AGENT_SKILL = 'agentconnect-create-agent'
export const BUILTIN_CREATE_TEAM_SKILL = 'agentconnect-create-team'

export const BUILTIN_MCP_SKILL_NAMES = [
  BUILTIN_IMAGES_SKILL,
  BUILTIN_PLATFORM_SKILL,
  BUILTIN_CREATE_AGENT_SKILL,
  BUILTIN_CREATE_TEAM_SKILL
] as const

export type BuiltinMcpSkillName = (typeof BUILTIN_MCP_SKILL_NAMES)[number]

// One-line trigger summaries inlined into readSkill.description (kept concise so total description <= 1,024 chars).
export const BUILTIN_MCP_SKILL_SUMMARIES: Readonly<Record<BuiltinMcpSkillName, string>> = Object.freeze({
  'agentconnect-images':
    'Generate, render, edit, or plot an image/chart/diagram, save it to session outputs, and display it inline with shareFile.',
  'agentconnect-platform':
    'Answer questions about AgentConnect concepts/architecture/setup, or administer the organization (agents, daemons, integrations, teams, memory, automations).',
  'agentconnect-create-agent':
    'Create and configure a new AgentConnect agent from role templates (code-reviewer, lead, coder, customer-service, qa) or custom requirements.',
  'agentconnect-create-team':
    'Create and configure a multi-agent team (such as an engineering-pod) and wire its members, repositories, and task board.'
})

export interface BuiltinMcpSkillBundle {
  readonly name: BuiltinMcpSkillName
  readonly summary: string
  // SKILL.md markdown body with leading YAML frontmatter stripped.
  readonly body: string
  // Keyed by normalized POSIX relative path (e.g. "references/admin-operations.md") in lexicographical order.
  readonly references: ReadonlyMap<string, string>
}
```

- **Frontmatter stripping and recursive loading**:
  - `stripSkillFrontmatter(raw: string): string` strips the leading `---\n...\n---\n` YAML block from `SKILL.md`. Because `name` and `description` are already advertised on the `readSkill` tool descriptor, stripping frontmatter saves 250–500 duplicate tokens on every primary skill read.
  - `loadBuiltinMcpSkills(): Promise<ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>>` asynchronously reads `dist/builtin-skills/<name>/SKILL.md` and recursively scans `references/**/*.md` (admitting only `.md` files under normalized POSIX paths such as `references/templates/qa.md`) on first access, caching the immutable map in memory (~172 KB total). Every subsequent `readSkill` invocation across all sessions is an **O(1) in-memory Map lookup with zero disk I/O**.
- **`builtinSkillSources()` behavior**:
  - To stop feeding `agentconnect-images` into the filesystem installer, `builtinSkillSources()` returns `Promise.resolve([])` (and its callers in `daemon.ts` are removed), while **`reserveBuiltinSkills()` is retained and expanded** to reserve all four `BUILTIN_MCP_SKILL_NAMES` so user-uploaded `ManagedSkill` or Dream bundles cannot shadow built-in system skill names (§6.3).

### 4.2 Session capability gating and race-free ordering (`hasAdminMcp` and `shareFile`)

We verified the exact turn setup ordering across `packages/daemon/src/daemon.ts`, `packages/daemon/src/session/session-manager.ts`, and `packages/daemon/src/session/turn/runtime-session.ts`:

#### 1. Turn execution timeline in current code

On every turn (cold `session/new`, post-restart `session/load`, or in-memory warm turn), the daemon executes in this exact sequence:

```text
daemon.ts:23980  const adminMcp = await this.adminMcpEntitlement(agentId, key, msg, webchat)
daemon.ts:23983  const provisioned = await this.remoteWebchatGrants.provision(...)
daemon.ts:23990  remoteMcpServer = provisioned.server  // { type: 'http', name: 'agentconnect-admin', url, headers }
                 │
                 ▼ (if provisioned.changed is true, line 23997 calls warmHost?.forgetSession to force a reload)
daemon.ts:24010  handled = await this.sessions.handle(agentId, msg, ..., {
                   ...(remoteMcpServer ? { additionalMcpServers: [remoteMcpServer] } : {})
                 })
                 │
                 ▼ Inside SessionManager.handle() (session-manager.ts)
session-manager.ts:765  const toolContext = this.deps.toolContextFor?.({
                          agent, platform, channel, thread, deliveryThread,
                          integrationId, transportScope, isDm, sessionKey: key, threadedTask,
                          // ★ Newly forwarded: whether agentconnect-admin is provisioned for this turn
                          hasAdminMcp: options.additionalMcpServers?.some(
                            (s) => s.name === ADMIN_MCP_SERVER_NAME
                          ) === true
                        })
                 │
                 ▼ Inside openRuntimeSession() (runtime-session.ts:115, 224, 272)
runtime-session.ts:115  Compares previousContext !== input.toolContext.fingerprint
                        (when fingerprint changes, closes the session, runs loadSession/newSession, and re-registers the MCP token)
runtime-session.ts:224  const ordinaryMcpServers = input.toolContext?.mcpServers() ?? []
                        (calls this.mcp.register(ctx), binding the latest ctx.tools to the bridge token)
```

#### 2. Why this ordering is race-free across `session/new`, `session/load`, and warm turns

1. **`provision` strictly precedes `toolContextFor`**: `remoteMcpServer` is provisioned at `daemon.ts:23983` before `this.sessions.handle` is entered (covering both direct user-owned webchat sessions and `webchatCoordinatorTask` page tasks that inherit their parent webchat conversation's entitlement). Consequently, when `session-manager.ts:765` calls `toolContextFor`, whether `options.additionalMcpServers` contains `ADMIN_MCP_SERVER_NAME` is **synchronously known**.
2. **Runtime HTTP MCP capability check**: Inside `toolContextFor` (`daemon.ts:6315`), the daemon gates `hasAdminMcp` on `this.runtimeFacts.mcpCapabilities(agent.runtime).http === true`:
   ```typescript
   const adminMcpActive = hasAdminMcp === true && this.runtimeFacts.mcpCapabilities(agent.runtime).http === true
   ```
   If an agent uses a runtime that does not support HTTP MCP descriptors (such as `muse-acp` or `pi-acp`), `adminMcpActive` is `false` even in webchat, so `agentconnect-create-agent` and `agentconnect-create-team` are not advertised when `agentconnect-admin` cannot be attached.
3. **Automatic refresh on mid-session capability changes (warm sessions and `session/load`)**:
   - The `ToolDescriptor` returned by `buildReadSkillTool(availableSkills)` is part of `tools`.
   - `toolContextFingerprint(tools, configuredServers, instructions)` (`tool-context.ts:24`) hashes every tool's `name`, `description`, and `inputSchema` with SHA-256.
   - Whenever `adminMcpActive` or `shareFile` availability changes for a session, `readSkill`'s `description` and `inputSchema.properties.name.enum` change -> `toolContext.fingerprint` changes -> `openRuntimeSession` (`runtime-session.ts:115`) automatically closes the stale attachment, runs `loadSession` or `newSession` with a freshly registered `McpControlServer` context, and injects a `[Tool definitions updated]` block (`tool-context.ts:57`) for runtimes that cache initial tool definitions.

#### 3. System skill filtering rules by session kind

In `toolContextFor` (`daemon.ts:6331`), after computing the narrowed tool list for `coordinator` / `check` / `research` / `gettingToKnow`, the daemon resolves the session's active built-in skills with a pure function:

```typescript
// packages/daemon/src/mcp/ops/skill-guide.ts
export function resolveSessionBuiltinSkills(input: {
  tools: readonly ToolDescriptor[]
  hasAdminMcp: boolean
  isCoordinator: boolean
  isCheck: boolean
  isResearch: boolean
  isGettingToKnow: boolean
}): BuiltinMcpSkillName[] {
  // Restricted internal subsessions (Auto-mode coordinator, follow-up read-only checks, org research, getting-to-know tasks) never expose user-facing system skills.
  if (input.isCoordinator || input.isCheck || input.isResearch || input.isGettingToKnow) {
    return []
  }
  const skills: BuiltinMcpSkillName[] = []
  // 1. agentconnect-images: exposed only when the session offers shareFile.
  if (input.tools.some((tool) => tool.name === 'shareFile')) {
    skills.push(BUILTIN_IMAGES_SKILL)
  }
  // 2. agentconnect-platform: exposed by default to all ordinary sessions.
  skills.push(BUILTIN_PLATFORM_SKILL)
  // 3. agentconnect-create-agent & agentconnect-create-team: exposed only when agentconnect-admin MCP is active.
  if (input.hasAdminMcp) {
    skills.push(BUILTIN_CREATE_AGENT_SKILL, BUILTIN_CREATE_TEAM_SKILL)
  }
  return skills
}
```

- **`SessionContext` extension (`packages/daemon/src/mcp/ops/context.ts`)**:
  Add an optional field to `SessionContext`:
  ```typescript
  // Built-in MCP system skills active for this session, in display order.
  builtinSkills?: readonly BuiltinMcpSkillName[]
  ```
  When `executeTool` dispatches `readSkill`, it uses `ctx.builtinSkills` as the authoritative per-session allowlist (falling back to the `enum` on the `'readSkill'` `ToolDescriptor` in `ctx.tools` if unset).

### 4.3 `readSkill` schema and exact character budget verification

```typescript
// packages/daemon/src/mcp/ops/skill-guide.ts
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import {
  BUILTIN_MCP_SKILL_NAMES,
  BUILTIN_MCP_SKILL_SUMMARIES,
  type BuiltinMcpSkillName
} from '../../skills/builtin-skills.js'

export const READ_SKILL_TOOL_NAME = 'readSkill'

// OpenAI / Codex single tool description ceiling (send-message-guide.md §1).
export const CODEX_TOOL_DESCRIPTION_LIMIT = 1024
// Threshold above which detailed skill summaries move out of the tool description into StandingContext.
const INLINE_SUMMARY_CHAR_BUDGET = 900

export function buildReadSkillTool(
  availableSkills: readonly BuiltinMcpSkillName[] = BUILTIN_MCP_SKILL_NAMES
): ToolDescriptor {
  const header =
    'Read an AgentConnect system skill (SKILL.md instructions) or one of its bundled reference files on demand. ' +
    'Call this tool BEFORE handling a request that matches an available skill:'
  const bullets = availableSkills.map((name) => `- ${name}: ${BUILTIN_MCP_SKILL_SUMMARIES[name]}`).join('\n')
  const fullDescription = `${header}\n${bullets}`
  const description =
    fullDescription.length <= INLINE_SUMMARY_CHAR_BUDGET
      ? fullDescription
      : 'Read an AgentConnect system skill (SKILL.md instructions) or one of its bundled reference files on demand. ' +
        'Call this tool with the skill name listed under "# Available system skills" in your standing instructions.'

  return {
    name: READ_SKILL_TOOL_NAME,
    description,
    inputSchema: obj(
      {
        name: {
          type: 'string',
          enum: [...availableSkills],
          description: 'System skill name to read.'
        },
        path: {
          type: 'string',
          description:
            'Optional relative path to a bundled reference file inside the skill (for example "references/admin-operations.md"). ' +
            'Omit on the first call to read SKILL.md and list its reference files.'
        }
      },
      ['name']
    )
  }
}
```

#### Character budget breakdown (maximum 4-skill scenario in an entitled webchat session)

| Component                                 | Exact text                                                                                                                                                                                | Characters                                                                                |
| :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `header`                                  | `Read an AgentConnect system skill (SKILL.md instructions) or one of its bundled reference files on demand. Call this tool BEFORE handling a request that matches an available skill:`    | 181                                                                                       |
| `\n- agentconnect-images: ...`            | `\n- agentconnect-images: Generate, render, edit, or plot an image/chart/diagram, save it to session outputs, and display it inline with shareFile.`                                      | 146                                                                                       |
| `\n- agentconnect-platform: ...`          | `\n- agentconnect-platform: Answer questions about AgentConnect concepts/architecture/setup, or administer the organization (agents, daemons, integrations, teams, memory, automations).` | 184                                                                                       |
| `\n- agentconnect-create-agent: ...`      | `\n- agentconnect-create-agent: Create and configure a new AgentConnect agent from role templates (code-reviewer, lead, coder, customer-service, qa) or custom requirements.`             | 172                                                                                       |
| `\n- agentconnect-create-team: ...`       | `\n- agentconnect-create-team: Create and configure a multi-agent team (such as an engineering-pod) and wire its members, repositories, and task board.`                                  | 148                                                                                       |
| **Total (all 4 skills active)**           | **`fullDescription.length`**                                                                                                                                                              | **831 chars** (well below the `900`-char inline threshold and Codex `1,024`-char ceiling) |
| **Total (ordinary IM session, 2 skills)** | `agentconnect-images` + `agentconnect-platform`                                                                                                                                           | **511 chars**                                                                             |

> **Expansion safeguard:** If future built-in or Markdown-only managed skills push `fullDescription.length` past 900 characters, `buildReadSkillTool` automatically falls back to the 182-character short description and `toolContextFor` injects `# Available system skills (load with readSkill)` into the session's standing instructions.

### 4.4 Input validation, path normalization, and traversal protection

In `packages/daemon/src/mcp/ops/skill-guide.ts` and `packages/daemon/src/mcp/ops.ts`:

1. **Zod argument schema (registered in `TOOL_ARG_SCHEMAS`)**:
   ```typescript
   export const READ_SKILL_ARGS = z.strictObject({
     name: requiredEnum('name', BUILTIN_MCP_SKILL_NAMES),
     path: optionalString('path')
   })
   ```
2. **Per-session entitlement check**:
   - Even after `READ_SKILL_ARGS` verifies that `name` is one of the four global `BUILTIN_MCP_SKILL_NAMES`, the handler checks that `name` is present in the session's `allowedSkills` (`ctx.builtinSkills`).
   - If a model in a Slack session calls `readSkill({ name: 'agentconnect-create-agent' })`, the handler throws `ToolArgumentError([`skill "${name}" is not available in this session; available skills: ${allowedSkills.join(', ')}`])`, which `ops.ts:550` formats through `describeToolArgumentFailure`.
3. **Path normalization and strict allowlist lookup (zero filesystem traversal surface)**:
   - **Never join user input onto a filesystem path:** `readSkill` looks up reference content exclusively via `bundle.references.get(normalizedPath)` on the preloaded in-memory `ReadonlyMap<string, string>`. Any input such as `../../etc/passwd` simply misses the map key set and is rejected without touching the filesystem.
   - **Tolerant path normalization (`normalizeSkillReferencePath`)**:
     1. Trim leading/trailing whitespace, convert `\` to `/`, and strip leading `./` or `/`;
     2. If the normalized path is empty or equals `'SKILL.md'` (case-insensitive), treat it as a primary `SKILL.md` read (equivalent to omitting `path`);
     3. If the path starts with `<anyBuiltinSkillName>/` (for example, `path: "agentconnect-create-agent/references/code-hosts.md"` from a cross-skill citation in `agentconnect-create-team`):
        - Extract the leading `targetSkill` and remaining `innerPath`;
        - If `targetSkill` is in the current session's `allowedSkills`, redirect the lookup to `targetSkill` and `innerPath`;
     4. If the caller omitted the `references/` prefix (for example, `path: "platform-guide.md"` or `path: "templates/qa.md"`) and `references/${normalizedPath}` exists in `bundle.references`, resolve it automatically to `references/${normalizedPath}`.

### 4.5 Success and error response shapes

- **Case 1: Reading primary skill instructions (`readSkill({ name: "agentconnect-platform" })`, `path` omitted)**
  Returns a structured object serialized by `bridge.ts` as a JSON text content block:

  ```json
  {
    "skill": "agentconnect-platform",
    "path": "SKILL.md",
    "references": ["references/admin-operations.md", "references/platform-guide.md"],
    "content": "> [MCP System Skill: agentconnect-platform] This skill is served in memory via the AgentConnect MCP server (it is NOT on the workspace filesystem). To read any reference file cited below, call `readSkill` with `{\"name\": \"agentconnect-platform\", \"path\": \"references/...\"}` — do not use filesystem Read/cat tools.\n\n# AgentConnect Platform\n...\n\n---\n## Bundled reference files in `agentconnect-platform`\nLoad any reference file needed for the current step by calling `readSkill` with `{\"name\": \"agentconnect-platform\", \"path\": \"<path>\"}`:\n- `references/admin-operations.md`\n- `references/platform-guide.md`"
  }
  ```

- **Case 2: Reading a secondary reference file (`readSkill({ name: "agentconnect-platform", path: "references/platform-guide.md" })`)**

  ```json
  {
    "skill": "agentconnect-platform",
    "path": "references/platform-guide.md",
    "content": "> [MCP System Skill: agentconnect-platform — references/platform-guide.md] Served via AgentConnect MCP (`readSkill`).\n\n# AgentConnect Platform Guide\n..."
  }
  ```

- **Case 3: Unknown `path` (`readSkill({ name: "agentconnect-platform", path: "references/wrong.md" })`)**
  Throws `ToolArgumentError` (producing a self-correcting error message via `describeToolArgumentFailure`):

  ```text
  readSkill: unknown reference path "references/wrong.md" for skill "agentconnect-platform". Available reference paths: "references/admin-operations.md", "references/platform-guide.md" (or omit `path` to read SKILL.md).
  ```

  If a non-empty `path` is supplied for a skill with no reference files (such as `agentconnect-images`):

  ```text
  readSkill: skill "agentconnect-images" has no bundled reference files; omit `path` to read SKILL.md.
  ```

### 4.6 `ALL_TOOL_NAMES` auto-allow and boundary with `getToolGuide`

1. **`ALL_TOOL_NAMES` auto-allow**:
   - Add `buildReadSkillTool()` to `ALL_TOOL_NAMES` in `packages/daemon/src/mcp/tools.ts:1007` alongside `GET_TOOL_GUIDE_TOOL`.
   - Every ACP runtime (such as Claude Code's `_meta.claudeCode.options.settings.permissions.allow`) automatically includes `mcp__agentconnect__readSkill` at session startup so reading a system skill never prompts the user for tool approval.
   - Register `['readSkill', readSkill]` in `HANDLERS` (`packages/daemon/src/mcp/ops.ts:331`) and `['readSkill', READ_SKILL_ARGS]` in `TOOL_ARG_SCHEMAS` (`packages/daemon/src/mcp/ops.ts:439`).
2. **Division of responsibility with `getToolGuide`**:
   - **`getToolGuide({ tool, action? })`** remains the **per-tool API reference and dynamic session-coordinate example generator** for complex daemon MCP tools (currently `sendMessage`'s five actions and `publishArtifact`, whose output interpolates live `ctx.agentId`, `taskReach`, and connected platforms).
   - **`readSkill({ name, path? })`** is the **on-demand loader for multi-step domain workflows and reference knowledge bases (System Skills: `SKILL.md` + `references/**/*.md`)**. Keeping them separate preserves single responsibility.

---

## 5. Slash-command compatibility, prompt guidance, and discoverability

### 5.1 Extending `/skill` and `!skill` matching and translation

#### 1. Current behavior

In `packages/daemon/src/session/session-manager.ts:1080-1083`:

```typescript
const invocation =
  msg.source === 'user' && this.deps.advertisedCommandsFor
    ? matchSkillInvocation(msg.text, this.deps.advertisedCommandsFor(agentId))
    : null
const triggerText = invocation ? renderSkillInvocation(invocation) : promptText
```

`this.deps.advertisedCommandsFor(agentId)` (`daemon.ts:6256`) returns the `RuntimeCommand[]` list that the runtime advertised via ACP `available_commands_update` after scanning `.claude/skills/` or `.agents/skills/` on disk.
Once the four built-in system skills move to MCP and are no longer written to disk, runtimes will no longer advertise `agentconnect-images`, `agentconnect-platform`, `agentconnect-create-agent`, or `agentconnect-create-team` in `available_commands_update`. Without extending `matchSkillInvocation`, a user typing `/agentconnect-create-agent build a QA agent` or `!agentconnect-platform ...` would get `null`.

#### 2. Updated design (`packages/daemon/src/session/skill-invocation.ts` and `session-manager.ts`)

Extend `SkillInvocation` in `packages/daemon/src/session/skill-invocation.ts` to distinguish `'runtime'` (commands advertised by the ACP harness from disk) from `'mcp'` (system skills served by the daemon's `readSkill` MCP tool):

```typescript
// packages/daemon/src/session/skill-invocation.ts
import { isSkillCommand, type RuntimeCommand } from '@agentconnect.md/protocol'
import type { BuiltinMcpSkillName } from '../skills/builtin-skills.js'

export interface SkillInvocation {
  // The matched skill/command name.
  name: string
  args: string
  // 'runtime' (default): advertised by the ACP harness; 'mcp': served by the daemon's readSkill MCP tool.
  source?: 'runtime' | 'mcp'
}

export function matchSkillInvocation(
  text: string,
  commands: readonly RuntimeCommand[],
  mcpSkills: readonly BuiltinMcpSkillName[] = []
): SkillInvocation | null {
  const trimmed = text.trimStart()
  if (!PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const token = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  if (!token) return null
  const args = space === -1 ? '' : body.slice(space + 1).trim()

  // 1. Runtime-advertised skills first (e.g. user Git/Managed/Dream skills on disk).
  const skills = commands.filter((entry) => entry.skill ?? isSkillCommand(entry))
  const command = skills.find((entry) => {
    const name = entry.name.toLowerCase()
    return name === token || name === `$${token}`
  })
  if (command) {
    return { name: command.name, args, source: 'runtime' }
  }

  // 2. Active daemon MCP system skills for this session (`readSkill`).
  const normalizedToken = token.startsWith('$') ? token.slice(1) : token
  const mcpSkill = mcpSkills.find((name) => name.toLowerCase() === normalizedToken)
  if (mcpSkill) {
    return { name: mcpSkill, args, source: 'mcp' }
  }
  return null
}

export function renderSkillInvocation(invocation: SkillInvocation): string {
  if (invocation.source === 'mcp') {
    const suffix = invocation.args ? `: ${invocation.args}` : '.'
    return `Use the "${invocation.name}" system skill by calling the \`readSkill\` tool with \`{"name":"${invocation.name}"}\`, then follow its instructions to handle this request${suffix}`
  }
  return `Run the command /${invocation.name}${invocation.args ? ` ${invocation.args}` : ''}`
}
```

Expose `builtinSkills?: readonly BuiltinMcpSkillName[]` on `SessionToolContext` in `packages/daemon/src/session/turn/tool-context.ts` so `session-manager.ts:1080` passes `toolContext?.builtinSkills ?? []`:

```typescript
// packages/daemon/src/session/session-manager.ts:1080
const activeMcpSkills = toolContext?.builtinSkills ?? []
const invocation =
  msg.source === 'user' && (this.deps.advertisedCommandsFor || activeMcpSkills.length > 0)
    ? matchSkillInvocation(msg.text, this.deps.advertisedCommandsFor?.(agentId) ?? [], activeMcpSkills)
    : null
```

> **Why `source === 'mcp'` renders a `readSkill` instruction instead of `Run the command /<name>`:**
> As noted in `skill-invocation.ts`, `Run the command /<name>` relies on `/<name>` or `$<name>` existing in the ACP harness's local command registry. Because MCP system skills are not materialized on disk, rewriting the invocation to `Use the "<name>" system skill by calling the readSkill tool with {"name":"<name>"}...` deterministically steers every runtime to invoke `readSkill`.

### 5.2 Preset agent description and `StandingContext` verification

1. **`packages/control-plane/src/persistence/preset-agents.ts`**:
   - `GENERAL_PRESET` (lines 45–56) defines only `name: 'agentconnect'`, `displayName: 'AgentConnect'`, `description: 'A general-purpose development agent for this organization: code review, coding tasks, and everyday questions.'`, and `icon`. It contains **no system prompt hardcoding disk skill paths**, so no changes to `GENERAL_PRESET` copy are required.
2. **`packages/daemon/src/session/turn/standing-context.ts` and `daemon.ts:6365` (`toolContextFor.instructions`)**:
   - At `daemon.ts:6370`, `toolContextFor` assembles `agentToolInstructions(...)` into `instructions` (which enters `buildStandingContext` as `input.taskInstructions`).
   - Because `readSkill`'s `description` (831 characters max) already lists the 2–4 active system skills and their trigger conditions, and models inspect tool descriptions directly during tool selection, **we do not duplicate the four skill summaries in `StandingContext` by default** (saving standing-context tokens on every session).
   - **Only if future skill additions push `buildReadSkillTool` over the 900-character inline threshold** does `daemon.ts:6366` inject an `# Available system skills (load with readSkill)` block into `instructions`.

---

## 6. Filesystem pipeline offloading, deduplication, and legacy workspace cleanup

### 6.1 Stop feeding `builtin:agentconnect-images` into the filesystem installer

Two exact call sites change in `packages/daemon/src/daemon.ts`:

1. **`packages/daemon/src/daemon.ts:9189-9192` (Local Host / SRT / Microsandbox path)**:
   ```typescript
   // Before:
   managedSkills: async (value: Agent) => [
     ...((await this.managedSkillCache?.resolve(value)) ?? []),
     ...(await builtinSkillSources())
   ],
   // After (remove builtinSkillSources()):
   managedSkills: async (value: Agent) => (await this.managedSkillCache?.resolve(value)) ?? [],
   ```
2. **`packages/daemon/src/daemon.ts:9499-9524` (K8s Sandbox Pod / VM `reconcileSandboxSkills` path)**:
   Remove `const builtins = await builtinSkillSources()` and the `withBuiltins` retry wrapper, running a single reconcile over `reserveBuiltinSkills([...managed, ...dreamed], ...)`.

### 6.2 Daemon-side identification and skipping of legacy `agentconnect-md/agentconnect-skill` Git sources

During Phase 1 (before Phase 2's Control Plane database migration runs), existing organizations still carry `agentconnect-md/agentconnect-skill` in `AgentSpec.skills`. The daemon must recognize and filter out unmodified preset entries at the filesystem installer boundary so it no longer queries GitHub or writes them to disk.

#### Exact matching predicate (`isMigratedBuiltinGitSkillSource`)

Add the predicate to `packages/daemon/src/skills/builtin-skills.ts`:

```typescript
// GitHub numeric repository ID of `agentconnect-md/agentconnect-skill` (preset-agents.ts).
export const PRESET_AGENTCONNECT_SKILL_REPO_ID = '1322557433'
export const PRESET_AGENTCONNECT_SKILL_SOURCE_RE =
  /^(?:https?:\/\/github\.com\/)?agentconnect-md\/agentconnect-skill(?:\.git)?\/?$/i

/**
 * True when an AgentSkillEntry points at the official `agentconnect-md/agentconnect-skill`
 * repository on its default ref (`main` or omitted) and selects only skills now served by
 * the daemon's built-in `readSkill` MCP tool.
 *
 * Edge-case guard: if an operator manually repointed the source to a custom fork, a non-main
 * branch/tag/commit ref, a non-`skills` subDir, or selected a custom skill name outside
 * BUILTIN_MCP_SKILL_NAMES, this returns `false` so the custom Git installation is preserved.
 */
export function isMigratedBuiltinGitSkillSource(entry: {
  source: string
  githubRepoId?: string
  ref?: string
  subDir?: string
  skills?: readonly string[]
}): boolean {
  const sameRepo =
    entry.githubRepoId === PRESET_AGENTCONNECT_SKILL_REPO_ID ||
    PRESET_AGENTCONNECT_SKILL_SOURCE_RE.test(entry.source.trim())
  if (!sameRepo) return false

  // If the operator pinned a custom branch, tag, or commit SHA other than 'main', keep their custom Git install.
  const ref = entry.ref?.trim()
  if (ref && ref !== 'main') return false

  // Standard preset subDir is 'skills' (or empty).
  const subDir = entry.subDir?.trim().replace(/^\/+|\/+$/g, '')
  if (subDir && subDir !== 'skills') return false

  // Empty skills[] means unfiltered ('agentconnect/*'); if non-empty, every requested skill must be in BUILTIN_MCP_SKILL_NAMES.
  const builtinSet = new Set<string>(BUILTIN_MCP_SKILL_NAMES)
  if (entry.skills && entry.skills.length > 0 && !entry.skills.every((s) => builtinSet.has(s))) {
    return false
  }
  return true
}
```

- **Filter injection points**:
  1. `packages/daemon/src/skills/install-skills.ts:203` (inside `installSkillsLocked` when iterating `wireGitSources`): if `isMigratedBuiltinGitSkillSource(parsed.data)` is `true`, `continue` immediately (excluding it from `gitSources`, making zero GitHub API calls, and reporting no `sourceFailures`).
  2. `packages/daemon/src/skills/sandbox-skill-reconcile.ts:120` (filtering `input.skills` in `reconcileSandboxSkillSources`) and `packages/daemon/src/daemon.ts:9466` (computing `effectiveGitSkills` in `reconcileSandboxSkills`): filter with `!isMigratedBuiltinGitSkillSource(entry)`.

### 6.3 `reserveBuiltinSkills` name-collision protection

What happens if an organization creates a `ManagedSkill` or Dream skill with the same name as one of the four built-in system skills (for example, `agentconnect-images` or `agentconnect-platform`)?

- Retain and expand `reserveBuiltinSkills(sources, warn)` (`packages/daemon/src/skills/builtin-skills.ts:58`):
  Expand the reserved name set from `new Set(['agentconnect-images'])` to `new Set(BUILTIN_MCP_SKILL_NAMES)` (`'agentconnect-images'`, `'agentconnect-platform'`, `'agentconnect-create-agent'`, and `'agentconnect-create-team'`).
- If `localSkills` (`ManagedSkill` or Dream skills) contains any of the four reserved names, `reserveBuiltinSkills` drops it from disk installation and logs a diagnostic warning:
  `skills: "${source.name}" is reserved for the daemon's builtin skill; the source ${source.key} is not installed`.
- This prevents a local bundle from shadowing a built-in system skill or creating a split brain between disk and MCP.

### 6.4 Safe cleanup of previously installed directories in existing workspaces

**Core question:** Workspaces that ran under an older daemon (local directories, Microsandbox VMs, or persistent Kubernetes Pod volumes) already have `0500`/`0400` read-only `agentconnect-images`, `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team` directories under `.claude/skills/` or `.agents/skills/`. After upgrading the daemon, how are those residual directories removed without deleting a user-authored directory committed to the repository under the same path?

Auditing `packages/daemon/src/skills/skill-install-ledger.ts` and `packages/daemon/src/skills/install-skills.ts` confirms that the existing ledger already performs byte-verified incremental uninstallation; we only need to align the sandbox short-circuit gate with `priorLedger`:

#### 1. Local workspaces (Local Host / SRT): `installSkills` performs a one-time byte-verified uninstall

- On the first workspace preparation after upgrade (`withSkills` -> `installSkills(agent, acpCwd, opts)`):
  - `gitSources` (with `agentconnect-md/agentconnect-skill` filtered out) and `localSources` (without `builtin:agentconnect-images`) produce a new `planFingerprint` that **differs** from `ledger.fingerprint` on disk.
  - Execution bypasses the `unchanged` fast path (`install-skills.ts:307`) and enters `reconcileSkillBundles` (with `candidates: []` when no custom skills are configured, **spawning zero `skills@1.5.21` CLI subprocesses**).
  - Inside `reconcileSkillBundlesLocked` (`skill-install-ledger.ts:516-587`):
    1. It reads `ledger.owned` from the prior ledger (recording the previously installed `.claude/skills/agentconnect-images`, `.claude/skills/agentconnect-platform`, etc., along with every file's `sha256`, `size`, `mode`, and directory `inode/dev` identity);
    2. It calls `installedBundlesIntact(options.cwd, [entry])` to **verify byte-for-byte that each directory on disk is still the unmodified read-only copy installed by the daemon**:
       - If intact: the entry joins `prior`, generates an uninstall journal operation (`action: 'apply'` without a candidate + `finishReadyCleanup`), removes the old read-only directory via `skill-workspace-mutator`, and cleans `.git/info/exclude`;
       - If a user modified the directory in place, or the directory belonged to the user's repository (absent from `ledger.owned`): `installedBundlesIntact` returns `false`, logs `was modified in the workspace; leaving it as is`, and **leaves the user's files untouched**;
    3. Once cleanup finishes, the ledger commits `owned: []` and the new `fingerprint`.
  - **From the second session preparation onward**: `ledger.fingerprint === planFingerprint` holds with `owned: []`, and `installSkills` returns `{ skipped: 'unchanged', owned: [] }` after an in-memory fingerprint comparison with **zero subprocesses and zero filesystem mutations**.

#### 2. K8s Sandbox Pods and Microsandbox VMs: `reconcileSandboxSkills` zero-RPC short-circuit

Auditing `packages/daemon/src/daemon.ts:9466-9525`:

- **Current redundant RPC:** In `reconcileSandboxSkills`, `clusterSkillSupportRequired` only guards whether to throw when `!client` or `!skillsAgentId`. On normal pods where both `client` and `skillsAgentId` exist (such as `claude-acp` or `codex-acp`), even when there are no desired skills (`desiredSources === 0`) and `priorLedger` is empty, execution still calls `reconcileSandboxSkillSet` -> `ClusterSkillCoordinator.reconcile`, performing an empty network `begin -> reconcile` RPC round trip.
- **Short-circuit and legacy volume cleanup**:
  At `daemon.ts:9466`, filter out migrated preset Git sources first and short-circuit when both desired sources and prior ledger roots are empty:
  ```typescript
  const effectiveGitSkills = agent.skills.filter((entry) => !isMigratedBuiltinGitSkillSource(entry))
  const desiredSources = effectiveGitSkills.length + agent.managedSkills.length + dreamed.length
  const priorRootsCount = priorLedger?.roots.length ?? 0

  // ★ Fast path: when there are no custom filesystem skills to install and no prior ledger roots to uninstall, return immediately.
  if (desiredSources === 0 && priorRootsCount === 0) {
    return priorLedger
  }
  ```
  - **Fresh pods / sessions without custom skills**: `desiredSources === 0 && priorRootsCount === 0` is `true`, so `reconcileSandboxSkills` returns immediately (**0 shim RPCs and 0 in-pod `skills` CLI invocations**).
  - **Persistent pod volumes or VMs that previously installed `builtin:agentconnect-images` or `agentconnect-skill`**:
    - On the first preparation after upgrade, `priorLedger.roots` is non-empty (`priorRootsCount > 0`), so it does **not** short-circuit;
    - When `client` and `skillsAgentId` are available, it runs `reconcileSandboxSkillSet` once with `effectiveGitSkills: []`, `managed: []`, and `dreamed: []`, instructing the shim's `ClusterSkillHandler` to uninstall the old built-in roots recorded in `priorLedger.roots` and update `cluster_skill_ledger` to `roots: []`;
    - If the agent switched to a runtime with `skillsAgentId: null` (such as `antigravity-acp`), `supportRequired` already excludes `builtin:` and migrated roots from `priorRoots`, so startup proceeds without error;
    - From the second preparation onward, `priorRootsCount === 0`, entering the zero-RPC fast path permanently.

---

## 7. Control Plane preset `SkillSource` deprecation and Phase 2 database cleanup

### 7.1 Phase 1: Stop creating the preset `agentconnect` `SkillSource` and binding for new organizations

In `packages/control-plane/src/persistence/preset-agents.ts`:

1. **`provisionPresetAgents` (lines 124–172)**:
   - Remove `const skills = await providePresetSkillSource(db, args.orgId)` (and `...(skills.length > 0 ? { skills } : {})` at line 158).
   - When a new organization is created (`POST /orgs`, default no-auth tenant seed, or `PresetAgentBackfill` provisioning the `@agentconnect` preset agent), the Control Plane creates only the `@agentconnect` agent row and `preset_agent` status row. It **no longer inserts `agentconnect-md/agentconnect-skill` into `skill_source` and no longer writes `["agentconnect/*"]` into `@agentconnect`'s `runtimeOverrides.skills`**.
2. **Retain exported constants for migration and test reference**:
   - Keep `PRESET_SKILL_SOURCE` and `PRESET_AGENT_SKILLS` exported (marked `@deprecated Moved to daemon built-in readSkill MCP tool`) for migration verification tests.
3. **Update Control Plane unit and integration tests**:
   - Update `packages/control-plane/src/persistence/preset-agents.test.ts` and `packages/control-plane/test/integration/preset-agents.test.ts` to assert that newly created organizations have `skills: []` on the preset `@agentconnect` agent and no auto-created `name = 'agentconnect'` row in `skill_source`.

### 7.2 Phase 2: Safe database cleanup migration for existing organizations (Prisma Migration SQL)

#### 1. Why Phase 1 and Phase 2 must ship in order (rollout ordering constraint)

- **Rolling-upgrade and self-hosted daemon compatibility**:
  - In self-hosted or hybrid deployments, the Control Plane may upgrade before edge self-hosted daemons.
  - If the Control Plane deleted existing organizations' `agentconnect` `SkillSource` rows in Phase 1 before daemons upgraded, **older self-hosted daemons** (which do not yet have the `readSkill` MCP tool) would receive an updated `AgentSpec.skills` without `agentconnect/*` and uninstall `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team` from disk, leaving them without those skills until the daemon binary was upgraded.
  - By shipping **Phase 1 first (new orgs stop creating the row; upgraded daemons skip the Git source and serve `readSkill` over MCP)** and running **Phase 2's database migration after online daemons have upgraded**, neither new nor old daemons experience a skill gap during the transition.

#### 2. Exact predicate for an "unmodified preset `skill_source` row"

To guarantee that Phase 2's SQL migration only removes default rows originally seeded by the system and never deletes a row that an operator repointed to a custom fork, branch, subdirectory, or private repository, we check all columns of `SkillSource` (`"skill_source"` in `packages/control-plane/prisma/schema.prisma`) following the precedent in `20261008000000_preset_skills_follow_head/migration.sql`. An **unmodified preset `skill_source` row** must satisfy every condition below:

```sql
s."name" = 'agentconnect'
AND s."githubRepoId" = 1322557433
AND s."source" = 'agentconnect-md/agentconnect-skill'
AND COALESCE(s."ref", 'main') = 'main'
AND COALESCE(s."subDir", 'skills') = 'skills'
AND s."private" = false
AND s."credentialProvider" IS NULL
```

#### 3. Idempotent Prisma migration script (`migration.sql`)

Following `20261008000000_preset_skills_follow_head/migration.sql`, the migration obeys three database invariants:

1. **Explicit `BEGIN; ... COMMIT;` transaction wrapper** (Prisma 7 `migrate deploy` does not wrap migration files in a transaction automatically);
2. **Update referencing `"agent"` rows' `runtimeOverrides -> 'skills'` and increment `"configRevision" = "configRevision" + 1` atomically before deleting the `"skill_source"` rows**;
3. **Why `configRevision` must increment:** `AgentSpec.skills` is projected dynamically from `"agent"` and `"skill_source"`. If an agent's resolved `skills` changes without incrementing `configRevision`, connected daemons will reject the spec update due to a spec digest mismatch at the same `configRevision`.

```sql
-- Phase 2: Retire unmodified preset `agentconnect` Git skill sources now served by the
-- daemon's built-in `readSkill` MCP tool.
--
-- Wrapped in an explicit transaction (Prisma 7 migrate deploy does not wrap files automatically)
-- so no connecting daemon can observe removed skills at a pre-bump configRevision.
BEGIN;

-- 1. Capture the orgIds whose `agentconnect` skill_source row is still the unmodified preset
--    and whose agents only reference standard built-in skills under `agentconnect/*`.
WITH unmodified_preset_source AS (
  SELECT s."id", s."orgId", s."name"
  FROM "skill_source" AS s
  WHERE s."name" = 'agentconnect'
    AND s."githubRepoId" = 1322557433
    AND s."source" = 'agentconnect-md/agentconnect-skill'
    AND COALESCE(s."ref", 'main') = 'main'
    AND COALESCE(s."subDir", 'skills') = 'skills'
    AND s."private" = false
    AND s."credentialProvider" IS NULL
    AND (
      s."skills" = '{}'::text[]
      OR s."skills" <@ ARRAY[
        'agentconnect-platform',
        'agentconnect-create-agent',
        'agentconnect-create-team'
      ]::text[]
    )
),
-- 2. Strip `agentconnect` / `agentconnect/*` / `agentconnect/<builtin>` bindings from every
--    agent in those orgs, preserving any other skill sources in their original order, and
--    bump `configRevision` atomically in the same UPDATE so the daemon spec fence advances.
updated_agents AS (
  UPDATE "agent" AS a
  SET
    "runtimeOverrides" = jsonb_set(
      COALESCE(a."runtimeOverrides", '{}'::jsonb),
      '{skills}',
      COALESCE(
        (
          SELECT jsonb_agg(entry ORDER BY ord)
          FROM jsonb_array_elements(a."runtimeOverrides" -> 'skills') WITH ORDINALITY AS t(entry, ord)
          WHERE split_part(entry #>> '{}', '/', 1) <> 'agentconnect'
        ),
        '[]'::jsonb
      ),
      true
    ),
    "configRevision" = a."configRevision" + 1
  FROM unmodified_preset_source AS ups
  WHERE a."orgId" = ups."orgId"
    AND jsonb_typeof(a."runtimeOverrides" -> 'skills') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(a."runtimeOverrides" -> 'skills') AS e
      WHERE split_part(e #>> '{}', '/', 1) = 'agentconnect'
    )
  RETURNING a."orgId"
)
-- 3. Delete the unmodified preset `skill_source` rows now that no agent references them.
DELETE FROM "skill_source" AS s
USING unmodified_preset_source AS ups
WHERE s."id" = ups."id";

COMMIT;
```

- **Idempotency**: Re-running the SQL finds an empty `unmodified_preset_source` CTE, updating `0` agent rows and deleting `0` `skill_source` rows without extra `configRevision` increments.
- **Rollback**: If a rollback is ever needed, re-running `providePresetSkillSource` (or executing the inverse SQL to re-insert `skill_source` and increment `configRevision`) while setting `isMigratedBuiltinGitSkillSource` to `false` restores filesystem installation cleanly.

---

## 8. Observability, test matrix, and three-PR rollout plan

### 8.1 Observability and logging

When `packages/daemon/src/mcp/ops/skill-guide.ts` executes `readSkill`:

1. **Structured debug logging**:
   - On a successful read: `deps.log?.debug?.(\`mcp: readSkill agent=${ctx.agentId} platform=${ctx.platform} skill=${resolvedSkill} path=${resolvedPath}\`)`.
   - On rejected arguments or unauthorized skill names: logged by the existing `tool ${name}: rejected arguments` path in `ops.ts:547`.
2. **ACP tool-call stream (Transcript and Console visibility)**:
   - Because `readSkill` is a standard `agentconnect` MCP bridge tool, every `mcp__agentconnect__readSkill` call is emitted as an ACP `tool_call` / `tool_call_update` event into the session transcript and Webchat Console, making it directly visible which skill and which `references/*.md` file the model loaded.

### 8.2 Verification and test matrix

| Test layer                                                                                | Test files (new or updated)                                                                                                       | Core verification cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| :---------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Built-in skill assets and bundle self-check**                                        | `packages/daemon/test/builtin-skills.test.ts`<br>`packages/daemon/scripts/assert-self-contained.mjs`                              | - Verify all 4 built-in system skills' `SKILL.md` files and all 12 `references/**/*.md` files load from both the source tree and `dist/builtin-skills/`;<br>- Verify every `references/[A-Za-z0-9/_-]+\.md` path cited in any `SKILL.md` exists in that skill's `bundle.references` Map (preventing broken reference links);<br>- Verify `reserveBuiltinSkills` reserves all 4 built-in skill names and emits a warning on collision.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **2. `readSkill` tool contract and Codex 1,024-char budget**                              | `packages/daemon/test/mcp-tool-args.test.ts`<br>`packages/daemon/test/mcp/skill-guide.test.ts` (new)                              | - Verify `READ_SKILL_ARGS` and `buildReadSkillTool()` JSON Schema fields match strictly;<br>- **Hard assertion**: with all 4 skills active, `buildReadSkillTool().description.length <= 1024` (measured at 831 chars);<br>- Verify primary `SKILL.md` reads (omitted `path`, `path: ""`, `path: "SKILL.md"`) return the MCP header banner, frontmatter-stripped body, and reference file manifest;<br>- Verify secondary `references/*.md` reads, cross-skill prefix routing (`path: "agentconnect-create-agent/references/code-hosts.md"`), and omitted `references/` prefix resolution;<br>- Verify path traversal inputs (`../`, `/etc/passwd`), unknown skill names, and skills unauthorized in the current session (e.g. calling `agentconnect-create-agent` from Slack) return self-correcting errors listing available choices;<br>- Verify `'readSkill'` is included in `ALL_TOOL_NAMES`. |
| **3. Dynamic session capability filtering and slash-command translation**                 | `packages/daemon/test/session/skill-invocation.test.ts`<br>`packages/daemon/test/daemon-tool-context.test.ts`                     | - Verify entitled webchat sessions (`hasAdminMcp: true`, `shareFile: true`) expose all 4 skills;<br>- Verify webchat sessions on runtimes without HTTP MCP support (e.g. `muse-acp`) expose only `agentconnect-images` + `agentconnect-platform`;<br>- Verify ordinary Slack/Discord sessions expose `agentconnect-images` + `agentconnect-platform`;<br>- Verify sessions without `shareFile` expose only `agentconnect-platform`;<br>- Verify `coordinator` / `check` / `research` / `gettingToKnow` internal subsessions do not expose `readSkill`;<br>- Verify `/agentconnect-create-agent args` and `!agentconnect-platform args` translate via `matchSkillInvocation` + `renderSkillInvocation` into `readSkill` tool-call instructions, and runtime-advertised disk skills take precedence over same-named MCP skills.                                                                     |
| **4. Filesystem pipeline deduplication, legacy workspace cleanup, and pod short-circuit** | `packages/daemon/test/skills/install-skills.test.ts`<br>`packages/daemon/test/skills/sandbox-skill-reconcile.test.ts`             | - Verify `isMigratedBuiltinGitSkillSource` skips default `agentconnect-md/agentconnect-skill` (`1322557433`) while preserving custom branches/forks/non-builtin skills;<br>- **Legacy workspace upgrade regression test**: install `builtin:agentconnect-images` and `agentconnect-platform` under a prior ledger, run `installSkills` with the new configuration, and assert the old read-only directories are cleanly removed and `owned` becomes `[]`, while user-modified directories are left untouched;<br>- **K8s Pod / VM short-circuit test**: verify `desiredSources === 0 && priorRootsCount === 0` makes `reconcileSandboxSkills` issue 0 `client.begin` / `client.reconcile` calls, while a non-empty `priorLedger.roots` with legacy `builtin:` roots runs one cleanup reconcile and short-circuits on subsequent runs.                                                             |
| **5. Control Plane preset deprecation and Phase 2 migration**                             | `packages/control-plane/src/persistence/preset-agents.test.ts`<br>`packages/control-plane/test/integration/preset-agents.test.ts` | - Verify creating a new organization no longer inserts an `agentconnect` `SkillSource` row and leaves `skills: []` on the preset `@agentconnect` agent;<br>- Verify the Phase 2 SQL migration deletes only unmodified default `agentconnect` `SkillSource` rows, strips `agentconnect/*` bindings, increments `configRevision` on affected agents, and preserves user-modified `agentconnect` sources untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 8.3 Three-PR rollout breakdown

To keep each change focused and satisfy §7.2's rollout ordering constraint, implementation splits into **three independently revertible pull requests**:

#### PR 1: Daemon built-in `readSkill` MCP tool, bundled 4 system skills, and slash-command translation

- **Touched modules**:
  - `packages/daemon/builtin-skills/{agentconnect-platform,agentconnect-create-agent,agentconnect-create-team}/**` (15 new Markdown files alongside existing `agentconnect-images/SKILL.md`)
  - `packages/daemon/scripts/prepare-bundled-skills.mjs` and `packages/daemon/scripts/assert-self-contained.mjs`
  - `packages/daemon/src/skills/builtin-skills.ts` (in-memory loader, `BUILTIN_MCP_SKILL_NAMES`, `isMigratedBuiltinGitSkillSource`)
  - `packages/daemon/src/mcp/ops/skill-guide.ts` (new), `packages/daemon/src/mcp/ops/context.ts`, `packages/daemon/src/mcp/tools.ts` (`ALL_TOOL_NAMES`), `packages/daemon/src/mcp/ops.ts`
  - `packages/daemon/src/session/skill-invocation.ts`, `packages/daemon/src/session/turn/tool-context.ts`, `packages/daemon/src/session/session-manager.ts`, `packages/daemon/src/daemon.ts` (wire `hasAdminMcp` and `buildReadSkillTool` into `toolContextFor`)
- **Prerequisites**: None.
- **Acceptance criteria**: `pnpm build && pnpm typecheck && pnpm test` pass; all ACP runtimes can read the 4 system skills and their `references/*.md` files via `mcp__agentconnect__readSkill` according to session capabilities; `/agentconnect-*` slash commands translate to `readSkill` instructions.
- **Rollback**: Revert PR 1 directly; no persistent state or database schema changes.

#### PR 2: Daemon filesystem skill pipeline offloading/deduplication and Control Plane Phase 1 preset `SkillSource` deprecation

- **Touched modules**:
  - `packages/daemon/src/daemon.ts` (stop passing `builtinSkillSources()` into `managedSkills` and `reconcileSandboxSkills`; add the `desiredSources === 0 && priorRootsCount === 0` zero-RPC pod short-circuit)
  - `packages/daemon/src/skills/install-skills.ts` and `packages/daemon/src/skills/sandbox-skill-reconcile.ts` (filter out `isMigratedBuiltinGitSkillSource`)
  - `packages/control-plane/src/persistence/preset-agents.ts` (`provisionPresetAgents` stops calling `providePresetSkillSource`) and corresponding Control Plane tests
- **Prerequisites**: PR 1 merged (or shipped in the same release train).
- **Acceptance criteria**: New organizations no longer create an `agentconnect` `SkillSource` row; existing organizations no longer query GitHub to download `agentconnect-md/agentconnect-skill` on upgraded daemons; previously installed `agentconnect-images` and `agentconnect-*` workspace directories are uninstalled automatically by the ledger on first preparation; K8s Sandbox Pods without custom skills skip `ClusterSkillCoordinator`.
- **Rollback**: Revert PR 2; daemons resume `builtinSkillSources()` and Git skill materialization.

#### PR 3: Control Plane Phase 2 database migration retiring unmodified preset `agentconnect` `SkillSource` rows

- **Touched modules**:
  - `packages/control-plane/prisma/migrations/<timestamp>_retire_preset_agentconnect_skill_source/migration.sql`
  - `packages/control-plane/test/integration/preset-agents.test.ts` (migration integration tests)
- **Prerequisites**: Daemons containing PR 1 and PR 2 have rolled out across the managed pool and self-hosted environments.
- **Acceptance criteria**: Unmodified `agentconnect` `SkillSource` rows and `agentconnect/*` agent bindings in existing organizations are idempotently removed, affected agents' `configRevision` values increment atomically, and connected daemons converge on the updated specs.
- **Rollback**: Run the inverse compensation script calling `providePresetSkillSource` and incrementing `configRevision`.

---

## 9. Future work

1. **Exposing `readSkill` to external AI clients connected directly to Control Plane `/v1/mcp` (without duplicate tool names in internal webchat)**:
   - When external MCP clients (such as Claude Desktop or Cursor authenticating directly to `https://<cp>/v1/mcp` via OAuth 2.1 or personal API keys) also need `readSkill` to load `agentconnect-platform`, `agentconnect-create-agent`, and `agentconnect-create-team`:
   - Extract `builtin-skills` into an internal workspace asset package and gate `readSkill` visibility in the Control Plane's `/v1/mcp` handler (`packages/control-plane/src/http/mcp/routes.ts`) by **authentication credential type**: advertise `readSkill` in `/v1/mcp` `tools/list` when the caller authenticates with an external OAuth token or personal API key (`ac_live_...`), and omit `readSkill` from `/v1/mcp` when the caller authenticates with a daemon webchat delegation grant (`acmcp_...`, whose session already receives `readSkill` from the daemon's `agentconnect` stdio bridge). This prevents two MCP servers in the same webchat session from advertising duplicate tool names.
2. **On-demand MCP delivery for Markdown-only `ManagedSkill` and accepted Dream skill bundles**:
   - When an organization uploads a `ManagedSkill` ZIP bundle in the Console or accepts a Dream skill, `parseManagedSkillBundle` can inspect whether the bundle contains only Markdown documentation (`SKILL.md` + `references/**/*.md`, with no `scripts/` or executable files).
   - Pure-documentation bundles can be merged into the daemon's dynamic `readSkill` MCP tool enum (automatically switching to the `StandingContext` `# Available system skills` index when the active skill summaries exceed the 900-character inline description budget), giving custom knowledge skills universal runtime compatibility (including `antigravity-acp`) and zero workspace disk footprint.
