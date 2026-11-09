import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same posture as run-addons.mjs: private report files, no telemetry, the just-built daemon bundle.
process.umask(0o077)
process.env.PROMPTFOO_DISABLE_TELEMETRY ??= '1'

for (const name of ['AGENTCONNECT_EVAL_SUBJECT_ROOT', 'AGENTCONNECT_EVAL_ROOT_AGENT']) {
  if (!process.env[name]?.trim()) {
    console.error(`${name} is required: the memory-dream evaluation runs a real-runtime subject`)
    process.exit(1)
  }
}

const require = createRequire(import.meta.url)
const entrypoint = join(dirname(require.resolve('promptfoo')), 'entrypoint.js')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonEntry = resolve(repositoryRoot, 'packages/daemon/dist/index.js')
if (!process.env.AGENTCONNECT_DAEMON_ENTRY) {
  if (!existsSync(daemonEntry)) {
    console.error(`Evaluation daemon build is missing: ${daemonEntry}`)
    process.exit(1)
  }
  process.env.AGENTCONNECT_DAEMON_ENTRY = daemonEntry
}
const extraArgs = process.argv.slice(2).filter((arg, index) => !(arg === '--' && index === 0))
const nodeOptions = [process.env.NODE_OPTIONS, '--conditions=development'].filter(Boolean).join(' ')
const child = spawn(
  process.execPath,
  [
    entrypoint,
    'eval',
    '-c',
    'evals/dreamconfig.yaml',
    '--no-cache',
    '--max-concurrency',
    '1',
    '--no-share',
    ...extraArgs
  ],
  { env: { ...process.env, NODE_OPTIONS: nodeOptions }, stdio: 'inherit' }
)

child.once('error', (error) => {
  console.error(`Unable to launch Promptfoo: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Promptfoo exited from signal ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
