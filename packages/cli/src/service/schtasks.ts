/** Windows controller: a per-user Task Scheduler task starts the CLI's `service-run` host headless at the operator's logon. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, win32 } from 'node:path'
import { liveDaemonPid, pidAlive } from '../daemon-live.js'
import { daemonLogPath, defaultRoot, logsDir, serviceRunPidPath } from '../paths.js'
import type { ControllerDeps, InstalledUnit, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const DEFAULT_TASK = 'AgentConnectDaemon'
const TASK_FILE_PATTERN = /^AgentConnectDaemon(?:-([a-z0-9][a-z0-9_-]*))?\.xml$/

/** `AgentConnectDaemon` for the default instance, `AgentConnectDaemon-<name>` for a named one. */
export function scheduledTaskName(instance?: string): string {
  return instance ? `${DEFAULT_TASK}-${instance}` : DEFAULT_TASK
}

/** Where each registered definition is kept: the file discovery reads synchronously, as a plist is on macOS. */
export function scheduledTasksDir(home: string): string {
  return join(home, 'AppData', 'Local', 'AgentConnect', 'services')
}

/** The root a written task runs against, from the `--root` baked into its command line. */
export function parseTaskRoot(xml: string): string {
  const arg = /--root "([^"]*)"/.exec(xml)?.[1]
  return arg ? unxml(arg) : defaultRoot()
}

/** Every AgentConnect logon task this account installed, default instance first. */
export function scanScheduledTasks(home: string): InstalledUnit[] {
  const dir = scheduledTasksDir(home)
  if (!existsSync(dir)) return []
  const found: InstalledUnit[] = []
  for (const name of readdirSync(dir).sort()) {
    const match = TASK_FILE_PATTERN.exec(name)
    if (!match) continue
    const unitPath = join(dir, name)
    let text = ''
    try {
      text = readTaskXml(unitPath)
    } catch {
      continue // unreadable definition — nothing useful to report about it
    }
    found.push({
      ...(match[1] ? { instance: match[1] } : {}),
      label: name.replace(/\.xml$/, ''),
      unitPath,
      root: parseTaskRoot(text),
      scope: 'user'
    })
  }
  return found.sort((a, b) => (a.instance ?? '').localeCompare(b.instance ?? ''))
}

function xml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unxml(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// One CommandLineToArgvW token, always quoted so the root can be read back; conhost re-quotes what it forwards.
function winArg(value: string): string {
  if (/["\r\n]/.test(value) || value.endsWith('\\')) {
    throw new Error(`a scheduled task cannot carry the path ${JSON.stringify(value)}`)
  }
  return `"${value}"`
}

/** The command line conhost runs: the CLI's `service-run` host for this root. */
export function buildTaskArguments(a: { execPath: string; cliEntry: string; root: string }): string {
  return `${winArg(a.execPath)} ${winArg(a.cliEntry)} service-run --root ${winArg(a.root)}`
}

/** Task Scheduler XML for a logon task that runs `commandLine` under a windowless console as `userId`. */
export function buildTaskXml(a: {
  userId: string
  commandLine: string
  workingDirectory: string
  description: string
  systemRoot: string
}): string {
  const system32 = win32.join(a.systemRoot, 'System32')
  // conhost --headless gives node a console with no window, so nothing pops up at logon.
  const args = `--headless ${a.commandLine}`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(a.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(a.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(a.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(win32.join(system32, 'conhost.exe'))}</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(a.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** `DOMAIN\user` for the signed-in account, the form a LogonTrigger and Principal name. */
export function windowsUserId(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME ?? userInfo().username
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user
}

// schtasks /XML reads UTF-16; the BOM makes that unambiguous.
function writeTaskXml(path: string, text: string): void {
  writeFileSync(path, `\ufeff${text}`, 'utf16le')
}

function readTaskXml(path: string): string {
  return readFileSync(path, 'utf16le').replace(/^\ufeff/, '')
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export class ScheduledTaskController implements ServiceController {
  readonly label: string
  private readonly xmlPath: string

  constructor(
    private readonly deps: ControllerDeps,
    private readonly startup: { timeoutMs: number; pollMs: number } = { timeoutMs: 30_000, pollMs: 250 }
  ) {
    this.label = scheduledTaskName(deps.instance)
    this.xmlPath = join(scheduledTasksDir(deps.home), `${this.label}.xml`)
  }

  isInstalled(): boolean {
    return existsSync(this.xmlPath)
  }

  async install(opts: InstallOpts): Promise<void> {
    mkdirSync(logsDir(this.deps.root), { recursive: true })
    mkdirSync(scheduledTasksDir(this.deps.home), { recursive: true })
    if (!opts.cliEntry) throw new Error('a Windows logon task runs the CLI itself, so it needs the CLI entry')
    const commandLine = buildTaskArguments({ execPath: opts.execPath, cliEntry: opts.cliEntry, root: this.deps.root })
    writeTaskXml(
      this.xmlPath,
      buildTaskXml({
        userId: windowsUserId(),
        commandLine,
        workingDirectory: this.deps.home,
        description: this.deps.instance ? `AgentConnect daemon (${this.deps.instance})` : 'AgentConnect daemon',
        systemRoot: process.env.SystemRoot ?? 'C:\\Windows'
      })
    )
    // /F overwrites, so a re-install rewrites an existing task in place.
    const r = await this.deps.exec('schtasks.exe', ['/Create', '/TN', this.label, '/XML', this.xmlPath, '/F'])
    if (r.code !== 0) {
      rmSync(this.xmlPath, { force: true })
      throw new Error(`schtasks could not register ${this.label}: ${(r.stderr || r.stdout).trim()}`)
    }
  }

  async uninstall(): Promise<void> {
    try {
      await this.down()
    } catch {
      // not running — fine
    }
    const r = await this.deps.exec('schtasks.exe', ['/Delete', '/TN', this.label, '/F'])
    // Only a task that is still registered is a failure; the error text itself is localized.
    if (r.code !== 0 && (await this.deps.exec('schtasks.exe', ['/Query', '/TN', this.label])).code === 0) {
      throw new Error(`schtasks could not remove ${this.label}: ${(r.stderr || r.stdout).trim()}`)
    }
    rmSync(this.xmlPath, { force: true })
  }

  async up(): Promise<void> {
    const r = await this.deps.exec('schtasks.exe', ['/Run', '/TN', this.label])
    if (r.code !== 0) throw new Error(`schtasks could not start ${this.label}: ${(r.stderr || r.stdout).trim()}`)
    await this.awaitStartup()
  }

  // `/Run` returns before the host and daemon write their pids; a timeout is left for the caller's health check to judge.
  private async awaitStartup(): Promise<void> {
    const deadline = Date.now() + this.startup.timeoutMs
    while (Date.now() < deadline) {
      if ((await this.status()).pid !== undefined) return
      await new Promise((r) => setTimeout(r, this.startup.pollMs))
    }
  }

  /** Ending a task leaves its children running, so the host's tree is killed first, and the daemon's if it outlived it. */
  async down(): Promise<void> {
    const pidFile = serviceRunPidPath(this.deps.root)
    for (const pid of [readPid(pidFile), liveDaemonPid(this.deps.root) ?? undefined]) {
      if (pid === undefined || !pidAlive(pid) || !(await this.ownsProcess(pid))) continue
      const r = await this.deps.exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
      if (r.code !== 0 && pidAlive(pid)) {
        throw new Error(`taskkill could not stop pid ${pid}: ${(r.stderr || r.stdout).trim()}`)
      }
    }
    await this.deps.exec('schtasks.exe', ['/End', '/TN', this.label]) // fails harmlessly when nothing runs
    rmSync(pidFile, { force: true })
  }

  async status(): Promise<ServiceStatus> {
    const logPath = daemonLogPath(this.deps.root)
    if (!this.isInstalled()) return { installed: false, running: false, label: this.label, logPath }
    // The pid files, not schtasks /Query, whose status column is localized.
    const shell = readPid(serviceRunPidPath(this.deps.root))
    const running = shell !== undefined && pidAlive(shell)
    const daemon = running ? liveDaemonPid(this.deps.root) : null
    return { installed: true, running, ...(daemon ? { pid: daemon } : {}), label: this.label, logPath }
  }

  /** A stale pid file must never aim `taskkill /T /F` at a reused pid: the process must name this root. */
  private async ownsProcess(pid: number): Promise<boolean> {
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
    const r = await this.deps.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return r.code === 0 && r.stdout.toLowerCase().includes(this.deps.root.toLowerCase())
  }
}
