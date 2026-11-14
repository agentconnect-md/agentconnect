// Runs the installed VS Code against a local daemon AHP host and fails on any request the daemon does not support.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startVsCodeHost, type HostRecord } from './host.js'

const METHOD_NOT_FOUND = -32601
// Refusals VS Code survives: its diagnostics probe, and file watching, without which an open file does not refresh.
const TOLERATED_UNSUPPORTED = new Set(['getNetworkDiagnosticsInfo', 'createResourceWatch'])
// The second default turn writes `docs/notes.txt` and reports the edit as a fragment, as a search-and-replace tool does.
const prompts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['hello from the harness', 'edit a file [ahp:write]']
const browses = prompts.some((prompt) => prompt.includes('[ahp:write]'))
type DriverEntry = {
  step: string
  reason?: string
  message?: string
  entries?: [string, number][]
  size?: number
  document?: string
  refs?: Record<string, string>
}
const code =
  process.env.VSCODE_BIN ??
  ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'].find((path) => existsSync(path)) ??
  'code'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) if (done()) return true
  return done()
}

// A short path: VS Code puts its IPC socket under the profile, and a long one exceeds the socket name limit.
const scratch = mkdtempSync('/tmp/ahp-vsc-')
const profile = join(scratch, 'data')
const workspace = join(scratch, 'workspace')
const driverOut = join(scratch, 'driver.jsonl')
const browsePlan = join(scratch, 'browse.json')
const host = await startVsCodeHost()
let failed = false
try {
  mkdirSync(join(workspace, '.vscode'), { recursive: true })
  writeFileSync(
    join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'chat.workspaceRemoteAgentHosts': [{ name: 'AHP harness', address: host.url }] })
  )
  execFile(
    code,
    [
      `--user-data-dir=${profile}`,
      `--extensions-dir=${join(scratch, 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--extensionDevelopmentPath=${fileURLToPath(new URL('./driver', import.meta.url))}`,
      workspace
    ],
    {
      env: {
        ...process.env,
        AHP_DRIVER_OUT: driverOut,
        AHP_DRIVER_PROMPTS: JSON.stringify(prompts),
        ...(browses ? { AHP_DRIVER_BROWSE: browsePlan } : {})
      }
    }
  )
  const driver = () =>
    existsSync(driverOut)
      ? readFileSync(driverOut, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as DriverEntry)
      : []
  const finished = () => driver().some((entry) => ['done', 'failed', 'error'].includes(entry.step))
  const completed = () =>
    host.records.filter((entry) => entry.dir === 'out' && entry.action === 'chat/turnComplete').length
  await until(finished, 120_000 + prompts.length * 10_000)
  await until(() => completed() >= prompts.length, 30_000)
  await sleep(2000)
  // VS Code reads the workspace and the edit's snapshots only when asked, so the driver asks through VS Code's own filesystem.
  const contentRefs = [
    ...new Set(host.records.flatMap((entry) => (entry.dir === 'out' ? (entry.contentRefs ?? []) : [])))
  ]
  if (browses && completed() >= prompts.length) {
    writeFileSync(browsePlan, JSON.stringify({ workspace: host.workspace(), file: 'docs/notes.txt', contentRefs }))
    await until(() => driver().some((entry) => ['browsed', 'error'].includes(entry.step)), 60_000)
  }
  const browsed = driver().find((entry) => entry.step === 'browsed')
  const side = (name: string) => Object.entries(browsed?.refs ?? {}).find(([ref]) => ref.includes(`/${name}/`))?.[1]

  const requests = new Map<string, Extract<HostRecord, { dir: 'in' }>>()
  const refused: { method: string; code: number; message: string }[] = []
  for (const entry of host.records) {
    if (entry.dir === 'in') requests.set(`${entry.connection}:${entry.id}`, entry)
    else if (entry.error)
      refused.push({ method: requests.get(`${entry.connection}:${entry.id}`)?.method ?? '?', ...entry.error })
  }
  const unsupported = [
    ...new Set(refused.filter((entry) => entry.code === METHOD_NOT_FOUND).map((entry) => entry.method))
  ]
  const logs = join(profile, 'logs')
  const renderer = existsSync(logs)
    ? readdirSync(logs)
        .map((run) => join(logs, run, 'window1', 'renderer.log'))
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n')
    : ''
  const outcomes = [...renderer.matchAll(/\[AgentHostFirstResponse\] \{.*?"outcome":"(\w+)"/g)].map(
    (match) => match[1] ?? '?'
  )
  const checks: [string, boolean, string][] = [
    [
      'driver sent every prompt',
      driver().some((entry) => entry.step === 'done'),
      JSON.stringify(driver().at(-1) ?? null)
    ],
    ['every turn completed', completed() >= prompts.length, `${completed()} of ${prompts.length}`],
    [
      'no unsupported method',
      unsupported.every((method) => TOLERATED_UNSUPPORTED.has(method)),
      unsupported.join(', ') || 'none'
    ],
    ['VS Code reported no chat error', !renderer.includes('Error while handling chat request'), ''],
    ['VS Code reported a successful first response', outcomes.includes('success'), outcomes.join(', ') || 'none']
  ]
  if (browses)
    checks.push(
      [
        'VS Code listed the workspace through its filesystem',
        !!browsed?.entries?.some(([name, type]) => name === 'docs' && type === 2),
        JSON.stringify(browsed?.entries ?? driver().at(-1) ?? null)
      ],
      [
        'VS Code opened a workspace file',
        browsed?.document === 'alpha\nBRAVO\ncharlie\n',
        `${browsed?.size ?? '?'} bytes`
      ],
      [
        'the edit reads back as whole files',
        side('before') === 'alpha\nbravo\ncharlie\n' && side('after') === 'alpha\nBRAVO\ncharlie\n',
        `${contentRefs.length} content refs`
      ]
    )
  const sent = [...new Set(host.records.flatMap((entry) => (entry.dir === 'in' ? [entry.method] : [])))].sort()
  console.log(`\nMethods VS Code sent: ${sent.join(', ')}`)
  const other = refused.filter((entry) => entry.code !== METHOD_NOT_FOUND)
  const tally = new Map<string, number>()
  for (const entry of other)
    tally.set(`${entry.method} → ${entry.message}`, (tally.get(`${entry.method} → ${entry.message}`) ?? 0) + 1)
  if (tally.size) console.log(`Other refusals: ${[...tally].map(([key, count]) => `${key} ×${count}`).join('; ')}`)
  console.log('')
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    failed ||= !ok
  }
} finally {
  // VS Code can outlive a polite stop while it is still starting helpers, so a hard stop follows.
  for (const signal of ['-TERM', '-KILL']) {
    try {
      execFileSync('pkill', [signal, '-f', profile])
    } catch {
      break
    }
    await sleep(2000)
  }
  await host.stop()
  if (!process.env.AHP_HARNESS_KEEP) rmSync(scratch, { recursive: true, force: true })
  else console.log(`\nKept ${scratch}`)
}
process.exit(failed ? 1 : 0)
