#!/usr/bin/env node
// Asserts what the loaded runtime-sandbox image's CONFIG says: the USER, the ENTRYPOINT and the ENV a pod inherits.
//
//   node scripts/verify-runtime-image.mjs <image>
//
// Everything a check can prove from inside the image runs in the Dockerfile's verify stages instead
// (docker/runtime-sandbox/verify-image.mjs and scripts/verify-runtime-table.mjs), where BuildKit caches it by its
// inputs. What is left here needs `docker inspect`, which a build stage cannot run against its own image.
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

// The verify stage proved its own uid is not 0; this proves a pod without a securityContext inherits that user.
check('a non-root USER is configured', () => {
  const configured = inspect('{{.Config.User}}')
  if (!configured) throw new Error('no USER is set, so the runtime would inherit root')
  if (/^(0|root)(:|$)/.test(configured)) throw new Error(`USER is ${configured}`)
  return `USER ${configured}`
})

// PID 1 has to reap the runtime's children and forward SIGTERM, or every drain ends in SIGKILL and looks like a crash.
check('tini is PID 1 and forwards signals', () => {
  const entrypoint = inspect('{{json .Config.Entrypoint}}')
  if (!entrypoint.includes('tini')) throw new Error(`entrypoint is not tini: ${entrypoint}`)
  return entrypoint
})

// With the env unset, agent-browser downloads its own 391 MB Chrome into the workspace volume and the baked one is dead weight.
check('the baked Chrome runs as the runtime user and is what agent-browser is pointed at', () => {
  const env = JSON.parse(inspect('{{json .Config.Env}}'))
  const declared = env.find((entry) => entry.startsWith('AGENT_BROWSER_EXECUTABLE_PATH='))
  if (!declared) throw new Error('AGENT_BROWSER_EXECUTABLE_PATH is unset, so agent-browser downloads its own Chrome')
  const path = declared.slice('AGENT_BROWSER_EXECUTABLE_PATH='.length)
  const owner = inImage(`stat -c '%U:%G %a' ${path}`)
  if (!owner.startsWith('root:root')) throw new Error(`${path} is owned by ${owner}, not root`)
  if (inImage(`test -w ${path} && echo y || echo n`) === 'y') throw new Error(`the runtime user can rewrite ${path}`)
  const version = inImage(`${path} --version`)
  if (!/^Google Chrome for Testing \d+\./.test(version)) throw new Error(`unexpected version output: ${version}`)
  return `${version} at ${path} (${owner})`
})

process.stdout.write(`runtime-sandbox image checks (${image})\n${[...notes, ...failures].join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}
