# AgentConnect add-on evaluations

This suite measures AgentConnect's incremental memory behavior — and functionally checks its collaboration delivery — while holding the underlying ACP harness fixed. It is not a model or harness leaderboard. Every full-daemon cell runs the exact production tool surface and messaging mechanism: collaboration has no evaluation-only off switch, so it is not a treatment axis.

## What runs

There are two layers:

- `pnpm eval:contracts` runs deterministic, credential-free Vitest contracts for the event schema, observer non-interference, permission decisions, daemon composition, redaction, ATIF, and disposable runners.
- `pnpm eval:addons` runs the configured real ACP subject through Promptfoo. It requires an explicit disposable subject template and model/runtime credentials.

Promptfoo evaluates three treatment cells. Both full-daemon cells carry the production collaboration surface:

| Label         | Execution path | Memory     |
| ------------- | -------------- | ---------- |
| `raw-acp`     | Raw `AcpHost`  | off        |
| `daemon-core` | Full daemon    | off        |
| `memory-only` | Full daemon    | configured |

The generated paired summary reports, per case and without combining different harnesses:

```text
core   = daemon-core - raw-acp
memory = memory-only - daemon-core
```

The collaboration case is a functional check of specialist delivery and reply on the production surface (it runs in `daemon-core`); it has no paired off-cell because the product ships no collaboration-off composition.

Controls may legitimately score zero, so the outcome assertion records `0` or `1` without turning an expected-low control into a process failure. Provider, infrastructure, and artifact errors still fail the Promptfoo run and retain their terminal status.

## Configure a subject

Point the suite at a template root that is safe to copy and execute:

```text
subject/
  config.json                    # explicit runtime definitions
  agents/
    <root-agent-id>/
      agent.json
      .env                       # optional; treated as sensitive
      memory/                    # optional seed for managed memory
    <specialist-agent-id>/
      agent.json
      .env                       # optional; treated as sensitive
      memory/                    # optional seed for managed memory
```

The runner copies only `config.json`, the case-selected agents, their optional `.env`, and—when memory is enabled—their `memory/` directory into a private temporary root. Symbolic links in those copied inputs are rejected. It disables the Control Plane, relays, integrations, crons, configured MCP servers, and repository workspaces. Every trial gets a fresh scratch workspace, and the temporary root is removed even after a partial daemon start, runtime failure, or artifact failure.

Requirements:

1. `config.json` must contain an explicit runtime definition for every selected agent. Both execution paths refuse implicit/auto-discovered runtimes so the harness is reproducible, and both controls fail closed when that runtime has no verified native-memory off policy.
2. Both agents should use the same pinned runtime/model/settings. For the managed-memory cases, configure `"memory": { "provider": "managed", "autoDistill": false }`. The v1 cases explicitly call AgentConnect's `writeMemory` tool so they work on runtimes such as Codex that correctly reject automatic distillation without a trusted ACP system-prompt channel. Evaluate auto-distillation separately only on runtimes that support that trusted channel.
3. The specialist's own `description` should contain `The private validation token is SPECIALIST-OK-7319.` for the collaboration case. Do not put that token in the root agent's prompt or description.
4. Use a runtime permission mode that exposes AgentConnect's write-capable MCP tools (for example, Codex `agent`) and enable the daemon's filesystem sandbox. The cases explicitly forbid workspace/runtime persistence, provide a no-tool control response, and make the recall turn use only the injected AgentConnect memory block.
5. Use a throwaway template. Although the runner operates on a copy, its runtime credentials can call external providers and its prompts are intentionally adversarial to feature boundaries.

The behavioral runner currently supports daemon-local managed/native memory. An external-memory connection depends on the live CP registry and secret leases, which this isolated CP-off runner intentionally does not copy; evaluate such a plugin in a separately prepared disposable environment until an explicit connection-fixture adapter exists.

## Run

```bash
export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject
export AGENTCONNECT_EVAL_ROOT_AGENT=root-agent-id
export AGENTCONNECT_EVAL_SPECIALIST_AGENT=specialist-agent-id

# Optional overrides
export AGENTCONNECT_EVAL_ARTIFACT_ROOT=/restricted/path/agentconnect-evals
export AGENTCONNECT_EVAL_COMMIT=$(git rev-parse HEAD) # optional; auto-detected in a checkout
export AGENTCONNECT_EVAL_OTEL=false
export AGENTCONNECT_EVAL_DIRTY=false
export PROMPTFOO_DISABLE_TELEMETRY=1

pnpm eval:validate
pnpm eval:addons
pnpm eval:addons:view
```

`eval:validate` only validates the checked-in adapter/config and needs no subject or provider credential. `eval:addons` first builds the daemon bundle from the exact checkout so embedded evaluation sessions can spawn its real `mcp-bridge`, then runs sequentially with Promptfoo's response cache, sharing, and telemetry disabled. It launches Promptfoo under a private file-creation mask so its JSON/JUnit reports are not world-readable.

The exact-instruction control keeps the runner's 120-second default. The two-turn memory and collaboration cases allow five minutes, and the multi-agent interaction case allows ten minutes; those budgets include nested agent turns and any clean shutdown work.

To export evaluation spans, set `AGENTCONNECT_EVAL_OTEL=true` and configure a standard traces exporter, for example `OTEL_TRACES_EXPORTER=otlp` plus `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. The evaluation flag alone is deliberately insufficient: a run fails as an infrastructure error when no recording exporter is configured, instead of silently producing non-recording spans.

## Evidence and privacy

Each trial writes a mode-0600 `run.json`, `events.jsonl`, and ATIF v1.7 `trajectory.json` below:

```text
<artifact-root>/runs/<case>/<treatment>/<run-id>/
```

The Promptfoo JSON/JUnit reports are written under `<repo>/.artifacts/evaluation/promptfoo/`. The `afterAll` extension also writes a content-free `paired-summary.json` grouped by Promptfoo evaluation ID. Every trial records its AgentConnect commit, treatment, subject runtime/model, the ACP adapter's self-reported version and negotiated protocol version when available, status, latency, turn/tool counts, and evidence paths.

Token fields follow ATIF semantics: prompt tokens include uncached input, cache reads, and cache writes; cached tokens are the cache-hit subset (reads only), not an additional bucket. ACP `totalTokens` remains authoritative when the runtime reports it, and the Promptfoo fallback total is prompt plus completion without double-counting cached tokens.

The local JSONL/ATIF evidence can contain prompts, model output, tool arguments/results, and recalled memory. Credential-shaped strings, configured secrets, template config secrets, and `.env` values are redacted before writing, but this is not a general PII scrubber. Keep the artifact root restricted, use short retention, and never publish raw evidence by default. OTel export is opt-in and emits metadata-only spans; it does not attach prompt, reasoning, memory, or tool content.

Promptfoo is pinned in the workspace. ATIF is pinned to v1.7 in the writer, AgentConnect event/run/summary schemas are versioned, and the OTel semantic-conventions package version is pinned in the lockfile.
