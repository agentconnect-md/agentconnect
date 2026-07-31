import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('SRT smoke test requires Linux')

const entry = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url)))
if (!isAbsolute(entry)) throw new Error('daemon entry must be absolute')

const base = resolve(process.env.AGENTCONNECT_SRT_SMOKE_BASE ?? tmpdir())
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'agentconnect-srt-smoke-'))
let orphanProviderPid

try {
  const agentDir = join(root, 'agent')
  const workspace = join(agentDir, 'workspace')
  const home = join(agentDir, 'home')
  const memory = join(agentDir, 'memory')
  const hostState = join(root, 'host', '.claude')
  const outside = join(root, 'outside.txt')
  const settingsDir = join(agentDir, '.agentconnect', 'sandbox')
  const settingsPath = join(settingsDir, 'settings.json')

  for (const path of [workspace, home, memory, hostState, settingsDir]) mkdirSync(path, { recursive: true })
  writeFileSync(join(agentDir, 'agent.json'), '{"secret":"hidden"}\n')
  writeFileSync(join(hostState, '.credentials.json'), '{"secret":"host"}\n')
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        network: { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true },
        filesystem: {
          denyRead: [agentDir, hostState, '/tmp/claude', '/private/tmp/claude'],
          allowRead: [workspace, home, memory],
          allowWrite: [workspace, home, memory],
          denyWrite: ['/tmp/claude', '/private/tmp/claude'],
          allowGitConfig: true
        },
        git: { safeDirectories: [workspace] }
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )

  const probe = `
    import { spawnSync } from 'node:child_process'
    import { readFileSync, writeFileSync } from 'node:fs'
    import { createServer } from 'node:net'

    const [agentDir, workspace, home, hostState, outside] = process.argv.slice(1)
    const assert = (condition, message) => { if (!condition) throw new Error(message) }
    const denied = (operation) => { try { operation(); return false } catch { return true } }

    assert(readFileSync(0, 'utf8') === 'SRT_STDIN', 'provider did not preserve ACP stdin')
    assert(process.env.HOME === home, 'private HOME was not preserved')
    assert(process.env.TMPDIR === home + '/.tmp', 'temporary files were not redirected into private HOME')
    assert(denied(() => readFileSync(agentDir + '/agent.json')), 'agent metadata remained readable')
    assert(denied(() => readFileSync(hostState + '/.credentials.json')), 'host runtime state remained readable')
    writeFileSync(workspace + '/ok.txt', 'ok')
    assert(readFileSync(workspace + '/ok.txt', 'utf8') === 'ok', 'workspace was not writable')
    assert(denied(() => writeFileSync(outside, 'escape')), 'outside path was writable')

    const socketPath = home + '/compat.sock'
    const server = createServer()
    await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve))
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

    const curl = spawnSync('curl', ['-fsS', 'https://example.com'], { stdio: 'ignore' })
    assert(curl.status === 0, 'allow-all network compatibility failed')
    console.log('SRT_LINUX_SMOKE_OK')
  `

  // Keep an intermediate launcher alive between the daemon owner and the SRT
  // provider. Source builds use the same shape because tsx launches the entry
  // script in a child process.
  const providerLauncher = `
    import { spawnSync } from 'node:child_process'
    const result = spawnSync(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    })
    process.exit(result.status ?? 1)
  `
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      providerLauncher,
      entry,
      '__sandbox-runtime',
      settingsPath,
      String(process.pid),
      '--',
      process.execPath,
      '--input-type=module',
      '-e',
      probe,
      agentDir,
      workspace,
      home,
      hostState,
      outside
    ],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      input: 'SRT_STDIN',
      encoding: 'utf8',
      timeout: 30_000
    }
  )

  if (result.status !== 0 || !result.stdout.includes('SRT_LINUX_SMOKE_OK')) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`SRT smoke test failed with status ${result.status ?? 'null'}`)
  }

  const orphanLauncher = `
    import { spawn } from 'node:child_process'
    const [entry, settingsPath, cwd] = process.argv.slice(1)
    const child = spawn(process.execPath, [entry, '__sandbox-runtime', settingsPath, String(process.pid), '--', 'sleep', '30'], {
      cwd,
      env: process.env,
      stdio: 'ignore'
    })
    if (!child.pid) process.exit(2)
    process.stdout.write(String(child.pid))
    child.unref()
  `
  const orphanOwner = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', orphanLauncher, entry, settingsPath, workspace],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5_000 }
  )
  orphanProviderPid = Number(orphanOwner.stdout.trim())
  if (orphanOwner.status !== 0 || !Number.isSafeInteger(orphanProviderPid)) {
    throw new Error(`failed to launch orphan-cleanup probe: ${orphanOwner.stderr}`)
  }
  const providerAlive = () => {
    try {
      const state = /\)\s+([A-Z])\s/.exec(readFileSync(`/proc/${orphanProviderPid}/stat`, 'utf8'))?.[1]
      return state !== undefined && state !== 'Z'
    } catch {
      return false
    }
  }
  const cleanupDeadline = Date.now() + 5_000
  while (providerAlive() && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (providerAlive()) throw new Error('SRT provider survived its daemon owner')
  orphanProviderPid = undefined
  process.stdout.write('SRT Linux smoke test passed\n')
} finally {
  if (orphanProviderPid) {
    try {
      process.kill(orphanProviderPid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  rmSync(root, { recursive: true, force: true })
}
