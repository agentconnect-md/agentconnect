import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SUITES,
  needsAttention,
  readAddons,
  readGames,
  readNightCollection,
  readProbe,
  readThreadChatter,
  readWebchatAddressed,
  renderHandoff,
  renderMarkdown,
  summarizeCells
} from './nightly/summary.ts'

// Raw reports hold prompts and outputs; keep everything this run writes private.
process.umask(0o077)

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsRoot = join(repositoryRoot, '.artifacts/evaluation')

function usage(message) {
  console.error(
    `${message ? `${message}\n\n` : ''}Usage: pnpm eval:nightly [--repeat <n>] [--game-repeat <n>] [--suites ${SUITES.join(',')}] [--probe-runtime <id>] [--probe-model <id>] [--no-build]`
  )
  process.exit(message ? 64 : 0)
}

function parseArgs(argv) {
  const options = {
    repeat: 3,
    gameRepeat: 1,
    suites: [...SUITES],
    probeRuntime: 'claude-acp',
    probeModel: 'sonnet',
    build: true
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => String(argv[(index += 1)] ?? '')
    if (arg === '--') continue
    else if (arg === '--help') usage()
    else if (arg === '--no-build') options.build = false
    else if (arg === '--repeat') options.repeat = Number(value())
    else if (arg === '--game-repeat') options.gameRepeat = Number(value())
    else if (arg === '--suites') options.suites = value().split(',').filter(Boolean)
    else if (arg === '--probe-runtime') options.probeRuntime = value()
    else if (arg === '--probe-model') options.probeModel = value()
    else usage(`unknown argument: ${arg}`)
  }
  for (const key of ['repeat', 'gameRepeat']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) usage(`--${key} must be a positive integer`)
  }
  const unknown = options.suites.filter((name) => !SUITES.includes(name))
  if (unknown.length > 0 || options.suites.length === 0) usage(`unknown suite: ${unknown.join(', ') || '(none)'}`)
  return options
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function run(command, args, env) {
  return spawnSync(command, args, { cwd: repositoryRoot, env, stdio: ['ignore', 2, 2] }).status
}

const options = parseArgs(process.argv.slice(2))
const startedAt = Date.now()
const at = new Date(startedAt).toISOString()
const runDir = join(artifactsRoot, 'nightly', at.replace(/[:.]/g, '-'))
mkdirSync(runDir, { recursive: true })
// A fixed path the scheduled agent reads; it exists only when tonight's run needs attention.
const handoffPath = join(artifactsRoot, 'nightly', 'handoff.md')
rmSync(handoffPath, { force: true })

// An operator subject wins; otherwise the checked-in Claude template and its agent ids.
const env = { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: process.env.PROMPTFOO_DISABLE_TELEMETRY ?? '1' }
if (!env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()) {
  env.AGENTCONNECT_EVAL_SUBJECT_ROOT = join(repositoryRoot, 'evals/subjects/claude')
  env.AGENTCONNECT_EVAL_ROOT_AGENT = 'eval-root'
  env.AGENTCONNECT_EVAL_SPECIALIST_AGENT = 'eval-specialist'
  env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS = 'eval-root'
}
const missing = [
  'AGENTCONNECT_EVAL_SUBJECT_ROOT',
  'AGENTCONNECT_EVAL_ROOT_AGENT',
  'AGENTCONNECT_EVAL_SPECIALIST_AGENT',
  'AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS'
].filter((name) => !env[name]?.trim())
if (missing.length > 0) usage(`missing environment: ${missing.join(', ')}`)
env.AGENTCONNECT_DAEMON_ENTRY = join(repositoryRoot, 'packages/daemon/dist/index.js')

if (options.build) {
  const build = spawnSync('pnpm', ['--filter', '@agentconnect.md/daemon', 'build'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 2, 2]
  })
  if (build.status !== 0) {
    console.error('eval:nightly: the daemon build failed, so no suite ran')
    process.exit(1)
  }
}

const promptfoo = (script, output, args, extraEnv = {}) => {
  run(process.execPath, [script, '--output', output, ...args], { ...env, ...extraEnv })
  return readJson(output)
}
// Vitest entries fail only on apparatus errors, so a non-zero exit means a scenario may be missing from the summary.
const apparatusFailures = new Set()
// They write a fixed summary under .artifacts; delete it first so a stale file is never read as tonight's.
const vitest = (file, summaryPath, name) => {
  rmSync(summaryPath, { force: true })
  const status = run('pnpm', ['exec', 'vitest', 'run', file], {
    ...env,
    AGENTCONNECT_EVAL_TRIALS: String(options.repeat)
  })
  if (status !== 0) apparatusFailures.add(name)
  if (existsSync(summaryPath)) copyFileSync(summaryPath, join(runDir, `${name}.json`))
  return readJson(summaryPath)
}
const probe = (only, modelVar, outVar, name) => {
  const output = join(runDir, `${name}.json`)
  run('pnpm', ['--filter', '@agentconnect.md/daemon', 'test:runtime-matrix'], {
    ...env,
    AC_RUNTIME_MATRIX_ONLY: only,
    AC_RUNTIME_MATRIX_TARGETS: options.probeRuntime,
    [modelVar]: options.probeModel,
    [outVar]: output
  })
  return readJson(output)
}
const gameArgs = ['--repeat', String(options.gameRepeat), '--filter-providers', 'real-agents']

const SUITE_RUNNERS = {
  addons: () =>
    readAddons(promptfoo('evals/run-addons.mjs', join(runDir, 'addons.json'), ['--repeat', String(options.repeat)])),
  counting: () =>
    readGames(
      'counting',
      promptfoo('evals/run-collaboration.mjs', join(runDir, 'counting.json'), [
        ...gameArgs,
        '--filter-pattern',
        'counting'
      ])
    ),
  relay: () =>
    readGames(
      'relay',
      promptfoo('evals/run-collaboration.mjs', join(runDir, 'relay.json'), gameArgs, {
        AGENTCONNECT_EVAL_GAME_CONFIG: 'evals/relayconfig.yaml'
      })
    ),
  'night-collection': () =>
    readNightCollection(
      vitest(
        'evals/test/webchat-night-collection-real.test.ts',
        join(artifactsRoot, 'night-collection/summary.json'),
        'night-collection'
      )
    ),
  'thread-chatter': () =>
    readThreadChatter(
      vitest(
        'evals/test/thread-chatter-real.test.ts',
        join(artifactsRoot, 'thread-chatter/summary.json'),
        'thread-chatter'
      )
    ),
  'webchat-addressed': () =>
    readWebchatAddressed(
      vitest(
        'evals/test/webchat-addressed-real.test.ts',
        join(artifactsRoot, 'webchat-addressed/summary.json'),
        'webchat-addressed'
      )
    ),
  'coordinator-probe': () =>
    readProbe(
      'coordinator-probe',
      probe(
        'coordinator',
        'AC_RUNTIME_MATRIX_COORDINATOR_MODEL',
        'AC_RUNTIME_MATRIX_COORDINATOR_OUT',
        'coordinator-probe'
      )
    ),
  'send-message-probe': () =>
    readProbe(
      'send-message-probe',
      probe(
        'sendMessage',
        'AC_RUNTIME_MATRIX_SENDMESSAGE_MODEL',
        'AC_RUNTIME_MATRIX_SENDMESSAGE_OUT',
        'send-message-probe'
      )
    )
}

const suites = []
const trials = []
for (const name of options.suites) {
  console.error(`eval:nightly: running ${name}`)
  const suiteTrials = SUITE_RUNNERS[name]()
  suites.push({
    suite: name,
    results: suiteTrials.length > 0,
    ...(apparatusFailures.has(name) ? { apparatusFailed: true } : {})
  })
  trials.push(...suiteTrials)
}

const subjectConfig = readJson(join(env.AGENTCONNECT_EVAL_SUBJECT_ROOT, 'config.json'))
const rootAgent = readJson(
  join(env.AGENTCONNECT_EVAL_SUBJECT_ROOT, 'agents', env.AGENTCONNECT_EVAL_ROOT_AGENT, 'agent.json')
)
const adapter = (subjectConfig?.runtimes?.[rootAgent?.runtime]?.args ?? []).find((arg) => /@[\d.]+$/.test(arg))
const nightly = {
  at,
  durationMs: Date.now() - startedAt,
  commit: env.AGENTCONNECT_EVAL_COMMIT?.trim() || git(['rev-parse', '--verify', 'HEAD']) || 'unknown',
  dirty: (git(['status', '--porcelain=v1', '--untracked-files=normal']) ?? 'unknown').length > 0,
  node: process.version,
  subject:
    [adapter ? adapter.split('/').pop() : rootAgent?.runtime, rootAgent?.runtimeOverrides?.model]
      .filter(Boolean)
      .join(' · ') || 'unknown',
  repeat: options.repeat,
  suites,
  cells: summarizeCells(trials)
}

const markdown = renderMarkdown(nightly)
writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(nightly, null, 2)}\n`)
writeFileSync(join(runDir, 'summary.md'), markdown)
const handoff = renderHandoff(nightly)
if (handoff) {
  writeFileSync(join(runDir, 'handoff.md'), handoff)
  writeFileSync(handoffPath, handoff)
}
process.stdout.write(markdown)
console.error(`eval:nightly: report written to ${join(runDir, 'summary.md')}`)
process.exitCode = needsAttention(nightly) ? 1 : 0
