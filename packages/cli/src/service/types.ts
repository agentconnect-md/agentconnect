/**
 * Shared contracts for the OS-service layer. A `ServiceController` is the
 * platform-agnostic seam behind `up`/`down`/`restart`/`status`/`install-service`/
 * `uninstall-service`; launchd and systemd implement it. All process execution
 * goes through the injectable `Exec` so tests never shell out.
 */
import type { ServiceAccount } from './account.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

/** Everything a controller needs to locate its unit file + talk to the OS. */
export interface ControllerDeps {
  root: string
  home: string
  uid: number
  exec: Exec
  /** Named service instance (instance.ts). Undefined = the default instance,
   *  whose unit keeps the historical name so existing installs stay addressable. */
  instance?: string
  /** Linux only: which systemd scope to drive. Defaults to `system`; `user`
   *  addresses a legacy `~/.config/systemd/user` unit so it stays removable. */
  scope?: 'system' | 'user'
  /** Linux system scope: the account the unit's `User=` names. Required to install. */
  account?: ServiceAccount
  /** Test seams so a unit install never touches /etc on the developer's machine. */
  systemUnitDir?: string
  polkitDir?: string
}

/**
 * Runtime-resolved bits the unit file needs; supplied at install time. The unit's
 * daemon entry is NOT passed here — it is always `<root>/current/dist/index.js`
 * (via the symlink), so upgrades never require reinstalling the service
 * (cli-daemon-split.md §6).
 */
export interface InstallOpts {
  execPath: string
  includeRootEnv: boolean
  /**
   * Absolute path to this CLI's own dist entry. When present, the unit runs
   * `execPath cliEntry run` — the CLI run shell — which launches the daemon
   * through the user's interactive login shell so it inherits a fresh
   * terminal-equivalent environment (run-shell.ts / service-spawn.ts). Without
   * it the unit falls back to running the daemon entry directly (legacy form).
   * Pinned at install time and refreshed on every re-install, like `execPath`.
   */
  cliEntry?: string
  /**
   * Install-time snapshot of the invoking shell's `PATH`, baked into the unit.
   * Service managers give user units a minimal PATH and never source shell
   * profiles; this keeps the CLI itself and the direct-spawn fallback working
   * even when the login-shell launch is unavailable. Refreshed on every
   * re-install, like `execPath`.
   */
  envPath?: string
}

/** One installed unit as found on disk by the instance lister — enough to build
 *  a controller for it and to tell the operator which root it drives. */
export interface InstalledUnit {
  instance?: string
  label: string
  unitPath: string
  root: string
  /** systemd scope the unit was found in; launchd agents are always `user`. */
  scope: 'system' | 'user'
  /** The account a system unit runs as, off its `User=` line. */
  user?: string
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid?: number
  label: string
  logPath: string
}

export interface ServiceController {
  readonly label: string
  install(opts: InstallOpts): Promise<void>
  uninstall(): Promise<void>
  up(): Promise<void>
  down(): Promise<void>
  status(): Promise<ServiceStatus>
  isInstalled(): boolean
}
