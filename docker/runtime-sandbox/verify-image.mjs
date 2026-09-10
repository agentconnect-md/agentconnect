#!/usr/bin/env node
// Static assertions run INSIDE the built runtime-sandbox image, as its own user, from the Dockerfile's verify stage.
//
//   node verify-image.mjs runtime-sandbox|runtime-sandbox-full
//
// Everything here reads the image's filesystem or runs its executables; whatever needs the image CONFIG (USER,
// ENTRYPOINT, ENV) stays in scripts/verify-runtime-image.mjs, which inspects the loaded image on the host.
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'

const variant = process.argv[2]
if (!['runtime-sandbox', 'runtime-sandbox-full'].includes(variant)) {
  process.stderr.write('usage: verify-image.mjs runtime-sandbox|runtime-sandbox-full\n')
  process.exit(2)
}

const failures = []
const notes = []
const nodeBuiltins = new Set(builtinModules.flatMap((spec) => [spec, `node:${spec}`]))

function check(name, fn) {
  try {
    const detail = fn()
    notes.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    failures.push(`  ✗ ${name}: ${err.message}`)
  }
}

/** Run a shell command as the user this stage runs as, which is the image's own. */
function sh(script) {
  return execFileSync('sh', ['-c', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

/** Root-owned, not group/other writable, and an append as this user is refused. */
function assertImmutable(label, path) {
  const owner = sh(`stat -c '%U:%G %a' ${path}`)
  if (!owner.startsWith('root:root')) throw new Error(`${label} is not root-owned (${owner})`)
  const mode = owner.split(' ')[1]
  if (/[2367]$/.test(mode) || /^.[2367]/.test(mode)) throw new Error(`${label} is group/other writable (${mode})`)
  const refused = sh(`(echo x >> ${path} && echo WRITABLE) || echo refused`)
  if (refused !== 'refused') throw new Error(`the runtime user can modify ${label}`)
  return owner
}

const SHIM_PATH = '/opt/agentconnect/shim/index.js'
// Must match SANDBOX_GIT_CREDENTIAL_HELPER in packages/daemon/src/shim/sandbox-paths.ts: git config carries this path.
const CREDENTIAL_HELPER_PATH = '/opt/agentconnect/bin/git-credential'
// Must match SANDBOX_GH_WRAPPER_DIR in sandbox-paths.ts: the shim prepends exactly this directory to the runtime PATH.
const GH_WRAPPER_PATH = '/opt/agentconnect/pathbin/gh'
// Must match SANDBOX_MCP_BRIDGE_ENTRY in sandbox-paths.ts: the daemon copies this path into the `mcpServers` spec.
const MCP_BRIDGE_PATH = '/opt/agentconnect/shim/mcp-bridge.js'
const SKILLS_CLI_PATH = '/opt/agentconnect/shim/skills/dist/cli.js'
const SKILL_MUTATION_PATH = '/opt/agentconnect/shim/skills/workspace-mutation.js'
// Must match SANDBOX_DSH_PRESET_DIR in sandbox-paths.ts: the shim copies this directory into a pod's $DSH_HOME.
const DSH_PRESET_DIR = '/opt/agentconnect/dsh/agent-presets/standard-no-search'

// First, while nothing in this stage has run yet: a build step that ran as root inside the workspace leaves state
// the runtime cannot write, and the symptom is a runtime that will not start for the user that owns its own home.
check('the workspace contains nothing the runtime user cannot write', () => {
  const uid = sh('id -u')
  const foreign = sh(`find /agent -maxdepth 2 ! -uid ${uid} -printf '%u %p\\n' 2>/dev/null | head -10`)
  if (foreign) throw new Error(`entries not owned by the runtime user: ${foreign.split('\n').join(', ')}`)
  return 'clean'
})

// The volume outlives the image, so a uid that shifts between versions makes an agent's workspace unreadable to it.
check('the workspace root is owned by the runtime user', () => {
  const owner = sh('stat -c "%u:%g" /agent')
  const uid = sh('id -u')
  if (owner.split(':')[0] !== uid) throw new Error(`/agent is owned by ${owner} but the runtime is uid ${uid}`)
  return owner
})

// The runtime is the untrusted party in this image, so root would hand it the whole filesystem.
check('runs as a non-root user', () => {
  const uid = sh('id -u')
  if (uid === '0') throw new Error('image runs as root')
  return `uid ${uid}`
})

if (variant === 'runtime-sandbox-full') {
  check('native Claude sandbox dependencies are installed', () => sh('set -e; bwrap --version; socat -V'))

  check('Docker Engine, Buildx and Compose are installed without starting a daemon', () => {
    return sh('set -e; dockerd --version; docker --version; docker buildx version; docker compose version')
  })

  check('the runtime user may elevate only the Docker daemon command', () => {
    return sh(
      'set -e; getent group docker | cut -d: -f4 | tr , "\\n" | grep -qx agent; sudo -n /usr/bin/dockerd --version; if sudo -n /usr/bin/id -u >/dev/null 2>&1; then exit 1; fi'
    )
  })
} else {
  check('pool image excludes native sandbox and Docker tools', () => {
    return sh('for tool in bwrap socat docker dockerd containerd sudo; do if command -v "$tool"; then exit 1; fi; done')
  })
}

// The ENTRYPOINT names tini; the host check reads that from the image config, this one proves the binary is there.
check('tini is executable', () => {
  if (sh('test -x /usr/bin/tini && echo yes || echo no') !== 'yes') throw new Error('/usr/bin/tini is not executable')
  return '/usr/bin/tini'
})

// A shim the runtime can rewrite is a shim it can replace with one that answers the daemon however it likes.
check('the shim is root-owned and not writable by the runtime user', () => assertImmutable('shim', SHIM_PATH))

check('the pinned skills CLI is present, immutable and executable', () => {
  const owner = sh(`stat -c '%U:%G %a' ${SKILLS_CLI_PATH}`)
  if (!owner.startsWith('root:root')) throw new Error(`skills CLI is not root-owned (${owner})`)
  const version = sh(`node ${SKILLS_CLI_PATH} --version`)
  if (version !== '1.5.21') throw new Error(`skills CLI version is ${version}`)
  return `${owner}, version ${version}`
})

check('the skill workspace mutation helper is present and immutable', () =>
  assertImmutable('skill mutation helper', SKILL_MUTATION_PATH)
)

// Git spawns a credential helper per invocation; one the runtime can rewrite asks the daemon for credentials in its name.
check('the git credential helper is present, executable and root-owned', () => {
  const owner = assertImmutable('credential helper', CREDENTIAL_HELPER_PATH)
  if (sh(`test -x ${CREDENTIAL_HELPER_PATH} && echo yes || echo no`) !== 'yes') {
    throw new Error('credential helper is not executable, so git cannot run it')
  }
  return owner
})

// gh reads a static GH_TOKEN fixed at spawn, so a pod agent gets per-repo tokens only through this wrapper.
check('the gh wrapper is present, executable and root-owned', () => {
  const owner = assertImmutable('gh wrapper', GH_WRAPPER_PATH)
  if (sh(`test -x ${GH_WRAPPER_PATH} && echo yes || echo no`) !== 'yes') {
    throw new Error('gh wrapper is not executable, so the runtime would resolve the real gh instead')
  }
  return owner
})

// Prepending the wrapper's dir must not shadow the gh it execs; without an identity the agent still gets a plain gh.
check('the gh wrapper defers to the real gh when no agent identity is present', () => {
  const dir = GH_WRAPPER_PATH.replace(/\/gh$/, '')
  const out = sh(`PATH=${dir}:$PATH gh --version 2>&1 | head -1`)
  if (!/^gh version /.test(out)) throw new Error(`the wrapper did not reach the real gh: ${out}`)
  return out
})

// A helper that cannot reach a socket must SAY so and fail, or git reads an empty answer as "no credentials configured".
check('the credential helper runs and fails loudly with no daemon socket', () => {
  const out = sh(
    `AC_GITCRED_SOCKET=/nonexistent/gitcred.sock ` +
      `sh -c 'echo "protocol=https\nhost=github.com" | ${CREDENTIAL_HELPER_PATH} agent-x get; echo "exit=$?"' 2>&1`
  )
  if (!out.includes('exit=1')) throw new Error(`helper did not exit 1 without a socket: ${out}`)
  if (!/agentconnect: no git credentials/.test(out)) throw new Error(`helper printed no actionable reason: ${out}`)
  if (/password=/.test(out)) throw new Error('helper answered git despite having no credential')
  return 'exits 1 with an actionable message'
})

// The harness spawns this per session from a spec the daemon builds around THIS path; it inherits the shim's threat model.
check('the MCP bridge is present and root-owned', () => assertImmutable('mcp bridge', MCP_BRIDGE_PATH))

// A bundle that reads a file the image does not ship dies on import, which the harness cannot tell from a missing module.
check('the MCP bridge starts and fails loudly with no daemon socket', () => {
  const out = sh(
    `AC_MCP_ENDPOINT=/nonexistent/mcp.sock AC_MCP_TOKEN=probe ` +
      `sh -c 'node ${MCP_BRIDGE_PATH} </dev/null; echo "exit=$?"' 2>&1`
  )
  if (!/mcp-bridge: could not reach daemon/.test(out)) throw new Error(`bridge did not run to its own error: ${out}`)
  if (!out.includes('exit=1')) throw new Error(`bridge did not exit 1 without a socket: ${out}`)
  return 'exits 1 with an actionable message'
})

// Same specifier shapes the daemon's assert-self-contained step looks for, run against the artifacts that shipped.
check('the shim bundles are self-contained', () => {
  const external = []
  for (const path of [SHIM_PATH, MCP_BRIDGE_PATH, SKILL_MUTATION_PATH]) {
    const bundle = sh(`cat ${path}`)
    const specs = [...bundle.matchAll(/\bfrom\s*"([^"]+)"/g), ...bundle.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1]
    )
    const leaked = [...new Set(specs.filter((spec) => !nodeBuiltins.has(spec)))].sort()
    if (leaked.length > 0) external.push(`${path}: ${leaked.join(', ')}`)
  }
  if (external.length > 0) throw new Error(`bundles reference non-builtin modules — ${external.join('; ')}`)
  return 'Node builtins only'
})

// The pod template owns identity projection; a token baked in would be an identity nobody granted.
check('carries no service-account token of its own', () => {
  const found = sh(
    'ls /var/run/secrets/kubernetes.io/serviceaccount/token /var/run/ac-identity/token 2>/dev/null | tr "\\n" " "'
  )
  if (found) throw new Error(`image ships a token at: ${found}`)
  return 'none'
})

// Generated from whatever adapter the build installed, so a bake that silently found no preset ships a broken web_search.
check('bakes the no-search DeepSeek preset the shim seeds', () => {
  const composition = `${DSH_PRESET_DIR}/agent.cordis.yml`
  const listing = sh(`ls ${DSH_PRESET_DIR} 2>/dev/null | tr "\\n" " "`)
  if (!listing.includes('agent.cordis.yml')) throw new Error(`no preset composition under ${DSH_PRESET_DIR}`)
  const rows = sh(`grep -c "^- id: " ${composition}`)
  if (Number(rows) < 2) throw new Error(`${composition} carries ${rows} plugin rows, so it is not a copied preset`)
  const disabled = sh(`grep -A6 "^- id: tool-web" ${composition} | grep -c "search: false" || true`)
  if (disabled !== '1') throw new Error(`tool-web in ${composition} does not deregister web_search`)
  const writable = sh(`test -w ${composition} && echo y || echo n`)
  if (writable === 'y') throw new Error('the runtime user can rewrite the preset it is seeded with')
  return `${listing.trim()} (${rows.trim()} rows, read-only)`
})

// Git runs INSIDE the sandbox over the shim's exec channel, so a missing git is every workspace operation failing.
check('provides the executables the shim must resolve', () => {
  const required = ['git', 'gh', 'node', 'claude-agent-acp', 'codex-acp', 'dsh-acp']
  const missing = required.filter((bin) => sh(`command -v ${bin} >/dev/null && echo y || echo n`) === 'n')
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  return required.join(' ')
})

// `ldd chrome` on Chrome for Testing 152, by soname: apt satisfying a package name says nothing about what resolves.
const CHROME_SONAMES = [
  'libX11.so.6',
  'libXcomposite.so.1',
  'libXdamage.so.1',
  'libXext.so.6',
  'libXfixes.so.3',
  'libXrandr.so.2',
  'libasound.so.2',
  'libatk-1.0.so.0',
  'libatk-bridge-2.0.so.0',
  'libatspi.so.0',
  'libcairo.so.2',
  'libcups.so.2',
  'libdbus-1.so.3',
  'libexpat.so.1',
  'libgbm.so.1',
  'libgio-2.0.so.0',
  'libglib-2.0.so.0',
  'libgobject-2.0.so.0',
  'libnspr4.so',
  'libnss3.so',
  'libnssutil3.so',
  'libpango-1.0.so.0',
  'libsmime3.so',
  'libxcb.so.1',
  'libxkbcommon.so.0'
]

// The agent has no sudo, so a missing soname is a browser it downloads, cannot start and cannot fix.
check('resolves every shared library Chrome needs', () => {
  const cache = sh('/sbin/ldconfig -p')
  const missing = CHROME_SONAMES.filter((so) => !cache.includes(`${so} `))
  if (missing.length > 0) throw new Error(`unresolved: ${missing.join(', ')}`)
  return `${CHROME_SONAMES.length} sonames`
})

// Preinstalled because `npm i -g agent-browser` EACCESes as the runtime user, and pruned to this platform's native binary.
check('the pinned agent-browser CLI runs and carries only this platform binary', () => {
  const version = sh('agent-browser --version')
  if (!/^agent-browser \d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected version output: ${version}`)
  const natives = sh("ls /usr/local/lib/node_modules/agent-browser/bin | grep '^agent-browser-' | tr '\\n' ' '").trim()
  if (natives.split(/\s+/).filter(Boolean).length !== 1) throw new Error(`bin/ carries native binaries: ${natives}`)
  return `${version} (${natives})`
})

// The wrapper keeps `agent-browser install` from fetching a browser the image already carries; root-owned like gh's.
check('the agent-browser wrapper answers a bare install and defers otherwise', () => {
  const wrapper = `${GH_WRAPPER_PATH.replace(/\/gh$/, '')}/agent-browser`
  const owner = sh(`stat -c '%U:%G %a' ${wrapper}`)
  if (!owner.startsWith('root:root')) throw new Error(`the wrapper is not root-owned (${owner})`)
  if (sh(`(echo x >> ${wrapper} && echo WRITABLE) || echo refused`) !== 'refused') {
    throw new Error('the runtime user can modify the agent-browser wrapper')
  }
  const answered = sh(`${wrapper} install; echo "rc=$?"; du -sk $HOME/.agent-browser 2>/dev/null | cut -f1`)
  if (!answered.includes('rc=0')) throw new Error(`install exited non-zero: ${answered}`)
  if (!/already installed/.test(answered)) throw new Error(`install did not report the baked Chrome: ${answered}`)
  const downloaded = Number(answered.split('\n').pop())
  if (Number.isFinite(downloaded) && downloaded > 1024) throw new Error(`install wrote ${downloaded} KB into $HOME`)
  const version = sh(`${wrapper} --version`)
  if (!/^agent-browser \d+\.\d+\.\d+/.test(version))
    throw new Error(`the wrapper did not reach the real CLI: ${version}`)
  // An ACP child is spawned from an allowlist, so the image ENV may not reach it: the wrapper must default the path itself.
  const unset = sh(`env -u AGENT_BROWSER_EXECUTABLE_PATH ${wrapper} install`)
  if (!unset.includes('/opt/agentconnect/browser/chrome')) {
    throw new Error(`the wrapper does not default the browser path when the env is unset: ${unset}`)
  }
  return `${version}, install answered locally, path defaulted with the env unset`
})

process.stdout.write(`${variant} in-image checks\n${[...notes, ...failures].join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}
