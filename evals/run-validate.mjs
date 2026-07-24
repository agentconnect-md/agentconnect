import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

process.env.PROMPTFOO_DISABLE_TELEMETRY ??= '1'

const require = createRequire(import.meta.url)
const entrypoint = join(dirname(require.resolve('promptfoo')), 'entrypoint.js')
// Promptfoo imports the TypeScript provider while validating the config. Point
// workspace dependencies at source so validation works before any package build.
const nodeOptions = [process.env.NODE_OPTIONS, '--conditions=development'].filter(Boolean).join(' ')
const child = spawn(process.execPath, [entrypoint, 'validate', 'config', '-c', 'evals/promptfooconfig.yaml'], {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: 'inherit'
})

child.once('error', (error) => {
  console.error(`Unable to launch Promptfoo validation: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Promptfoo validation exited from signal ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
