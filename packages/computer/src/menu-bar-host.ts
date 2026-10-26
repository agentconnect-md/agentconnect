// The macOS daemon's side of the menu bar: reads each item's state and carries out its click (#3403).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerCpClient } from './cp/client.js'
import type { Registration } from './cp/registration.js'
import type { CuaDriver } from './driver/client.js'
import { CUA_DRIVER_VERSION, installDriver, installedDriverDir } from './driver/install.js'
import {
  APP_ID,
  forgetGrant,
  grantLoss,
  readGrantRecord,
  TCC_SERVICE,
  type Grant,
  type GrantRecord
} from './macos-grants.js'
import type { ControlPlaneState, GrantState, MenuBarFacts, MenuBarHost } from './menu-bar.js'
import { setStartAtLogin, startsAtLogin } from './service-macos.js'
import { MAC_PANES, macPermissions, open } from './setup.js'
import {
  canInstallFfmpeg,
  ffmpegAvailable,
  ffmpegInstalling,
  FFMPEG_VERSION,
  installFfmpeg,
  resolveFfmpegPath
} from './stream/ffmpeg.js'
import { runSelf } from './self.js'
import { COMPUTER_DAEMON_VERSION } from './version.js'

export interface MacMenuBarDeps {
  dir: string
  ffmpegPath?: string | undefined
  appPath: string | undefined
  driver: CuaDriver
  name: () => string | undefined
  registration: Registration | undefined
  client: () => ComputerCpClient | undefined
  // Exits the daemon; a non-zero code makes launchd start it again.
  shutdown: (code: number) => void
  onFfmpegInstalled: () => void
  // Whether a grant the running driver missed is now in effect, restarting the driver onto it if so.
  accessibilityGranted: () => Promise<boolean>
  log: (line: string) => void
}

const RECONNECT_WAIT_MS = 10_000
const PERMISSIONS_TIMEOUT_MS = 5_000

const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())])

export function grantState(granted: boolean, record: GrantRecord, grant: Grant): GrantState {
  if (granted) return 'allowed'
  return grantLoss(record, grant) === 'lost' ? 'stale' : 'off'
}

export function controlPlaneState(
  registration: Registration | undefined,
  client: ComputerCpClient | undefined
): ControlPlaneState {
  if (!registration) return 'unregistered'
  if (registration.revokedAt) return 'revoked'
  switch (client?.state) {
    case 'READY':
      return 'connected'
    case 'REVOKED':
      return 'revoked'
    case 'DEGRADED':
    case 'STOPPED':
    case undefined:
      return 'disconnected'
    default:
      return 'connecting'
  }
}

export const appVersion = (appPath: string | undefined): string | undefined => {
  if (!appPath) return undefined
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

// Runs the CLI's uninstaller in Terminal, so the person sees its output; a login shell finds the Node that installed it.
export function uninstallScript(channel: string | undefined): string {
  const cli = `@agentconnect.md/cli${channel === 'rc' ? '@rc' : ''}`
  return `#!/bin/zsh -l
echo "Uninstalling AgentConnect Computer…"
if command -v agentconnect >/dev/null 2>&1; then
  agentconnect computer uninstall
else
  npx -y ${cli} computer uninstall
fi
echo
echo "Done. You can close this window."
`
}

export function macMenuBarHost(deps: MacMenuBarDeps): Omit<MenuBarHost, 'stop' | 'resume' | 'log'> {
  const { dir, driver, log } = deps
  const host = deps.registration ? new URL(deps.registration.channelUrl).host : undefined
  return {
    async facts(): Promise<MenuBarFacts> {
      let permissions = await within(macPermissions(driver), PERMISSIONS_TIMEOUT_MS).catch(() => undefined)
      // The running driver keeps the Accessibility answer it started with; a switch turned on since needs a fresh one.
      if (permissions && !permissions.accessibility && (await deps.accessibilityGranted())) {
        permissions = await within(macPermissions(driver), PERMISSIONS_TIMEOUT_MS).catch(() => undefined)
      }
      const name = deps.name()
      const app = appVersion(deps.appPath)
      const record = readGrantRecord(dir)
      return {
        ...(name ? { name } : {}),
        version: COMPUTER_DAEMON_VERSION,
        ...(app ? { appVersion: app } : {}),
        controlPlane: { state: controlPlaneState(deps.registration, deps.client()), ...(host ? { host } : {}) },
        ...(permissions
          ? {
              screenRecording: grantState(permissions.screenRecording, record, 'screenRecording'),
              accessibility: grantState(permissions.accessibility, record, 'accessibility')
            }
          : {}),
        driver: { version: driver.version ?? CUA_DRIVER_VERSION, running: permissions !== undefined },
        ffmpeg: {
          version: FFMPEG_VERSION,
          installed: ffmpegAvailable(resolveFfmpegPath(dir, deps.ffmpegPath)),
          installable: canInstallFfmpeg() && !deps.ffmpegPath,
          installing: ffmpegInstalling(dir)
        },
        startAtLogin: startsAtLogin()
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
    openSettings: (pane) => open(MAC_PANES[pane]),
    resetGrant(grant) {
      // The pane opens first: resetting a held Screen Recording grant makes macOS quit the app, which restarts the daemon.
      open(MAC_PANES[grant])
      forgetGrant(dir, grant)
      log(`resetting the ${grant} grant held for an earlier build of the app, from the menu bar`)
      const reset = spawnSync('tccutil', ['reset', TCC_SERVICE[grant], APP_ID], { encoding: 'utf8' })
      if (reset.status !== 0) log(`tccutil reset failed: ${`${reset.stdout}${reset.stderr}`.trim()}`)
      // A fresh child asks, as the daemon's start does: it lists the app in the pane again, switched off, to switch on.
      void runSelf(['permissions', '--json', '--prompt'], 200_000).catch(() => undefined)
    },
    setStartAtLogin(on) {
      setStartAtLogin(on)
      log(`start at login turned ${on ? 'on' : 'off'} from the menu bar`)
    },
    openLogs() {
      const file = join(dir, 'daemon.log')
      spawn('open', existsSync(file) ? ['-a', 'Console', file] : [dir], { stdio: 'ignore', detached: true }).unref()
    },
    uninstall() {
      let channel: string | undefined
      try {
        channel = (JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as { channel?: string }).channel
      } catch {
        channel = undefined
      }
      const script = join(tmpdir(), 'agentconnect-computer-uninstall.command')
      writeFileSync(script, uninstallScript(channel))
      chmodSync(script, 0o755)
      log('uninstall requested from the menu bar; running it in Terminal')
      spawn('open', ['-a', 'Terminal', script], { stdio: 'ignore', detached: true }).unref()
    },
    quit() {
      log('quit from the menu bar; the service starts again at the next login')
      deps.shutdown(0)
    },
    restart: () => deps.shutdown(1)
  }
}
