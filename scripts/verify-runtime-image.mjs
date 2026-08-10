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

const image = process.argv[2]
if (!image) {
  process.stderr.write('usage: verify-runtime-image.mjs <image>\n')
  process.exit(2)
}

const failures = []
const notes = []

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
const TABLE_PATH = '/opt/agentconnect/runtime/cloud-runtimes.json'

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

// The shim is built with everything inlined so this image installs no node_modules for it. A
// require of anything but a node: builtin means the bundle is depending on a tree that is absent.
check('the shim bundle is self-contained', () => {
  // Same specifier shapes the daemon package's own assert-self-contained step looks for, run
  // against the artifact that actually shipped. The local build being clean says nothing about
  // the image: an earlier version of this Dockerfile ran tsdown without building the workspace
  // deps, and produced a bundle that imported them externally — which the image cannot resolve.
  const specs = inImage(
    `grep -oE '\\b(from|import)[[:space:]]*\\(?[[:space:]]*"[^"]+"' ${SHIM_PATH} | ` +
      `grep -oE '"[^"]+"' | tr -d '"' | sort -u | grep -v '^node:' || true`
  )
  if (specs) throw new Error(`shim references non-builtin modules: ${specs.split('\n').join(', ')}`)
  return 'node: builtins only'
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

// The acceptance criterion: the published table must match what the runtimes actually report.
check('the published runtime table matches what the runtimes report', () => {
  const table = JSON.parse(inImage(`cat ${TABLE_PATH}`))
  if (!Array.isArray(table.runtimes) || table.runtimes.length === 0) {
    throw new Error('table declares no runtimes, so the daemon would advertise none')
  }
  const bins = { 'claude-acp': 'claude-agent-acp', 'codex-acp': 'codex-acp' }
  const mismatches = []
  for (const entry of table.runtimes) {
    const bin = bins[entry.id]
    if (!bin) {
      mismatches.push(`${entry.id}: declared but this check knows no executable for it`)
      continue
    }
    // Compared against what the CLI PRINTS, not against the manifest the table was generated
    // from: agreeing with its own source would prove only that the generator ran.
    const reported = inImage(`${bin} --version 2>&1 | head -1`)
    if (!reported.includes(entry.version)) {
      mismatches.push(`${entry.id}: table says ${entry.version}, runtime reports "${reported}"`)
    }
  }
  if (mismatches.length > 0) throw new Error(mismatches.join('; '))
  return table.runtimes.map((entry) => `${entry.id}@${entry.version}`).join(' ')
})

// The workspace surface runs git INSIDE the sandbox over the shim's exec channel, so a missing
// git is not a degraded feature — it is every workspace operation failing at the far end.
check('provides the executables the shim must resolve', () => {
  const required = ['git', 'node', 'claude-agent-acp', 'codex-acp']
  const missing = required.filter((bin) => inImage(`command -v ${bin} >/dev/null && echo y || echo n`) === 'n')
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  return required.join(' ')
})

// The volume outlives the image, so a uid that shifts between versions makes an agent's own
// workspace unreadable to it after a rollout.
check('the workspace root is owned by the runtime user', () => {
  const owner = inImage('stat -c "%u:%g" /agent')
  const uid = inImage('id -u')
  if (owner.split(':')[0] !== uid) throw new Error(`/agent is owned by ${owner} but the runtime is uid ${uid}`)
  return owner
})

process.stdout.write(`runtime-sandbox image checks (${image})\n${[...notes, ...failures].join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}
