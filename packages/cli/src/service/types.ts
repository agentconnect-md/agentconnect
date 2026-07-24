/**
 * Shared contracts for the OS-service layer. A `ServiceController` is the
 * platform-agnostic seam behind `up`/`down`/`restart`/`status`/`install-service`/
 * `uninstall-service`; launchd and systemd implement it. All process execution
 * goes through the injectable `Exec` so tests never shell out.
 */
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
