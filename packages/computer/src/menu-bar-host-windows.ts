// The Windows daemon's side of the taskbar menu: reads each item's state and carries out its click as the signed-in person.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerCpClient } from './cp/client.js'
import type { Registration } from './cp/registration.js'
import type { CuaDriver } from './driver/client.js'
import { CUA_DRIVER_VERSION, installDriver, installedDriverDir } from './driver/install.js'
import type { ComputerAdminPromptMode } from '@agentconnect.md/protocol/computer'
import type { AdminPromptFacts, MenuBarFacts, MenuBarHost } from './menu-bar.js'
import { controlPlaneState } from './menu-bar-host.js'
import { serviceHost, setStartAtLogin, spawnAsUser, startsAtLogin } from './service-windows.js'
import {
  canInstallFfmpeg,
  ffmpegAvailable,
  ffmpegInstalling,
  FFMPEG_VERSION,
  installFfmpeg,
  resolveFfmpegPath
} from './stream/ffmpeg.js'
import { COMPUTER_DAEMON_VERSION } from './version.js'

export interface WindowsMenuBarDeps {
  dir: string
  ffmpegPath?: string | undefined
  driver: CuaDriver
  name: () => string | undefined
  registration: Registration | undefined
  client: () => ComputerCpClient | undefined
  // Exits the daemon; the service host starts it again after a non-zero code and waits for the next sign-in after zero.
  shutdown: (code: number) => void
  onFfmpegInstalled: () => void
  // Who answers UAC prompts; absent without the prompt helper.
  adminPrompts?: { facts(): AdminPromptFacts; set(mode: ComputerAdminPromptMode): Promise<void> }
  log: (line: string) => void
}

const RECONNECT_WAIT_MS = 10_000
const DRIVER_TIMEOUT_MS = 5_000

const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())])

// The uninstaller in a console the person sees; it asks for administrator approval itself.
export function uninstallCommand(channel: string | undefined): string {
  const cli = `@agentconnect.md/cli${channel === 'rc' ? '@rc' : ''}`
  return `title Uninstall AgentConnect Computer & echo Uninstalling AgentConnect Computer... & (where agentconnect >nul 2>&1 && agentconnect computer uninstall || npx -y ${cli} computer uninstall) & echo. & echo Done. You can close this window.`
}

export function windowsMenuBarHost(deps: WindowsMenuBarDeps): Omit<MenuBarHost, 'stop' | 'resume' | 'log'> {
  const { dir, driver, log } = deps
  const host = deps.registration ? new URL(deps.registration.channelUrl).host : undefined
  return {
    async facts(): Promise<MenuBarFacts> {
      const running = await within(driver.call('get_screen_size', {}), DRIVER_TIMEOUT_MS).then(
        () => true,
        () => false
      )
      const name = deps.name()
      const service = serviceHost() !== undefined
      return {
        ...(name ? { name } : {}),
        version: COMPUTER_DAEMON_VERSION,
        controlPlane: { state: controlPlaneState(deps.registration, deps.client()), ...(host ? { host } : {}) },
        driver: { version: driver.version ?? CUA_DRIVER_VERSION, running },
        ffmpeg: {
          version: FFMPEG_VERSION,
          installed: ffmpegAvailable(resolveFfmpegPath(dir, deps.ffmpegPath)),
          installable: canInstallFfmpeg() && !deps.ffmpegPath,
          installing: ffmpegInstalling(dir)
        },
        startAtLogin: service && startsAtLogin(),
        windows: { service, ...(deps.adminPrompts ? { adminPrompts: deps.adminPrompts.facts() } : {}) }
      }
    },
    async reconnect() {
      const client = deps.client()
      if (!client) return false
      client.reconnectNow()
      const deadline = Date.now() + RECONNECT_WAIT_MS
      while (client.state !== 'READY' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
      return client.state === 'READY'
    },
    async installDriver() {
      // A driver that will not answer is reinstalled from scratch, and the daemon restarts onto it.
      rmSync(installedDriverDir(dir), { recursive: true, force: true })
      await installDriver(dir, log)
      deps.shutdown(1)
    },
    async installFfmpeg() {
      await installFfmpeg(dir, log)
      deps.onFfmpegInstalled()
    },
    async setAdminPrompts(mode) {
      if (!deps.adminPrompts) return
      await deps.adminPrompts.set(mode)
      log(`administrator prompts set to ${mode} from the taskbar`)
    },
    // macOS grants: not shown on Windows.
    openSettings: () => undefined,
    resetGrant: () => undefined,
    setStartAtLogin(on) {
      if (!serviceHost()) return
      setStartAtLogin(on)
      log(`start at sign-in turned ${on ? 'on' : 'off'} from the taskbar`)
    },
    openLogs() {
      const file = join(dir, 'daemon.log')
      spawnAsUser(existsSync(file) ? 'notepad.exe' : 'explorer.exe', [existsSync(file) ? file : dir], {
        detach: true
      }).unref()
    },
    uninstall() {
      let channel: string | undefined
      try {
        channel = (JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as { channel?: string }).channel
      } catch {
        channel = undefined
      }
      log('uninstall requested from the taskbar; running it in a console window')
      spawnAsUser('cmd.exe', ['/k', uninstallCommand(channel)], { detach: true }).unref()
    },
    quit() {
      log('quit from the taskbar; the service starts the daemon again at the next sign-in')
      deps.shutdown(0)
    },
    restart: () => deps.shutdown(1)
  }
}
