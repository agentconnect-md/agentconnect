// The Windows service: a LocalSystem service runs the daemon as SYSTEM in the console session, which can reach UAC prompts.
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const SERVICE_NAME = 'AgentConnectComputer'
const DISPLAY_NAME = 'AgentConnect Computer'
// The service host sets this in the daemon's environment to its own path, which also runs `run-as-user`.
export const SERVICE_HOST_ENV = 'AGENTCONNECT_COMPUTER_WINDOWS_SERVICE'
// Custom control 128: start the daemon again after the menu's Quit, without restarting the service.
const RESUME_CONTROL = '128'
const ADMINISTRATORS = 'S-1-5-32-544'
const SYSTEM = 'S-1-5-18'

// scripts/bundle.mjs inlines windows/*.cs; a source checkout (tsx, vitest) reads them beside src.
declare const __AGENTCONNECT_COMPUTER_WINDOWS_SOURCES__: Record<string, string> | undefined
const csharp = (name: 'service.cs' | 'tray.cs' | 'admin-prompts.cs'): string =>
  typeof __AGENTCONNECT_COMPUTER_WINDOWS_SOURCES__ === 'object'
    ? __AGENTCONNECT_COMPUTER_WINDOWS_SOURCES__[name]!
    : readFileSync(new URL(`../windows/${name}`, import.meta.url), 'utf8')

const programFiles = (): string => process.env.ProgramFiles ?? 'C:\\Program Files'
// Binaries only an administrator can replace, since SYSTEM runs them.
export const installDir = (): string => join(programFiles(), 'AgentConnect', 'Computer')
export const trayHelperPath = (): string => join(installDir(), 'agentconnect-computer-tray.exe')
// Watches for UAC prompts on the secure desktop and answers them; only a SYSTEM process can reach that desktop.
export const adminPromptHelperPath = (): string => join(installDir(), 'agentconnect-computer-admin-prompts.exe')
const hostPath = (): string => join(installDir(), 'agentconnect-computer-service.exe')
const installedNode = (): string => join(installDir(), 'node.exe')
const installedEntry = (): string => join(installDir(), 'agentconnect-computer.mjs')
// Files `setup` wrote to the per-user data dir before the service took over.
const MIGRATED = ['config.json', 'computer-key.json', 'client-token', 'versions.json']

// The service host running this daemon, when it runs under the service.
export const serviceHost = (): string | undefined => process.env[SERVICE_HOST_ENV]?.trim() || undefined

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const sc = (...args: string[]) => run('sc.exe', args)

// High or System integrity: the process holds an administrator token.
export function isElevated(): boolean {
  const groups = run('whoami.exe', ['/groups']).output
  return /S-1-16-12288|S-1-16-16384/.test(groups)
}

export const userSid = (): string | undefined =>
  /"(S-1-[\d-]+)"/.exec(run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).output)?.[1]

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`
// A batch file argument: quoted, with % doubled; cmd.exe has no escape for a double quote inside quotes.
const cmdQuote = (value: string): string => {
  if (value.includes('"')) throw new Error(`cannot pass ${value} through cmd.exe`)
  return `"${value.replace(/%/g, '%%')}"`
}
const encoded = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')

// Runs `node <entry> ...args` elevated (one UAC prompt), streaming its output; `env` is passed, since elevation starts afresh.
export async function runElevated(
  entry: string,
  args: string[],
  env: Record<string, string>,
  write: (text: string) => void = (text) => process.stdout.write(text)
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'agentconnect-computer-'))
  const log = join(dir, 'elevated.log')
  const code = join(dir, 'exit-code')
  const batch = join(dir, 'elevated.cmd')
  writeFileSync(log, '')
  // Through cmd, so the output reaches the log as the bytes Node wrote (PowerShell 5 would re-encode it as UTF-16).
  writeFileSync(
    batch,
    `@${[process.execPath, entry, ...args].map(cmdQuote).join(' ')} >> ${cmdQuote(log)} 2>&1\r\n@exit /b %ERRORLEVEL%\r\n`
  )
  const inner = [
    ...Object.entries(env).map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
    `& cmd.exe /d /c ${psQuote(batch)}`,
    `Set-Content -LiteralPath ${psQuote(code)} -Value $LASTEXITCODE`
  ].join('\n')
  const outer = `$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(inner)}'
if (-not $p) { exit 1 }
$p.WaitForExit()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outer)], {
    stdio: 'ignore',
    windowsHide: true
  })
  let offset = 0
  const drain = (): void => {
    const text = readFileSync(log)
    if (text.length > offset) write(text.subarray(offset).toString('utf8'))
    offset = text.length
  }
  const timer = setInterval(drain, 500)
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  clearInterval(timer)
  drain()
  const exit = existsSync(code) ? Number(readFileSync(code, 'utf8').trim()) : NaN
  rmSync(dir, { recursive: true, force: true })
  if (Number.isNaN(exit)) throw new Error('the administrator prompt was declined, so nothing was changed')
  return exit
}

// .NET Framework 4's compiler ships with every Windows 10 and 11, so the service and tray build on the machine itself.
function compiler(): string {
  const windir = process.env.SystemRoot ?? 'C:\\Windows'
  const found = ['Framework64', 'Framework']
    .map((framework) => join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
    .find(existsSync)
  if (!found)
    throw new Error(
      'the .NET Framework 4 compiler (csc.exe) is missing; turn on .NET Framework 4.8 in Windows Features'
    )
  return found
}

function compile(source: string, out: string, target: 'exe' | 'winexe', references: string[] = []): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentconnect-computer-build-'))
  try {
    const file = join(dir, 'source.cs')
    writeFileSync(file, source)
    const result = run(compiler(), [
      '/nologo',
      '/optimize+',
      `/target:${target}`,
      // UI Automation ships with WPF, beside the compiler.
      `/lib:${join(dirname(compiler()), 'WPF')}`,
      ...references.map((reference) => `/r:${reference}`),
      `/out:${join(dir, 'out.exe')}`,
      file
    ])
    if (!result.ok) throw new Error(`csc failed to build ${out}: ${result.output}`)
    copyFileSync(join(dir, 'out.exe'), out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The person may read the service's data (their key, logs, token), never change what SYSTEM runs.
function secureHome(home: string, sid: string | undefined): void {
  mkdirSync(home, { recursive: true })
  const grants = [`*${SYSTEM}:(OI)(CI)F`, `*${ADMINISTRATORS}:(OI)(CI)F`, ...(sid ? [`*${sid}:(OI)(CI)RX`] : [])]
  const result = run('icacls.exe', [home, '/inheritance:r', '/grant:r', ...grants, '/Q'])
  if (!result.ok) throw new Error(`icacls failed on ${home}: ${result.output}`)
  // What setup already wrote inherits the directory's grants instead of keeping the person's write access.
  const children = run('icacls.exe', [join(home, '*'), '/reset', '/T', '/C', '/Q'])
  if (!children.ok) throw new Error(`icacls failed on ${home}\\*: ${children.output}`)
}

// Copies the per-user setup into the service's data dir once; later runs keep the service's own copy.
export function migrateUserData(from: string, home: string, log: (line: string) => void): void {
  if (from === home || !existsSync(join(from, 'config.json')) || existsSync(join(home, 'config.json'))) return
  mkdirSync(home, { recursive: true })
  for (const name of MIGRATED.filter((file) => existsSync(join(from, file))))
    copyFileSync(join(from, name), join(home, name))
  log(`Moved the configuration from ${from} to ${home}, where only administrators can change it.`)
}

export interface ServiceStatus {
  installed: boolean
  loaded: boolean
  pid?: number
  state?: string
  startAtLogin?: boolean
}

export function serviceStatus(): ServiceStatus {
  const query = sc('queryex', SERVICE_NAME)
  if (!query.ok) return { installed: false, loaded: false }
  const state = /STATE\s+:\s+\d+\s+(\w+)/.exec(query.output)?.[1]
  const pid = Number(/PID\s+:\s+(\d+)/.exec(query.output)?.[1] ?? 0)
  return {
    installed: true,
    loaded: state === 'RUNNING',
    ...(pid ? { pid } : {}),
    ...(state ? { state } : {}),
    startAtLogin: startsAtLogin()
  }
}

export const startsAtLogin = (): boolean => /START_TYPE\s+:\s+2\s/.test(sc('qc', SERVICE_NAME).output)

export function setStartAtLogin(on: boolean): void {
  const result = sc('config', SERVICE_NAME, 'start=', on ? 'auto' : 'demand')
  if (!result.ok) throw new Error(`sc config failed: ${result.output}`)
}

function waitFor(state: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serviceStatus().state === state) return true
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true })
  }
  return false
}

// Starts the service, or the daemon in a running service after the menu's Quit.
export function startService(): void {
  const status = serviceStatus()
  if (!status.installed)
    throw new Error(`the ${SERVICE_NAME} service is not installed; run: agentconnect computer setup`)
  const result = status.loaded ? sc('control', SERVICE_NAME, RESUME_CONTROL) : sc('start', SERVICE_NAME)
  if (!result.ok) throw new Error(`sc ${status.loaded ? 'control' : 'start'} failed: ${result.output}`)
}

export function stopService(): void {
  const status = serviceStatus()
  if (!status.loaded) return
  const result = sc('stop', SERVICE_NAME)
  if (!result.ok && !/1062/.test(result.output)) throw new Error(`sc stop failed: ${result.output}`)
  if (!waitFor('STOPPED', 30_000)) throw new Error(`the ${SERVICE_NAME} service did not stop`)
}

export function restartService(): void {
  stopService()
  startService()
}

export interface WindowsServicePlan {
  // The daemon bundle and the Node that runs it, copied into the install dir.
  entry: string
  node: string
  home: string
  log: (line: string) => void
}

// Run elevated: build the helpers, copy the runtime, register the service and start it.
export function installService(plan: WindowsServicePlan): void {
  const { log } = plan
  stopService()
  const dir = installDir()
  mkdirSync(dir, { recursive: true })
  log(`Building the service, the taskbar helper and the administrator prompt helper in ${dir} (csc).`)
  compile(csharp('service.cs'), hostPath(), 'exe', ['System.ServiceProcess.dll'])
  compile(csharp('tray.cs'), trayHelperPath(), 'winexe', [
    'System.Windows.Forms.dll',
    'System.Drawing.dll',
    'System.Web.Extensions.dll'
  ])
  compile(csharp('admin-prompts.cs'), adminPromptHelperPath(), 'exe', [
    'System.Web.Extensions.dll',
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll',
    'WindowsBase.dll'
  ])
  if (plan.node !== installedNode()) copyFileSync(plan.node, installedNode())
  if (plan.entry !== installedEntry()) copyFileSync(plan.entry, installedEntry())
  const legal = `${plan.entry}.LEGAL.txt`
  if (existsSync(legal)) copyFileSync(legal, `${installedEntry()}.LEGAL.txt`)

  const sid = userSid()
  secureHome(plan.home, sid)
  const binPath = [hostPath(), '--node', installedNode(), '--entry', installedEntry(), '--home', plan.home]
    .map((arg) => `"${arg}"`)
    .join(' ')
  const exists = sc('query', SERVICE_NAME).ok
  // Reinstalling keeps the service, so a person's Start at Sign-in choice resets to on, as on a first install.
  const result = sc(
    exists ? 'config' : 'create',
    SERVICE_NAME,
    'binPath=',
    binPath,
    'start=',
    'auto',
    'obj=',
    'LocalSystem',
    'DisplayName=',
    DISPLAY_NAME
  )
  if (!result.ok) throw new Error(`sc ${exists ? 'config' : 'create'} failed: ${result.output}`)
  sc(
    'description',
    SERVICE_NAME,
    'Lets AgentConnect agents use this computer, including its administrator (UAC) prompts.'
  )
  sc('failure', SERVICE_NAME, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000')
  // The installing person may start, stop and query it without another administrator prompt.
  if (sid) {
    const sddl = `D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWRPWPDTLOCRRC;;;${sid})`
    const set = sc('sdset', SERVICE_NAME, sddl)
    if (!set.ok) log(`Could not let you start and stop the service without an administrator prompt: ${set.output}`)
  }
  log(`Installed the ${SERVICE_NAME} service; it runs the daemon as SYSTEM in whoever is signed in at the console.`)
  startService()
}

// Run elevated: removes the service and its binaries; data stays unless purged.
export function uninstallService(home: string, purge: boolean, log: (line: string) => void): void {
  if (sc('query', SERVICE_NAME).ok) {
    stopService()
    const result = sc('delete', SERVICE_NAME)
    if (!result.ok) throw new Error(`sc delete failed: ${result.output}`)
    log(`Removed the ${SERVICE_NAME} service.`)
  }
  rmSync(installDir(), { recursive: true, force: true })
  if (purge) rmSync(home, { recursive: true, force: true })
}

// From the SYSTEM daemon: a program for the person signed in to this session, through the service host.
export function spawnAsUser(
  command: string,
  args: string[],
  options: { detach?: boolean; stderr?: 'pipe' | 'inherit' } = {}
): ChildProcess {
  const host = serviceHost()
  const stdio: StdioOptions = options.detach ? 'ignore' : ['pipe', 'pipe', options.stderr ?? 'inherit']
  if (!host) return spawn(command, args, { stdio, detached: options.detach, windowsHide: true })
  return spawn(host, ['run-as-user', ...(options.detach ? ['--detach'] : []), command, ...args], {
    stdio,
    windowsHide: true
  })
}

// Starts an app as the signed-in person: an .exe path, a name Windows resolves (notepad, msedge), or a Start menu entry.
export function launchScript(app: string): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$app = ${psQuote(app)}
try {
  try { $p = Start-Process -FilePath $app -PassThru; "launched $app (pid $($p.Id))"; exit 0 }
  catch { if ($app -match '[\\\\/]') { throw } }
  $s = Get-StartApps | Where-Object { $_.Name -eq $app } | Select-Object -First 1
  if (-not $s) { $s = Get-StartApps | Where-Object { $_.Name -like "*$app*" } | Select-Object -First 1 }
  if (-not $s) { throw "no app or Start menu entry named $app" }
  Start-Process "shell:AppsFolder\\$($s.AppID)"
  "launched $($s.Name) from the Start menu"
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
}

// PowerShell wraps progress records on a redirected stderr in CLIXML around the message.
export const withoutClixml = (text: string): string =>
  text
    .replace(/^#< CLIXML\s*/m, '')
    .replace(/<Objs[\s\S]*<\/Objs>/g, '')
    .trim()

export function launchAsUser(app: string, timeoutMs = 30_000): Promise<string> {
  const child = spawnAsUser(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded(launchScript(app))],
    { stderr: 'pipe' }
  )
  child.stdin?.end()
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(withoutClixml(stderr) || stdout.trim() || `launch exited with code ${code}`))
    })
  })
}
