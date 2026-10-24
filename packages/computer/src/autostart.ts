import { spawn, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'AgentConnectComputer'

const launcherPath = (dataDir: string): string => join(dataDir, 'start-desktop-daemon.cmd')

// The per-user Run key starts the daemon in the interactive session at logon without admin rights; a service would land in Session 0.
export function enableAutostart(dataDir: string, script: string): void {
  assertWindows()
  writeFileSync(
    launcherPath(dataDir),
    `@echo off\r\ntitle AgentConnect Computer\r\n"${process.execPath}" "${script}" run\r\n`
  )
  reg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', `"${launcherPath(dataDir)}"`, '/f'])
}

export function disableAutostart(dataDir: string): void {
  assertWindows()
  reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
  rmSync(launcherPath(dataDir), { force: true })
}

// Opens the daemon in its own console window now, as logon would.
export function startAutostartNow(dataDir: string): void {
  assertWindows()
  spawn('cmd.exe', ['/c', 'start', '""', launcherPath(dataDir)], { detached: true, stdio: 'ignore' }).unref()
}

function reg(args: string[]): void {
  const result = spawnSync('reg.exe', args, { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error(`reg ${args[0]} failed with exit code ${result.status}`)
}

function assertWindows(): void {
  if (process.platform !== 'win32') throw new Error('autostart is only implemented for Windows in this prototype')
}
