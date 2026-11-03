import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTaskArguments,
  buildTaskXml,
  parseTaskRoot,
  scanScheduledTasks,
  scheduledTaskName,
  scheduledTasksDir,
  ScheduledTaskController,
  windowsUserId
} from '../src/service/schtasks.js'
import { listInstances } from '../src/service/discover.js'
import { nextRespawnDelay } from '../src/service-host.js'
import type { Exec, ExecResult } from '../src/service/types.js'

type Reply = Partial<ExecResult> | ((args: string[]) => Partial<ExecResult>)

function fakeExec(replies: Record<string, Reply> = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const reply = replies[`${cmd} ${args[0]}`] ?? replies[cmd] ?? {}
    return { code: 0, stdout: '', stderr: '', ...(typeof reply === 'function' ? reply(args) : reply) }
  }
  return { exec, calls }
}

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
// A pid no process holds on either platform, for a stale pid file.
const DEAD_PID = 2147483646

function controller(replies: Record<string, Reply> = {}, instance?: string, startupTimeoutMs = 0) {
  const home = tmp('ac-home-')
  const root = tmp('ac-root-')
  const fake = fakeExec(replies)
  const c = new ScheduledTaskController(
    { root, home, uid: 0, exec: fake.exec, ...(instance ? { instance } : {}) },
    { timeoutMs: startupTimeoutMs, pollMs: 5 }
  )
  return { c, home, root, ...fake }
}

const opts = { execPath: 'C:\\Program Files\\nodejs\\node.exe', includeRootEnv: false, cliEntry: 'C:\\cli\\index.js' }

describe('buildTaskArguments', () => {
  it('quotes every path and runs the service-run host for the root', () => {
    expect(
      buildTaskArguments({
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        cliEntry: 'C:\\npm\\cli\\dist\\index.js',
        root: 'C:\\Users\\张三\\.agentconnect'
      })
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\cli\\dist\\index.js" service-run --root "C:\\Users\\张三\\.agentconnect"'
    )
  })

  it('refuses a path that cannot survive a command line', () => {
    expect(() => buildTaskArguments({ execPath: 'node', cliEntry: 'a"b', root: 'C:\\r' })).toThrow(/cannot carry/)
    expect(() => buildTaskArguments({ execPath: 'node', cliEntry: 'C:\\cli', root: 'D:\\' })).toThrow(/cannot carry/)
  })
})

describe('buildTaskXml', () => {
  const xml = buildTaskXml({
    userId: 'HOST\\dev',
    commandLine: buildTaskArguments({
      execPath: 'C:\\node.exe',
      cliEntry: 'C:\\cli.js',
      root: 'C:\\R&D\\.agentconnect'
    }),
    workingDirectory: 'C:\\Users\\dev',
    description: 'AgentConnect daemon',
    systemRoot: 'C:\\Windows'
  })

  it("starts at this account's logon with its own unelevated token", () => {
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>HOST\\dev<\/UserId>/)
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  })

  it('never times out, ignores battery state, and runs one instance at normal priority', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<Priority>4</Priority>')
    // A restart-on-failure would undo `down`, whose kill reads as a failure; the host respawns instead.
    expect(xml).not.toContain('RestartOnFailure')
  })

  it('runs the host under a windowless console, XML-escaped', () => {
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>')
    expect(xml).toContain(
      '<Arguments>--headless "C:\\node.exe" "C:\\cli.js" service-run --root "C:\\R&amp;D\\.agentconnect"</Arguments>'
    )
  })

  it('round-trips the root through parseTaskRoot', () => {
    expect(parseTaskRoot(xml)).toBe('C:\\R&D\\.agentconnect')
  })
})

describe('windowsUserId', () => {
  it('names DOMAIN\\user, or the bare user without a domain', () => {
    expect(windowsUserId({ USERDOMAIN: 'HOST', USERNAME: 'dev' })).toBe('HOST\\dev')
    expect(windowsUserId({ USERNAME: 'dev' })).toBe('dev')
  })
})

describe('ScheduledTaskController install / discovery', () => {
  it('registers the task from a UTF-16 definition the lister reads back', async () => {
    const { c, home, root, calls } = controller({}, 'dev')
    expect(c.isInstalled()).toBe(false)
    await c.install(opts)
    const file = join(scheduledTasksDir(home), 'AgentConnectDaemon-dev.xml')
    expect(calls).toEqual([['schtasks.exe', '/Create', '/TN', 'AgentConnectDaemon-dev', '/XML', file, '/F']])
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(c.isInstalled()).toBe(true)
    expect(existsSync(join(root, 'logs'))).toBe(true)
    expect(scanScheduledTasks(home)).toEqual([
      { instance: 'dev', label: 'AgentConnectDaemon-dev', unitPath: file, root, scope: 'user' }
    ])
    expect(listInstances({ home, platform: 'win32' }).map((u) => u.label)).toEqual(['AgentConnectDaemon-dev'])
  })

  it('leaves nothing behind when schtasks refuses the definition', async () => {
    const { c } = controller({ 'schtasks.exe /Create': { code: 1, stderr: 'ERROR: Access is denied.' } })
    await expect(c.install(opts)).rejects.toThrow(/Access is denied/)
    expect(c.isInstalled()).toBe(false)
  })

  it('needs the CLI entry the task runs', async () => {
    const { c } = controller()
    await expect(c.install({ execPath: 'node', includeRootEnv: false })).rejects.toThrow(/CLI entry/)
  })

  it('names the default task without a suffix', () => {
    expect(scheduledTaskName()).toBe('AgentConnectDaemon')
  })
})

describe('ScheduledTaskController lifecycle', () => {
  it('up runs the task and surfaces a refusal', async () => {
    const ok = controller()
    await ok.c.up()
    expect(ok.calls).toEqual([['schtasks.exe', '/Run', '/TN', 'AgentConnectDaemon']])
    const refused = controller({
      'schtasks.exe /Run': { code: 1, stderr: 'ERROR: The system cannot find the file specified.' }
    })
    await expect(refused.c.up()).rejects.toThrow(/could not start/)
  })

  it('up waits for the daemon pid, so an upgrade health check does not sample a task still starting', async () => {
    const ctx = { root: '' }
    const started = controller(
      {
        'schtasks.exe /Run': () => {
          setTimeout(() => {
            writeFileSync(join(ctx.root, 'service.pid'), `${process.pid}\n`)
            writeFileSync(join(ctx.root, 'daemon.lock'), `${process.pid}\n`)
          }, 50)
          return {}
        }
      },
      undefined,
      5_000
    )
    ctx.root = started.root
    await started.c.install(opts)
    await started.c.up()
    expect(await started.c.status()).toMatchObject({ running: true, pid: process.pid })
  })

  it('up gives up quietly at its deadline and leaves the verdict to the caller', async () => {
    const { c } = controller({}, undefined, 30)
    await c.install(opts)
    await c.up()
    expect(await c.status()).toMatchObject({ installed: true, running: false })
  })

  it('status reads the host pid file and reports the daemon pid', async () => {
    const { c, root } = controller()
    expect((await c.status()).installed).toBe(false)
    await c.install(opts)
    expect(await c.status()).toMatchObject({ installed: true, running: false })
    writeFileSync(join(root, 'service.pid'), `${process.pid}\n`)
    writeFileSync(join(root, 'daemon.lock'), `${process.pid}\n`)
    expect(await c.status()).toMatchObject({ installed: true, running: true, pid: process.pid })
    writeFileSync(join(root, 'service.pid'), `${DEAD_PID}\n`)
    expect((await c.status()).running).toBe(false)
  })

  it("down kills the host's tree when the process names this root, then ends the task", async () => {
    let root = ''
    const { c, calls, ...rest } = controller({
      'powershell.exe': () => ({ stdout: `"node.exe" "cli" service-run --root "${root}"\r\n` })
    })
    root = rest.root
    writeFileSync(join(root, 'service.pid'), `${process.pid}\n`)
    await c.down()
    expect(calls.filter(([cmd]) => cmd !== 'powershell.exe')).toEqual([
      ['taskkill.exe', '/PID', String(process.pid), '/T', '/F'],
      ['schtasks.exe', '/End', '/TN', 'AgentConnectDaemon']
    ])
    expect(existsSync(join(root, 'service.pid'))).toBe(false)
  })

  it('down never kills a reused pid that belongs to another process', async () => {
    const { c, root, calls } = controller({ 'powershell.exe': { stdout: '"C:\\Program Files\\Code\\Code.exe"\r\n' } })
    writeFileSync(join(root, 'service.pid'), `${process.pid}\n`)
    await c.down()
    expect(calls.some(([cmd]) => cmd === 'taskkill.exe')).toBe(false)
  })

  it('down skips a dead pid without asking who holds it', async () => {
    const { c, root, calls } = controller()
    writeFileSync(join(root, 'service.pid'), `${DEAD_PID}\n`)
    await c.down()
    expect(calls).toEqual([['schtasks.exe', '/End', '/TN', 'AgentConnectDaemon']])
  })

  it('uninstall deletes the task and its definition', async () => {
    const { c, calls } = controller()
    await c.install(opts)
    await c.uninstall()
    expect(calls.at(-1)).toEqual(['schtasks.exe', '/Delete', '/TN', 'AgentConnectDaemon', '/F'])
    expect(c.isInstalled()).toBe(false)
  })

  it('uninstall keeps the definition when the task is still registered', async () => {
    const { c } = controller({ 'schtasks.exe /Delete': { code: 1, stderr: 'ERROR: Access is denied.' } })
    await c.install(opts)
    await expect(c.uninstall()).rejects.toThrow(/could not remove/)
    expect(c.isInstalled()).toBe(true)
  })

  it('uninstall tolerates a task someone already deleted', async () => {
    const { c } = controller({
      'schtasks.exe /Delete': { code: 1 },
      'schtasks.exe /Query': { code: 1 }
    })
    await c.install(opts)
    await c.uninstall()
    expect(c.isInstalled()).toBe(false)
  })
})

describe('nextRespawnDelay', () => {
  it('doubles from 3 s up to a minute, and starts over after a healthy run', () => {
    expect(nextRespawnDelay(undefined, 0)).toBe(3_000)
    expect(nextRespawnDelay(3_000, 1_000)).toBe(6_000)
    expect(nextRespawnDelay(48_000, 1_000)).toBe(60_000)
    expect(nextRespawnDelay(60_000, 1_000)).toBe(60_000)
    expect(nextRespawnDelay(60_000, 60_000)).toBe(3_000)
  })
})
