// `agentconnect-secrets` (capability-requests.md §4.9.2): the agent's live secrets, fetched over the credential channel at use time.
// One implementation for every place it runs: the daemon CLI dials its own socket, the in-pod entry dials the shim's tunnel.
// Node builtins and the channel's leaves only: the in-sandbox bundle is asserted to import nothing else.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from './env.js'
import { gitcredIpc } from './gh-token-ipc.js'

/** A live secret's name, as the agent writes it on the command line. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/

const USAGE = `usage: agentconnect-secrets <command>
  exec [--only A,B] -- <command> [args…]   run a command with the live secrets in its environment
  env [A B …]                              print shell-quoted export lines, for eval "$(agentconnect-secrets env A)"
  file A                                   write A to a private file under $TMPDIR and print its path
  list                                     list the live secrets by name and description
`

interface LiveSecret {
  name: string
  value: string
  description?: string
}

export interface SecretsHelperIo {
  socketPath: string
  env: NodeJS.ProcessEnv
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Run the command with the env given; resolves with its exit code. */
  run?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>
  /** Where `file` writes; the process's own temporary directory by default. */
  tmpdir?: () => string
}

/** Single-quote a value for sh, escaping any quote it carries. */
const shQuote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

/** Run one `agentconnect-secrets` invocation; resolves with the process exit code. Never prints a value except where asked to. */
export async function runSecretsHelper(argv: readonly string[], io: SecretsHelperIo): Promise<number> {
  const [command, ...rest] = argv
  const fail = (text: string, code = 1): number => {
    io.stderr(`agentconnect-secrets: ${text}\n`)
    return code
  }
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    io.stderr(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command !== 'exec' && command !== 'env' && command !== 'file' && command !== 'list') {
    return fail(`unknown command "${command}"\n${USAGE}`, 2)
  }

  // Parse before fetching, so a malformed call never reaches the daemon.
  let names: string[] | undefined
  let execArgv: string[] = []
  if (command === 'exec') {
    const dashes = rest.indexOf('--')
    const options = dashes === -1 ? [] : rest.slice(0, dashes)
    execArgv = dashes === -1 ? [...rest] : rest.slice(dashes + 1)
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!
      if (option === '--only' && options[i + 1] !== undefined) names = options[++i]!.split(',').filter(Boolean)
      else if (option.startsWith('--only=')) names = option.slice('--only='.length).split(',').filter(Boolean)
      else return fail(`unknown option "${option}"\n${USAGE}`, 2)
    }
    // Without `--` the rest is the command, unless it starts with an option that belonged before one.
    if (execArgv.length === 0 || (dashes === -1 && execArgv[0]!.startsWith('-')))
      return fail(`exec needs a command after --\n${USAGE}`, 2)
  } else if (command === 'env') {
    names = rest.length > 0 ? [...rest] : undefined
  } else if (command === 'file') {
    if (rest.length !== 1) return fail(`file takes exactly one secret name\n${USAGE}`, 2)
    names = [rest[0]!]
  } else if (rest.length > 0) {
    return fail(`list takes no arguments\n${USAGE}`, 2)
  }
  const invalid = names?.find((name) => !SECRET_NAME.test(name))
  if (invalid !== undefined)
    return fail(`"${invalid}" is not a secret name (A-Z, 0-9 and _, starting with a letter)`, 2)

  const agentId = io.env[GITCRED_AGENT_ENV]
  const capability = io.env[GITCRED_CAPABILITY_ENV]
  if (!agentId || !capability) return fail('this runtime has no AgentConnect credential channel')
  const res = (await gitcredIpc(io.socketPath, {
    op: 'secret',
    agentId,
    capability,
    ...(names ? { names } : {})
  })) as { ok: boolean; error?: string; secrets?: LiveSecret[] }
  if (!res.ok || !Array.isArray(res.secrets)) return fail(`live secrets unavailable: ${res.error ?? 'unknown error'}`)
  const secrets = res.secrets
  const missing = (names ?? []).filter((name) => !secrets.some((s) => s.name === name))
  if (missing.length > 0) return fail(`no live secret named ${missing.join(', ')}; run \`agentconnect-secrets list\``)

  if (command === 'list') {
    if (secrets.length === 0) io.stdout('(no live secrets)\n')
    for (const s of secrets) io.stdout(s.description ? `${s.name}\t${s.description}\n` : `${s.name}\n`)
    return 0
  }
  if (command === 'env') {
    for (const s of secrets) io.stdout(`export ${s.name}=${shQuote(s.value)}\n`)
    return 0
  }
  if (command === 'file') {
    const secret = secrets[0]!
    const path = join(io.tmpdir?.() ?? tmpdir(), `agentconnect-secret-${secret.name}-${randomBytes(6).toString('hex')}`)
    // `wx` with 0600: never another file's contents, never readable by anyone else.
    writeFileSync(path, secret.value, { mode: 0o600, flag: 'wx' })
    io.stdout(`${path}\n`)
    return 0
  }
  const env: NodeJS.ProcessEnv = { ...io.env }
  for (const s of secrets) env[s.name] = s.value
  const run = io.run ?? runInherited
  return await run(execArgv[0]!, execArgv.slice(1), env)
}

/** The command on this process's own stdio, so nothing passes through the helper; its exit code, or 128+signal. */
function runInherited(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' })
    child.on('error', (err) => {
      process.stderr.write(`agentconnect-secrets: cannot run ${command}: ${err.message}\n`)
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)))
  })
}
