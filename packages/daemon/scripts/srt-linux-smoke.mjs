import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('SRT smoke test requires Linux')

const entry = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url)))
if (!isAbsolute(entry)) throw new Error('daemon entry must be absolute')

// SRT creates an internal Unix socket below the private HOME. Keep the fixture
// path short enough for Linux sun_path while placing it under a real host HOME
// that the policy below hides and selectively carves back.
let defaultBase = homedir()
try {
  accessSync(defaultBase, constants.W_OK)
} catch {
  defaultBase = dirname(entry)
  try {
    accessSync(defaultBase, constants.W_OK)
  } catch {
    // Installed package directories may be read-only; overlapping /tmp denies
    // remain a valid fallback and exercise the same carve-back ordering.
    defaultBase = tmpdir()
  }
}
const base = resolve(process.env.AGENTCONNECT_SRT_SMOKE_BASE ?? defaultBase)
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'ac-srt-'))
const sharedTmp = mkdtempSync(join(tmpdir(), 'agentconnect-srt-shared-'))
const sharedVarTmp = mkdtempSync('/var/tmp/agentconnect-srt-shared-')
let orphanProviderPid

try {
  const daemonRoot = join(root, 'daemon')
  const agentDir = join(daemonRoot, 'agents', 'agent-a')
  const siblingAgent = join(daemonRoot, 'agents', 'agent-b')
  const workspace = join(agentDir, 'workspace')
  const home = join(agentDir, 'home')
  const memory = join(agentDir, 'memory')
  const hostHome = join(root, 'host-home')
  const trustedRuntimeCode = join(hostHome, '.local', 'runtime', 'index.js')
  const sharedCredentialDir = join(hostHome, '.claude', 'agentconnect-auth')
  const outside = join(root, 'outside.txt')
  const settingsDir = join(agentDir, '.agentconnect', 'sandbox')
  const settingsPath = join(settingsDir, 'settings.json')

  for (const path of [
    workspace,
    home,
    memory,
    siblingAgent,
    dirname(trustedRuntimeCode),
    sharedCredentialDir,
    settingsDir
  ]) {
    mkdirSync(path, { recursive: true })
  }
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(workspace, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
  writeFileSync(join(agentDir, 'agent.json'), '{"secret":"hidden"}\n')
  writeFileSync(join(daemonRoot, 'daemon-secret.json'), '{"secret":"daemon"}\n')
  writeFileSync(join(siblingAgent, 'agent.json'), '{"secret":"sibling"}\n')
  writeFileSync(join(hostHome, 'host-secret.txt'), 'host secret\n')
  writeFileSync(trustedRuntimeCode, 'trusted runtime code\n')
  writeFileSync(join(sharedCredentialDir, '.credentials.json'), '{"token":"initial"}\n')
  writeFileSync(join(sharedTmp, 'secret.txt'), 'shared tmp\n')
  writeFileSync(join(sharedVarTmp, 'secret.txt'), 'shared var tmp\n')

  const contains = (rootPath, candidate) => {
    const rel = relative(rootPath, candidate)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  const compact = (paths) => {
    const sorted = [...new Set(paths.map((path) => realpathSync(path)))].sort(
      (a, b) => a.length - b.length || a.localeCompare(b)
    )
    return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => contains(parent, path)))
  }
  const denyRead = compact([daemonRoot, hostHome, homedir(), tmpdir(), '/var/tmp'])
  const runtimeBin = realpathSync(dirname(process.execPath))
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        network: { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: true },
        filesystem: {
          denyRead,
          allowRead: [workspace, home, memory, trustedRuntimeCode, sharedCredentialDir, runtimeBin],
          allowWrite: [workspace, home, memory, sharedCredentialDir],
          denyWrite: ['/tmp/claude', '/private/tmp/claude'],
          allowGitConfig: false
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

    const [
      daemonRoot,
      agentDir,
      siblingAgent,
      workspace,
      home,
      hostHome,
      trustedRuntimeCode,
      sharedCredentialDir,
      sharedTmp,
      sharedVarTmp,
      outside
    ] = process.argv.slice(1)
    const assert = (condition, message) => { if (!condition) throw new Error(message) }
    const denied = (operation) => { try { operation(); return false } catch { return true } }

    assert(readFileSync(0, 'utf8') === 'SRT_STDIN', 'provider did not preserve ACP stdin')
    assert(process.env.HOME === home, 'private HOME was not preserved')
    assert(process.env.TMPDIR === home + '/.tmp', 'temporary files were not redirected into private HOME')
    assert(denied(() => readFileSync(agentDir + '/agent.json')), 'agent metadata remained readable')
    assert(denied(() => readFileSync(daemonRoot + '/daemon-secret.json')), 'daemon state remained readable')
    assert(denied(() => readFileSync(siblingAgent + '/agent.json')), 'sibling agent remained readable')
    assert(denied(() => readFileSync(hostHome + '/host-secret.txt')), 'host HOME remained readable')
    assert(denied(() => readFileSync(sharedTmp + '/secret.txt')), 'shared tmp remained readable')
    assert(denied(() => readFileSync(sharedVarTmp + '/secret.txt')), 'shared var tmp remained readable')
    assert(readFileSync(trustedRuntimeCode, 'utf8').trim() === 'trusted runtime code', 'trusted runtime code was hidden')
    writeFileSync(sharedCredentialDir + '/.credentials.json', '{"token":"refreshed"}')
    assert(readFileSync(sharedCredentialDir + '/.credentials.json', 'utf8').includes('refreshed'), 'credential refresh failed')
    writeFileSync(workspace + '/ok.txt', 'ok')
    assert(readFileSync(workspace + '/ok.txt', 'utf8') === 'ok', 'workspace was not writable')
    assert(denied(() => writeFileSync(workspace + '/.git/hooks/post-merge', 'escape')), 'git hooks remained writable')
    assert(denied(() => writeFileSync(workspace + '/.git/config', 'escape')), 'git config remained writable')
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
      workspace,
      '--',
      process.execPath,
      '--input-type=module',
      '-e',
      probe,
      daemonRoot,
      agentDir,
      siblingAgent,
      workspace,
      home,
      hostHome,
      trustedRuntimeCode,
      sharedCredentialDir,
      sharedTmp,
      sharedVarTmp,
      outside
    ],
    {
      // Production providers inherit the daemon's cwd. The explicit trusted
      // workspace argument must anchor SRT's mandatory-deny discovery itself.
      cwd: root,
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
    const child = spawn(process.execPath, [entry, '__sandbox-runtime', settingsPath, String(process.pid), cwd, '--', 'sleep', '30'], {
      cwd: ${JSON.stringify(root)},
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
  rmSync(sharedTmp, { recursive: true, force: true })
  rmSync(sharedVarTmp, { recursive: true, force: true })
}
