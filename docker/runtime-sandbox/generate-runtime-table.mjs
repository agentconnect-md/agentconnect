#!/usr/bin/env node
// Generates the declared runtime table by ASKING each runtime, inside the image it ships in.
//
//   generate-runtime-table.mjs <output path>   # write the table (build time)
//   generate-runtime-table.mjs -               # print it (consistency check)
//
// Derived, never hand-written, and derived from `initialize` rather than from a manifest or a
// `--version` string. The table is what the daemon reports in `--cloud` mode instead of probing a
// host, so what matters is that it says what the runtime will say when a session starts. A
// manifest version only agrees with npm; `agentInfo.version` at initialize is the runtime's own
// claim, and the capabilities beside it are the part a caller behaves differently on.
//
// Run twice: at build time to produce the artifact, and in CI against the built image to compare.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Runtime ids this image provides and the executable (plus args) each is launched as. */
const PROVIDED = [
  { id: 'claude-acp', bin: 'claude-agent-acp' },
  { id: 'codex-acp', bin: 'codex-acp' },
  // The curated catalog launches this one through npx; here it is the image's own executable,
  // which is what makes it admissible at all under --k8s (runtimes/k8s-runtimes.ts).
  { id: 'dsh-acp', bin: 'dsh-acp' }
]

const PROBE_TIMEOUT_MS = 60_000

/** ACP reserves JSON-RPC -32000 for "authentication required" — the same code the daemon's own
 *  prober keys on. Matching the rendered MESSAGE instead is what an earlier version did, and a
 *  message merely containing "auth" ("failed to initialize auth database") would have been
 *  accepted as an unauthenticated runtime rather than a broken one. */
export const ACP_AUTH_REQUIRED_CODE = -32000

/** A JSON-RPC error the probe should treat as "this runtime is unauthenticated, not broken". */
export function isAuthRequired(error) {
  return error?.acpCode === ACP_AUTH_REQUIRED_CODE
}
const PROBE_CWD = process.env.AC_PROBE_CWD ?? process.cwd()

/** Drive one runtime over stdio far enough to learn what it is: initialize, then a session. */
async function probe(bin, args = []) {
  // Ambient HOME and cwd, NOT a pinned /agent: a runtime writes state into both, so whoever runs
  // this decides where that lands. Pinning the workspace meant the build-time probe left
  // root-owned .claude/.codex state in /agent that the runtime user could not then write.
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env, cwd: PROBE_CWD })
  const replies = new Map()
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (typeof message.id === 'number') replies.set(message.id, message)
      } catch {
        /* a notification, which this probe does not need */
      }
    }
  })

  const call = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    for (;;) {
      const reply = replies.get(id)
      if (reply?.error) {
        // The CODE travels with the error, so classification never depends on rendered text.
        const failure = new Error(`${bin} ${method} failed: ${JSON.stringify(reply.error).slice(0, 200)}`)
        failure.acpCode = reply.error.code
        throw failure
      }
      if (reply) return reply.result
      if (Date.now() > deadline) throw new Error(`${bin} did not answer ${method} within ${PROBE_TIMEOUT_MS}ms`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  try {
    const initialized = await call(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    })
    // A session too, because `modes` exists only once there is one. Best-effort on purpose: this
    // image carries no provider credentials, and codex-acp answers `session/new` with
    // "Authentication required" while claude-agent-acp does not. That is a runtime that is
    // unauthenticated, not one that is broken, so it must not fail the build — and the table says
    // which it was rather than leaving an unexplained gap.
    const session = await call(2, 'session/new', { cwd: PROBE_CWD, mcpServers: [] }).then(
      (result) => ({ result, outcome: 'ok' }),
      (err) => {
        // ONLY the ACP auth-required code is acceptable. Any other failure is a runtime that cannot
        // open a session in this image, and swallowing it would let a broken runtime be published
        // and verified — the smoke test exercises Claude, so nothing else would notice.
        if (!isAuthRequired(err)) throw err
        return { result: undefined, outcome: 'auth-required' }
      }
    )
    return { initialized, session: session.result, sessionProbe: session.outcome }
  } finally {
    child.kill('SIGTERM')
  }
}

/** Deeply key-sorted, so two builds of identical inputs produce identical bytes. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    )
  }
  return value
}

export async function buildTable() {
  const runtimes = []
  for (const entry of PROVIDED) {
    const { initialized, session, sessionProbe } = await probe(entry.bin, entry.args ?? [])
    const version = initialized?.agentInfo?.version
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`${entry.bin} reported no agentInfo.version at initialize`)
    }
    runtimes.push({
      id: entry.id,
      version,
      // The executable, published rather than merely used: the daemon cannot see this filesystem,
      // and without it operators had to restate the mapping in daemon config — a claim about an
      // image made somewhere the image is not.
      command: entry.bin,
      args: [...(entry.args ?? [])],
      // The ACP snapshot: what the daemon can state about this runtime without probing it, and
      // what CI compares a fresh probe against.
      acp: stable({
        protocolVersion: initialized.protocolVersion ?? null,
        agentName: initialized.agentInfo?.name ?? null,
        authMethods: (initialized.authMethods ?? []).map((method) => method?.id ?? method?.name ?? String(method)),
        capabilities: initialized.agentCapabilities ?? {},
        modes: (session?.modes?.availableModes ?? []).map((mode) => mode.id).sort(),
        // The model/permission/effort surface the console renders. Ids, categories and option
        // values only — the prose descriptions would make the table churn on every wording change.
        configOptions: (session?.configOptions ?? []).map((option) => ({
          id: option.id,
          category: option.category ?? null,
          type: option.type ?? null,
          values: (option.options ?? []).map((choice) => choice.value).sort()
        })),
        // Why a mode list may be empty, so an absent one is a recorded fact rather than a gap.
        sessionProbe
      })
      // No `models` key: a model list needs provider credentials, and this image deliberately
      // carries none. Publishing a guessed one would put a claim in the daemon's mouth that no
      // probe supports; the model snapshot belongs wherever those credentials live.
    })
  }
  runtimes.sort((a, b) => a.id.localeCompare(b.id))
  return { runtimes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2]
  if (!target) throw new Error('usage: generate-runtime-table.mjs <output path>|-')
  const table = await buildTable()
  const rendered = `${JSON.stringify(table, null, 2)}\n`
  if (target === '-') {
    process.stdout.write(rendered)
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, rendered)
    // stderr, so `-` stays machine-readable on stdout.
    process.stderr.write(`runtime table written to ${target}\n`)
  }
}
