#!/usr/bin/env node
/**
 * Asserts the daemon pod image holds the properties a cluster deployment depends on.
 *
 *   node scripts/verify-daemon-image.mjs <image>
 *
 * Checked against the BUILT image, not the Dockerfile, for the same reason as the runtime
 * sandbox: a base bump or a layer ordering change passes review and fails here.
 *
 * The one that matters most is the last: `--k8s` outside a pod must REFUSE to start. The failure
 * it guards against is silent — a daemon that fell back to local execution would look healthy
 * while running agent code on its own host, which is the entire thing the mode exists to prevent.
 */
import { execFileSync } from 'node:child_process'

const image = process.argv[2]
const expectedVersion = process.argv[3]
if (!image) {
  process.stderr.write('usage: verify-daemon-image.mjs <image> [expected-version]\n')
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

function inImage(script) {
  return execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }).trim()
}

function inspect(format) {
  return execFileSync('docker', ['inspect', '--format', format, image], { encoding: 'utf8' }).trim()
}

/** Run the image's real entrypoint and return whatever it printed, exit code included. */
function runEntrypoint(env = {}) {
  const args = ['run', '--rm']
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push(image)
  try {
    return { code: 0, output: execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

check('runs as a non-root user', () => {
  const uid = inImage('id -u')
  if (uid === '0') throw new Error('image runs as root')
  const configured = inspect('{{.Config.User}}')
  if (!configured) throw new Error('no USER is set')
  return `uid ${uid}`
})

// Without tini, PID 1 ignores SIGTERM, so the shutdown drain never runs and every rollout ends
// in SIGKILL mid-drain — with in-flight turns cut rather than finished.
check('tini is PID 1, so a SIGTERM reaches the drain', () => {
  const entrypoint = inspect('{{json .Config.Entrypoint}}')
  if (!entrypoint.includes('tini')) throw new Error(`entrypoint is not tini: ${entrypoint}`)
  return entrypoint
})

check('starts the daemon in k8s mode by default', () => {
  const cmd = inspect('{{json .Config.Cmd}}')
  if (!cmd.includes('--k8s')) throw new Error(`default command does not enable the mode: ${cmd}`)
  return cmd
})

// A self-hosted agent on this daemon still clones locally: the workspace seam moves git into a
// sandbox only for agents that have one, so a missing git breaks the other half.
check('carries git and the certificates outbound TLS needs', () => {
  const missing = ['git', 'node'].filter((bin) => inImage(`command -v ${bin} >/dev/null && echo y || echo n`) === 'n')
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  const certs = inImage('test -e /etc/ssl/certs/ca-certificates.crt && echo y || echo n')
  if (certs !== 'y') throw new Error('no CA bundle, so outbound TLS would fail')
  return inImage('git --version')
})

// This image runs the daemon; the ACP runtimes live in the runtime-sandbox image. Shipping them
// here would mean an image that could quietly run an agent locally.
check('ships no ACP runtime of its own', () => {
  const present = ['claude-agent-acp', 'codex-acp'].filter(
    (bin) => inImage(`command -v ${bin} >/dev/null && echo y || echo n`) === 'y'
  )
  if (present.length > 0) throw new Error(`daemon image ships runtimes: ${present.join(', ')}`)
  return 'none, as intended'
})

check('declares the kubelet as its supervisor', () => {
  // Restart-only: the version is the image, so an in-pod self-upgrade would exit for a version
  // the cluster never asked for.
  const env = inspect('{{json .Config.Env}}')
  if (!env.includes('AGENTCONNECT_SUPERVISOR=k8s')) throw new Error(`supervisor is not declared: ${env}`)
  return 'AGENTCONNECT_SUPERVISOR=k8s'
})

check('REFUSES to start outside a pod rather than running runtimes locally', () => {
  const { code, output } = runEntrypoint({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool' })
  if (code === 0) throw new Error('the daemon started outside a cluster, so runtimes would run on this host')
  if (!/not running inside a Kubernetes pod/.test(output)) {
    throw new Error(`refused, but not for the expected reason: ${output.slice(-300)}`)
  }
  return 'exits with the in-cluster config error'
})

check('names the missing deployment settings instead of guessing them', () => {
  // A guessed org labels another tenant's claims; a guessed pool yields sandboxes that never bind.
  const { code, output } = runEntrypoint()
  if (code === 0) throw new Error('started without an org id')
  if (!/AC_K8S_ORG_ID/.test(output)) throw new Error(`did not name the missing setting: ${output.slice(-300)}`)
  return 'reports AC_K8S_ORG_ID'
})

// The Control Plane persists what this reports as `agentVersion` and drives fleet and upgrade
// state from it, so a pod that identifies itself as the dev version is worse than unversioned:
// it looks like a real answer.
if (expectedVersion) {
  check('reports the release version rather than the repo manifest', () => {
    const reported = inImage('node dist/index.js --version').trim()
    const wanted = expectedVersion.replace(/^v/, '')
    if (reported !== wanted) throw new Error(`reports ${reported}, expected ${wanted}`)
    if (/-dev$/.test(reported)) throw new Error('reports the development version')
    return reported
  })
}

process.stdout.write(`daemon image checks (${image})\n${[...notes, ...failures].join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}
