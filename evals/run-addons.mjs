import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Promptfoo's built-in JSON/JUnit reports contain prompts and outputs. Make all
// files created by the child private by default, not only AgentConnect's own
// atomically-written evidence files.
process.umask(0o077)
process.env.PROMPTFOO_DISABLE_TELEMETRY ??= '1'

const require = createRequire(import.meta.url)
const entrypoint = join(dirname(require.resolve('promptfoo')), 'entrypoint.js')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonEntry = resolve(repositoryRoot, 'packages/daemon/dist/index.js')
if (!process.env.AGENTCONNECT_DAEMON_ENTRY) {
  if (!existsSync(daemonEntry)) {
    console.error(`Evaluation daemon build is missing: ${daemonEntry}`)
    process.exit(1)
  }
  // Evaluation embeds Daemon inside Promptfoo, so process.argv[1] is Promptfoo's
  // entrypoint rather than the AgentConnect CLI. Pin the just-built CLI bundle
  // explicitly so ACP runtimes spawn the real `mcp-bridge` subprocess.
  process.env.AGENTCONNECT_DAEMON_ENTRY = daemonEntry
}
const extraArgs = process.argv.slice(2).filter((arg, index) => !(arg === '--' && index === 0))
// Evaluate this source checkout against workspace source exports. This keeps a
// fresh install runnable before protocol/connection dist trees have been built.
const nodeOptions = [process.env.NODE_OPTIONS, '--conditions=development'].filter(Boolean).join(' ')
const child = spawn(
  process.execPath,
  [
    entrypoint,
    'eval',
    '-c',
    'evals/promptfooconfig.yaml',
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
