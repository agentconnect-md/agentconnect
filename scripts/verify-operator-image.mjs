#!/usr/bin/env node
/**
 * Asserts the operator image holds the properties a cluster deployment depends on.
 *
 *   node scripts/verify-operator-image.mjs <image> [expected-version]
 *
 * Checked against the BUILT image, not the Dockerfile: a base bump or a layer
 * ordering change passes review and fails here.
 */
import { execFileSync } from 'node:child_process'

const image = process.argv[2]
const expectedVersion = process.argv[3]
if (!image) {
  process.stderr.write('usage: verify-operator-image.mjs <image> [expected-version]\n')
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
  return `uid ${uid}`
})

check('tini is PID 1 so SIGTERM releases the lease', () => {
  const entrypoint = inspect('{{ json .Config.Entrypoint }}')
  if (!entrypoint.includes('tini')) throw new Error(`entrypoint is ${entrypoint}, not tini`)
  return entrypoint
})

check('CA certificates are present for API server TLS', () => {
  return inImage('test -s /etc/ssl/certs/ca-certificates.crt && echo present')
})

check('the deployed bundle is production-only (no vitest, no tsx)', () => {
  const hits = inImage('ls node_modules 2>/dev/null | grep -cE "^(vitest|tsx)$" || true')
  if (hits !== '0') throw new Error('dev tooling found in node_modules')
  return 'clean'
})

if (expectedVersion) {
  check('package.json reports the stamped release version', () => {
    const version = inImage('node -p "require(\'./package.json\').version"')
    const expected = expectedVersion.replace(/^v/, '')
    if (version !== expected) throw new Error(`version is ${version}, expected ${expected}`)
    return version
  })
}

check('missing configuration fails fast instead of starting half-configured', () => {
  const { code, output } = runEntrypoint()
  if (code === 0) throw new Error('entrypoint exited 0 without configuration')
  if (!/AC_ORG_NAMESPACE_PREFIX/.test(output)) {
    throw new Error(`failure output does not name the missing constant: ${output.slice(0, 200)}`)
  }
  return `exit ${code}, names the missing env`
})

check('outside a cluster the operator refuses to start', () => {
  const { code, output } = runEntrypoint({
    AC_ORG_NAMESPACE_PREFIX: 'ci-org-',
    AC_TOKENREVIEW_CLUSTERROLE: 'ci-ac-tokenreview'
  })
  if (code === 0) throw new Error('started without in-cluster credentials')
  if (!/service account|KUBERNETES_SERVICE|InClusterConfig/i.test(output)) {
    throw new Error(`failure output does not point at in-cluster config: ${output.slice(0, 200)}`)
  }
  return `exit ${code}, in-cluster config required`
})

process.stdout.write(`${notes.join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}
