#!/usr/bin/env node
/**
 * Asserts the runtime-sandbox image holds the properties it is built for.
 *
 *   node scripts/verify-runtime-image.mjs <image>
 *
 * Every check runs against the BUILT image rather than the Dockerfile. A Dockerfile review tells
 * you what someone intended; a base image bump, a package that ships a setuid helper, or a
 * `chmod` that lands one layer too early all pass review and fail here.
 *
 * The runtime-table check is the one the acceptance criterion names: the published table must
 * match what the runtimes actually report. It compares the table shipped in the image against
 * the versions the installed CLIs print — so a table that is merely internally consistent with
 * its own manifests, but wrong about what runs, still fails.
 */
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

import { diffRuntimeTables } from './runtime-table-diff.mjs'

const image = process.argv[2]
if (!image) {
  process.stderr.write('usage: verify-runtime-image.mjs <image>\n')
  process.exit(2)
}

const failures = []
const notes = []
const warnings = []
const nodeBuiltins = new Set(builtinModules.flatMap((spec) => [spec, `node:${spec}`]))

function check(name, fn) {
  try {
    const detail = fn()
    notes.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    failures.push(`  ✗ ${name}: ${err.message}`)
  }
}

/** Run a shell command inside the image as its default user. */
function inImage(script) {
  return execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }).trim()
}

function inspect(format) {
  return execFileSync('docker', ['inspect', '--format', format, image], { encoding: 'utf8' }).trim()
}

const SHIM_PATH = '/opt/agentconnect/shim/index.js'
/** Must match SANDBOX_GIT_CREDENTIAL_HELPER in packages/daemon/src/shim/sandbox-paths.ts: the
 *  daemon writes this path into git config, so a rename here is a silent auth failure there. */
const CREDENTIAL_HELPER_PATH = '/opt/agentconnect/bin/git-credential'
/** Must match SANDBOX_GH_WRAPPER_DIR in packages/daemon/src/shim/sandbox-paths.ts: the shim prepends exactly
 *  this directory to the runtime's PATH, so a rename here silently drops every per-repo gh token. */
const GH_WRAPPER_PATH = '/opt/agentconnect/pathbin/gh'
/** Must match SANDBOX_MCP_BRIDGE_ENTRY in packages/daemon/src/shim/sandbox-paths.ts: the shim reports this
 *  path to the daemon, which copies it into the `mcpServers` spec — so a bundle missing here is a runtime
 *  retrying a module that is not there, which is how an agent silently lost its AgentConnect tools. */
const MCP_BRIDGE_PATH = '/opt/agentconnect/shim/mcp-bridge.js'
const SKILLS_CLI_PATH = '/opt/agentconnect/shim/skills/dist/cli.js'
const SKILL_MUTATION_PATH = '/opt/agentconnect/shim/skills/workspace-mutation.js'
const TABLE_PATH = '/opt/agentconnect/runtime/k8s-runtimes.json'

// The runtime is the untrusted party in this image, so root would hand it the whole filesystem.
check('runs as a non-root user', () => {
  const uid = inImage('id -u')
  if (uid === '0') throw new Error('image runs as root')
  const configured = inspect('{{.Config.User}}')
  if (!configured) throw new Error('no USER is set, so the runtime would inherit root')
  return `uid ${uid} (USER ${configured})`
})

// PID 1 has to reap the runtime's children and forward SIGTERM; without that a drain can only
// ever end in SIGKILL, and every drain looks like a crash.
check('tini is PID 1 and forwards signals', () => {
  const entrypoint = inspect('{{json .Config.Entrypoint}}')
  if (!entrypoint.includes('tini')) throw new Error(`entrypoint is not tini: ${entrypoint}`)
  const present = inImage('test -x /usr/bin/tini && echo yes || echo no')
  if (present !== 'yes') throw new Error('tini is referenced but not executable in the image')
  return entrypoint
})

// A shim the runtime can rewrite is a shim it can replace with one that answers the daemon
// however it likes — the channel's whole authorization model assumes this file is ours.
check('the shim is root-owned and not writable by the runtime user', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${SHIM_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`shim is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) throw new Error(`shim is group/other writable (${mode})`)
  const refused = inImage(`(echo x >> ${SHIM_PATH} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error('the runtime user can modify the shim')
  return owner
})

check('the pinned skills CLI is present, immutable and executable', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${SKILLS_CLI_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`skills CLI is not root-owned (${owner})`)
  const version = inImage(`node ${SKILLS_CLI_PATH} --version`)
  if (version !== '1.5.21') throw new Error(`skills CLI version is ${version}`)
  return `${owner}, version ${version}`
})

check('the skill workspace mutation helper is present and immutable', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${SKILL_MUTATION_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`skill mutation helper is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) {
    throw new Error(`skill mutation helper is group/other writable (${mode})`)
  }
  const refused = inImage(`(echo x >> ${SKILL_MUTATION_PATH} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error('the runtime user can modify the skill mutation helper')
  return owner
})

// Git spawns a credential helper per invocation, so the pod needs one as an executable — and it
// inherits the shim's threat model exactly: one the runtime can rewrite is one it can replace with
// a helper that asks the daemon for credentials in its name.
check('the git credential helper is present, executable and root-owned', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${CREDENTIAL_HELPER_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`credential helper is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) {
    throw new Error(`credential helper is group/other writable (${mode})`)
  }
  const refused = inImage(`(echo x >> ${CREDENTIAL_HELPER_PATH} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error('the runtime user can modify the credential helper')
  if (inImage(`test -x ${CREDENTIAL_HELPER_PATH} && echo yes || echo no`) !== 'yes') {
    throw new Error('credential helper is not executable, so git cannot run it')
  }
  return owner
})

// gh reads a static GH_TOKEN fixed at spawn, so a pod agent gets per-repo tokens only through this wrapper —
// and one the runtime can rewrite is one it can replace with a wrapper that asks the daemon in its name.
check('the gh wrapper is present, executable and root-owned', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${GH_WRAPPER_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`gh wrapper is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) throw new Error(`gh wrapper is group/other writable (${mode})`)
  const refused = inImage(`(echo x >> ${GH_WRAPPER_PATH} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error('the runtime user can modify the gh wrapper')
  if (inImage(`test -x ${GH_WRAPPER_PATH} && echo yes || echo no`) !== 'yes') {
    throw new Error('gh wrapper is not executable, so the runtime would resolve the real gh instead')
  }
  return owner
})

// The wrapper is only useful if it finds the real gh PAST itself: prepending its dir must not shadow the binary
// it execs, and an agent with no AgentConnect identity must still get an ordinary, unauthenticated gh.
check('the gh wrapper defers to the real gh when no agent identity is present', () => {
  const dir = GH_WRAPPER_PATH.replace(/\/gh$/, '')
  const out = inImage(`PATH=${dir}:$PATH gh --version 2>&1 | head -1`)
  if (!/^gh version /.test(out)) throw new Error(`the wrapper did not reach the real gh: ${out}`)
  return out
})

// A helper that cannot reach a socket must SAY so and fail, because the alternative is git
// interpreting an empty answer as "no credentials configured" and reporting a puzzling 403.
check('the credential helper runs and fails loudly with no daemon socket', () => {
  const out = inImage(
    `AC_GITCRED_SOCKET=/nonexistent/gitcred.sock ` +
      `sh -c 'echo "protocol=https\nhost=github.com" | ${CREDENTIAL_HELPER_PATH} agent-x get; echo "exit=$?"' 2>&1`
  )
  if (!out.includes('exit=1')) throw new Error(`helper did not exit 1 without a socket: ${out}`)
  if (!/agentconnect: no git credentials/.test(out)) throw new Error(`helper printed no actionable reason: ${out}`)
  if (/password=/.test(out)) throw new Error('helper answered git despite having no credential')
  return 'exits 1 with an actionable message'
})

// The agent's harness spawns this per session from a spec the daemon builds around THIS path, and
// it inherits the shim's threat model: one the runtime can rewrite is one it can replace with a
// tool server that answers the daemon's tool calls however it likes.
check('the MCP bridge is present and root-owned', () => {
  const owner = inImage(`stat -c '%U:%G %a' ${MCP_BRIDGE_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`mcp bridge is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) throw new Error(`mcp bridge is group/other writable (${mode})`)
  const refused = inImage(`(echo x >> ${MCP_BRIDGE_PATH} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error('the runtime user can modify the mcp bridge')
  return owner
})

// It has to LOAD before it can fail: a bundle that reads a file the image does not ship dies on
// import, and to the harness that is indistinguishable from a missing module — the failure this
// whole path exists to remove. Reaching "could not reach daemon" proves the module ran.
check('the MCP bridge starts and fails loudly with no daemon socket', () => {
  const out = inImage(
    `AC_MCP_ENDPOINT=/nonexistent/mcp.sock AC_MCP_TOKEN=probe ` +
      `sh -c 'node ${MCP_BRIDGE_PATH} </dev/null; echo "exit=$?"' 2>&1`
  )
  if (!/mcp-bridge: could not reach daemon/.test(out)) throw new Error(`bridge did not run to its own error: ${out}`)
  if (!out.includes('exit=1')) throw new Error(`bridge did not exit 1 without a socket: ${out}`)
  return 'exits 1 with an actionable message'
})

// The bundles are built with everything inlined, so only Node builtins may remain as imports.
check('the shim bundles are self-contained', () => {
  // Same specifier shapes the daemon package's own assert-self-contained step looks for, run
  // against the artifacts that actually shipped. The local build being clean says nothing about
  // the image: an earlier version of this Dockerfile ran tsdown without building the workspace
  // deps, and produced a bundle that imported them externally — which the image cannot resolve.
  const external = []
  for (const path of [SHIM_PATH, MCP_BRIDGE_PATH, SKILL_MUTATION_PATH]) {
    const bundle = inImage(`cat ${path}`)
    const specs = [...bundle.matchAll(/\bfrom\s*"([^"]+)"/g), ...bundle.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1]
    )
    const leaked = [...new Set(specs.filter((spec) => !nodeBuiltins.has(spec)))].sort()
    if (leaked.length > 0) external.push(`${path}: ${leaked.join(', ')}`)
  }
  if (external.length > 0) throw new Error(`bundles reference non-builtin modules — ${external.join('; ')}`)
  return 'Node builtins only'
})

// The pod template owns identity projection. An image carrying its own token would be an
// identity nobody granted, surviving every change to that template.
check('carries no service-account token of its own', () => {
  const found = inImage(
    'ls /var/run/secrets/kubernetes.io/serviceaccount/token /var/run/ac-identity/token 2>/dev/null | tr "\\n" " "'
  )
  if (found) throw new Error(`image ships a token at: ${found}`)
  return 'none'
})

// Re-probed in the built image rather than checked against its own source: that proves only that the generator ran.
// Compared on what the image pins, not byte for byte: an option's value roster comes from upstream and drifts alone.
check('the published runtime table matches a fresh ACP probe of this image', () => {
  const published = inImage(`cat ${TABLE_PATH}`)
  const fresh = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'node', image, '/opt/agentconnect/bin/generate-runtime-table.mjs', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  ).trim()
  const table = JSON.parse(published)
  if (!Array.isArray(table.runtimes) || table.runtimes.length === 0) {
    throw new Error('the table declares no runtimes, so the daemon would advertise none')
  }
  for (const entry of table.runtimes) {
    if (typeof entry.acp?.protocolVersion !== 'number') {
      throw new Error(`${entry.id} has no ACP protocol version, so the snapshot is not from initialize`)
    }
    if (!entry.acp.capabilities || Object.keys(entry.acp.capabilities).length === 0) {
      throw new Error(`${entry.id} publishes no ACP capabilities`)
    }
  }
  const { failures: drift, warnings: rosters } = diffRuntimeTables(table, JSON.parse(fresh))
  // Reported, never fatal: the image cannot pin these, and failing on them fails a build that changed nothing.
  for (const roster of rosters) warnings.push(`  ! ${roster}`)
  if (drift.length > 0) {
    // Field by field, because the previous id@version list printed two identical strings for the drift it caught.
    throw new Error(`the shipped table differs from a fresh probe — ${drift.join('; ')}`)
  }
  return table.runtimes.map((entry) => `${entry.id}@${entry.version} acp/${entry.acp.protocolVersion}`).join(' ')
})

// The workspace surface runs git INSIDE the sandbox over the shim's exec channel, so a missing
// git is not a degraded feature — it is every workspace operation failing at the far end.
check('provides the executables the shim must resolve', () => {
  const required = ['git', 'gh', 'node', 'claude-agent-acp', 'codex-acp', 'dsh-acp']
  const missing = required.filter((bin) => inImage(`command -v ${bin} >/dev/null && echo y || echo n`) === 'n')
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  return required.join(' ')
})

// A build step that ran as root inside the workspace leaves state the runtime cannot write, and
// the symptom is a runtime that will not start for the user that owns its own home. The table
// generator did exactly this once.
check('the workspace contains nothing the runtime user cannot write', () => {
  const uid = inImage('id -u')
  const foreign = inImage(`find /agent -maxdepth 2 ! -uid ${uid} -printf '%u %p\\n' 2>/dev/null | head -10`)
  if (foreign) throw new Error(`entries not owned by the runtime user: ${foreign.split('\n').join(', ')}`)
  return 'clean'
})

// The volume outlives the image, so a uid that shifts between versions makes an agent's own
// workspace unreadable to it after a rollout.
check('the workspace root is owned by the runtime user', () => {
  const owner = inImage('stat -c "%u:%g" /agent')
  const uid = inImage('id -u')
  if (owner.split(':')[0] !== uid) throw new Error(`/agent is owned by ${owner} but the runtime is uid ${uid}`)
  return owner
})

process.stdout.write(`runtime-sandbox image checks (${image})\n${[...notes, ...warnings, ...failures].join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}
