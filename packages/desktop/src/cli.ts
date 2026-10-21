#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { auditSinks, fileAuditSink, type AuditSink } from './audit.js'
import { AuditReporter } from './cp/audit-report.js'
import { ScreenshotStore } from './cp/screenshot-store.js'
import { disableAutostart, enableAutostart, startAutostartNow } from './autostart.js'
import { Computer, type ScreenshotStash } from './computer.js'
import {
  authenticate,
  configPath,
  controlBaseUrl,
  dataDir,
  DesktopConfig,
  isLoopbackHost,
  isWildcardHost,
  issueClientToken,
  loadConfig,
  saveConfig
} from './config.js'
import { CuaDriver, type DriverTool } from './driver/client.js'
import { CUA_DRIVER_VERSION, installDriver, installedDriverPath, resolveDriverPath } from './driver/install.js'
import { CONTROL_HEADER, startHttpServer, urlHost } from './http-server.js'
import { canInstallFfmpeg, ffmpegAvailable, FFMPEG_VERSION, installFfmpeg, resolveFfmpegPath } from './stream/ffmpeg.js'
import { RtcSessions } from './stream/rtc.js'
import { ScreenStream } from './stream/screen-stream.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { createComputerMcpServer, exposedDriverTools } from './tools.js'
import { createViewer, type Viewer, type ViewerPrincipal } from './viewer.js'
import { hasCommand, keepDisplayAwake } from './keep-awake.js'
import { appBundlePath, runSelf, selfCommand } from './self.js'
import { ChannelAuthority } from './cp/authority.js'
import { ComputerCpClient } from './cp/client.js'
import { consoleStopHandler } from './cp/console-stop.js'
import { DAEMON_CONSOLE_STOP_REASON, startLocalControls, type LocalControls } from './local-controls.js'
import { RelayLinks } from './cp/relay-links.js'
import {
  channelPrincipal,
  createRelayedMcpHandler,
  viewerAuthenticator,
  viewerPrincipal,
  type McpPrincipal
} from './mcp-access.js'
import {
  exchangeRegistrationToken,
  loadRegistration,
  markRevoked,
  registerOrKeep,
  RegistrationTokenRefused,
  registrationPath,
  saveRegistration,
  type Registration
} from './cp/registration.js'
import { capabilitiesFrom, computerOs, doctorReport, isolationKind, osVersion, sessionKind } from './cp/report.js'
import {
  COMPUTER_NAME_ENV,
  keepsRegistration,
  REGISTER_TOKEN_ENV,
  registrationFromEnv,
  staysRevoked
} from './cp/env-registration.js'
import { publicBaseUrl, rtcAdvertiseAddress } from './public-address.js'
import { DESKTOP_DAEMON_VERSION } from './version.js'
import * as linuxService from './service-linux.js'
import {
  installService,
  plistPath,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService
} from './service-macos.js'
import {
  doctor,
  hostApp,
  localizeChecks,
  MAC_PANES,
  macPermissions,
  open,
  printChecks,
  setupPermissions,
  type Check,
  type SetupContext
} from './setup.js'

const help = (): string => `${selfCommand()} — prototype desktop daemon (Cua Driver + computer_* MCP tools)

Usage: ${selfCommand()} <command> [options]

Commands:
  setup [--client NAME] [--host H] [--port P] [--no-service]
                                               one-time install, run on the desktop itself: config + client token,
                                               Cua Driver ${CUA_DRIVER_VERSION}, ffmpeg, then the OS approvals (macOS
                                               Accessibility + Screen Recording, Windows Firewall), then doctor
  setup --register TOKEN --cp-url URL [--name NAME]
                                               the same, registering this desktop as a Computer with the Control
                                               Plane instead of minting a local client token (the key is kept in
                                               a 0600 file in the data dir)
  register TOKEN --cp-url URL [--name NAME]    only the registration part of setup; restart the daemon afterwards
  init [--client NAME] [--host H] [--port P]   non-interactive part of setup: config + token + Cua Driver
  install-driver                               download and verify the pinned Cua Driver build
  install-ffmpeg                               download the pinned ffmpeg (${FFMPEG_VERSION}) for the WebRTC viewer
  run [--host H] [--port P] [--expose-driver-tools] [--public-url URL] [--rtc-address A] [--rtc-ports MIN-MAX]
                                               foreground: serve MCP at http://H:P/mcp and the remote
                                               desktop viewer at http://H:P/view until Ctrl+C
                                               (first run creates the token and downloads the driver);
                                               H defaults to 127.0.0.1, --host 0.0.0.0 opens every interface;
                                               registers first when ${REGISTER_TOKEN_ENV}(_FILE) and
                                               AGENTCONNECT_CP_URL are set and no key for that CP is stored
  stdio [--expose-driver-tools]                serve MCP over stdio (agent runs on this machine)
  token add NAME | token list | token remove NAME
  status | pause | resume                      owner controls for the running daemon (loopback)
  doctor [--json] [--daemon]                   check install, session, permissions, capture, firewall
                                               (read-only; exits 1 when a required check fails);
                                               --daemon also fails when no daemon answers (health checks)
  autostart enable | disable | start           Windows: start 'run' at logon (per-user Run key)
  service install | uninstall | start | stop | restart | status
                                               background service: macOS .app LaunchAgent (the app holds
                                               the permissions), Linux systemd user unit (graphical session)

Data dir: ${dataDir()}`

// "7700-7719" → [7700, 7719]; DesktopConfig validates the bounds.
const parsePortRange = (value: string): [number, number] => {
  const [min, max = min] = value.split('-').map(Number)
  return DesktopConfig.shape.rtcPortRange.parse([min, max])!
}

const log = (line: string): void => console.error(`[${new Date().toISOString()}] ${line}`)

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'public-url': { type: 'string' },
      'rtc-address': { type: 'string' },
      'rtc-ports': { type: 'string' },
      client: { type: 'string', default: 'claude' },
      'expose-driver-tools': { type: 'boolean' },
      json: { type: 'boolean' },
      here: { type: 'boolean' },
      daemon: { type: 'boolean' },
      prompt: { type: 'boolean' },
      'capture-timeout': { type: 'string' },
      'no-service': { type: 'boolean' },
      register: { type: 'string' },
      'cp-url': { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [command, ...rest] = positionals
  if (values.help || !command) return void console.log(help())
  const dir = dataDir()
  const overrides = (config: DesktopConfig): DesktopConfig => ({
    ...config,
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values['expose-driver-tools'] ? { exposeDriverTools: true } : {}),
    ...(values['public-url'] ? { publicUrl: DesktopConfig.shape.publicUrl.parse(values['public-url']) } : {}),
    ...(values['rtc-address'] ? { rtcAddress: values['rtc-address'] } : {}),
    ...(values['rtc-ports'] ? { rtcPortRange: parsePortRange(values['rtc-ports']) } : {})
  })

  switch (command) {
    case 'init': {
      let config = overrides(loadConfig(dir))
      let token: string | undefined
      if (!config.clients.some((client) => client.name === values.client)) {
        ;({ config, token } = issueClientToken(config, values.client))
      }
      saveConfig(config, dir)
      console.log(`Config: ${configPath(dir)}`)
      await installDriver(dir)
      if (token) printClientSetup(config, values.client, token)
      else console.log(`Client "${values.client}" already exists; use "token add ${values.client}" to rotate it.`)
      return
    }
    case 'setup': {
      const config = overrides(loadConfig(dir))
      if (values.register) {
        const { register: token, 'cp-url': cpUrl, name } = values
        const { registration, kept } = await registerOrKeep(dir, cpUrl, () => registerComputer(dir, token, cpUrl, name))
        if (kept)
          console.log(`The token is spent; keeping this desktop's registration as computer ${registration.computerId}.`)
      }
      const registered = Boolean(values.register) || Boolean(loadRegistration(dir))
      return setup(dir, config, registered ? undefined : values.client, !values['no-service'])
    }
    case 'register': {
      const token = rest[0] ?? values.register
      if (!token) throw new Error('usage: register TOKEN --cp-url URL [--name NAME]')
      await registerComputer(dir, token, values['cp-url'], values.name)
      console.log(`Restart the daemon if it is running so it connects: ${selfCommand()} service restart`)
      return
    }
    case 'install-driver':
      await installDriver(dir)
      return
    case 'install-ffmpeg':
      console.log(`ffmpeg: ${await installFfmpeg(dir)}`)
      return
    case 'token':
      return tokenCommand(dir, rest)
    case 'run':
      return run(dir, overrides(loadConfig(dir)), values.client)
    case 'stdio':
      return stdio(dir, overrides(loadConfig(dir)))
    case 'status':
    case 'pause':
    case 'resume':
      return controlCommand(overrides(loadConfig(dir)), command)
    case 'doctor': {
      const config = overrides(loadConfig(dir))
      // On macOS the daemon's permissions are what matter; a running daemon checks from inside itself.
      const remote = process.platform !== 'win32' && !values.here ? await daemonDoctor(config) : undefined
      const captureMs = Number(values['capture-timeout']) || 15_000
      if (values.daemon && !remote) {
        const down: Check = { name: 'daemon', status: 'fail', detail: `no daemon answers on ${controlBaseUrl(config)}` }
        if (values.json) console.log(JSON.stringify([down]))
        else printChecks([down])
        process.exitCode = 1
        return
      }
      const checks = remote ?? (await doctor(setupContext(dir, config), captureMs))
      if (values.json) console.log(JSON.stringify(checks))
      else {
        if (remote) console.log(`(checked inside the running daemon: ${remote.host})\n`)
        if (!printChecks(checks)) process.exitCode = 1
      }
      if (values.json && checks.some((check) => check.status === 'fail')) process.exitCode = 1
      return
    }
    case 'permissions': {
      const driver = new CuaDriver({
        command: resolveDriverPath(dir, loadConfig(dir).driverPath),
        callTimeoutMs: values.prompt ? 180_000 : 20_000
      })
      try {
        console.log(JSON.stringify(await macPermissions(driver, Boolean(values.prompt))))
      } finally {
        await driver.close()
      }
      return
    }
    case 'service':
      return serviceCommand(dir, loadConfig(dir), rest[0])
    case 'autostart': {
      const action = rest[0]
      if (action === 'enable') enableAutostart(dir, resolve(process.argv[1]!))
      else if (action === 'disable') disableAutostart(dir)
      else if (action === 'start') startAutostartNow(dir)
      else throw new Error('usage: autostart enable | disable | start')
      return void console.log(`autostart ${action}: ok`)
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${help()}`)
  }
}

const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net!.address)

// With tokenFile the token goes to that 0600 file instead of the output, which a service or container log keeps.
function printClientSetup(config: DesktopConfig, client: string, token: string, tokenFile?: string): void {
  const host = urlHost(isWildcardHost(config.host) ? (lanAddresses()[0] ?? hostname()) : config.host)
  const base = publicBaseUrl(config) ?? `http://${host}:${config.port}`
  let shown = token
  if (tokenFile) {
    rmSync(tokenFile, { force: true })
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' })
    shown = '<token>'
    console.log(`\nClient "${client}" token written to ${tokenFile} (mode 0600); read it with: cat ${tokenFile}\n`)
  } else {
    console.log(`\nClient "${client}" token (shown once, stored only as a hash):\n  ${token}\n`)
  }
  console.log('Register with Claude Code:')
  console.log(`  claude mcp add --transport http computer ${base}/mcp --header "Authorization: Bearer ${shown}"\n`)
  console.log(`Remote desktop in a browser (the token stays in the URL fragment, never sent to the server):`)
  console.log(`  ${base}/view#token=${shown}\n`)
  if (isLoopbackHost(config.host)) {
    console.log('Reachable from this machine only; use --host 0.0.0.0 (trusted networks) or an SSH tunnel for others.')
  } else {
    console.log(
      `The daemon listens on ${config.host} over plain HTTP and the token is its only protection (trusted networks only).`
    )
  }
}

function tokenCommand(dir: string, args: string[]): void {
  const [action, name] = args
  const config = loadConfig(dir)
  if (action === 'list') {
    for (const client of config.clients) console.log(client.name)
    return
  }
  if (!name) throw new Error('usage: token add NAME | token remove NAME | token list')
  if (action === 'add') {
    const issued = issueClientToken(config, name)
    saveConfig(issued.config, dir)
    printClientSetup(issued.config, name, issued.token)
    console.log('Restart the daemon if it is running so it picks up the new token.')
  } else if (action === 'remove') {
    saveConfig({ ...config, clients: config.clients.filter((client) => client.name !== name) }, dir)
    console.log(`removed ${name}; restart the daemon to revoke it`)
  } else {
    throw new Error('usage: token add NAME | token remove NAME | token list')
  }
}

// Under a systemd service the driver gets its own scope: apps it launches would otherwise die with every restart.
const driverWrapper = (): string[] | undefined =>
  process.platform === 'linux' && process.env.INVOCATION_ID && hasCommand('systemd-run')
    ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--']
    : undefined

function buildComputer(
  dir: string,
  config: DesktopConfig,
  onStatus?: (status: string) => void,
  refusal?: () => string | undefined,
  report?: AuditSink,
  screenshots?: ScreenshotStash,
  name = process.env[COMPUTER_NAME_ENV]?.trim() || hostname()
) {
  const wrapper = driverWrapper()
  const driver = new CuaDriver({
    command: resolveDriverPath(dir, config.driverPath),
    callTimeoutMs: config.driverCallTimeoutMs,
    log,
    ...(wrapper ? { wrapper } : {})
  })
  const computer = new Computer({
    driver,
    config,
    audit: auditSinks(fileAuditSink(join(dir, 'audit.log')), ...(report ? [report] : [])),
    log,
    ...(onStatus ? { onStatus } : {}),
    ...(refusal ? { refusal } : {}),
    ...(screenshots ? { screenshots } : {}),
    profile: { name: name.slice(0, 120), osVersion: osVersion(), session: sessionKind(), isolation: isolationKind() }
  })
  return { driver, computer }
}

// Exchanges a console registration token for this desktop's Computer key and stores it 0600 (computer-use.md §3.6).
async function registerComputer(
  dir: string,
  token: string,
  cpUrl: string | undefined,
  name: string | undefined
): Promise<Registration> {
  if (!cpUrl) throw new Error('--cp-url is required with a registration token (the console prints it)')
  const registration = await exchangeRegistrationToken(cpUrl, token, {
    name: (name ?? (process.env[COMPUTER_NAME_ENV]?.trim() || hostname())).slice(0, 120),
    isolation: isolationKind(),
    os: computerOs(),
    osVersion: osVersion(),
    session: sessionKind(),
    desktopDaemonVersion: DESKTOP_DAEMON_VERSION,
    driverVersion: CUA_DRIVER_VERSION
  })
  saveRegistration(registration, dir)
  console.log(`Registered as computer ${registration.computerId}; key stored in ${registrationPath(dir)} (mode 0600).`)
  return registration
}

const DOCTOR_INTERVAL_MS = 30 * 60_000

// Connects a registered daemon to the Control Plane; returns how to stop it, or undefined when not registered.
function startCpChannel(options: {
  dir: string
  config: DesktopConfig
  registration: Registration | undefined
  authority: ChannelAuthority
  computer: Computer
  driver: CuaDriver
  screenSize: Record<string, unknown>
  createMcpServer: (principal: McpPrincipal) => McpServer
  viewer: Viewer
  local: () => LocalControls | undefined
}): { client: ComputerCpClient; relays: RelayLinks; stop(): void } | undefined {
  const { dir, config, registration, authority, computer, driver, screenSize } = options
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  // Until the first capture, the display comes from the driver's startup screen size.
  const startupDisplay = {
    screenWidth: num(screenSize.width),
    screenHeight: num(screenSize.height),
    scale: num(screenSize.scale_factor) || 1
  }
  if (!registration || registration.revokedAt) return undefined
  // A NAT-ed desktop is reached through the relays it dials out to; calls arrive with CP-issued session tokens (§3.7).
  const relayLinks = new RelayLinks({
    computerId: registration.computerId,
    desktopDaemonVersion: DESKTOP_DAEMON_VERSION,
    token: () => authority.relayToken(registration.computerId),
    handle: createRelayedMcpHandler({
      authenticate: (header) => channelPrincipal(header, authority, () => registration.computerId),
      createMcpServer: options.createMcpServer,
      log,
      // The console's embedded viewer signals and polls through the same link (computer-use.md §7, §10).
      viewer: (request) => options.viewer.api(request)
    }),
    log
  })
  const session = sessionKind()
  const profile = { osVersion: osVersion(), session, desktopDaemonVersion: DESKTOP_DAEMON_VERSION }
  let checks: Check[] | undefined
  let doctorAt: Date | undefined
  const client = new ComputerCpClient({
    channelUrl: registration.channelUrl,
    apiKey: registration.apiKey,
    desktopDaemonVersion: DESKTOP_DAEMON_VERSION,
    authority,
    log,
    report: () => {
      const display = computer.info().display as { screenWidth: number; screenHeight: number; scale: number } | null
      const lease = computer.leaseActivity()
      const local = options.local()
      return {
        status: computer.liveStatus(),
        ...(lease ? { lease } : {}),
        facts: {
          ...profile,
          driverVersion: driver.version ?? CUA_DRIVER_VERSION,
          // Capabilities come from doctor, so they are reported only once it has run.
          ...(checks && doctorAt
            ? {
                capabilities: capabilitiesFrom(checks, display ?? startupDisplay, {
                  session,
                  webrtc: config.webrtc,
                  keyboardActivity: local?.keyboard() ?? false
                }),
                doctor: doctorReport([...checks, ...(local?.checks() ?? [])], doctorAt)
              }
            : {})
        }
      }
    },
    onPolicy: (policy) => {
      // Lease limits apply here; the agent daemon asks for approvals (§4.2) and the CP enforces agent grants.
      config.leaseIdleSeconds = policy.leaseIdleSeconds
      config.leaseMaxSeconds = policy.leaseMaxSeconds
    },
    onLease: (lease) => computer.applyControlLease(lease),
    onRelays: (relays) => relayLinks.converge(relays),
    onStop: (stop) => applyConsoleStop(stop),
    onRevoked: (reason) => {
      relayLinks.stop()
      markRevoked(dir, reason)
      log(`REVOKED by the Control Plane (${reason}): the key was forgotten and all input is refused`)
    }
  })
  const applyConsoleStop = consoleStopHandler(computer, () => client.beat())
  // Doctor runs in a child of the daemon, so it sees the service's own session and grants.
  let doctorTimer: NodeJS.Timeout | undefined
  const runDoctor = async (): Promise<void> => {
    try {
      const output = await runSelf(['doctor', '--json', '--here'], 120_000)
      checks = localizeChecks(JSON.parse(output) as Check[])
      doctorAt = new Date()
      client.beat()
    } catch (error) {
      log(`doctor for the Control Plane report failed: ${(error as Error).message}`)
    }
    doctorTimer = setTimeout(() => void runDoctor(), DOCTOR_INTERVAL_MS)
    doctorTimer.unref()
  }
  client.start()
  void runDoctor()
  return {
    client,
    relays: relayLinks,
    stop() {
      if (doctorTimer) clearTimeout(doctorTimer)
      relayLinks.stop()
      client.stop()
    }
  }
}

// Viewer with WebRTC when ffmpeg is usable; a missing ffmpeg is fetched in the background where a build is pinned.
function buildViewer(
  dir: string,
  config: DesktopConfig,
  computer: Computer,
  refusal?: () => string | undefined,
  // A console member's CP-issued view token; local client tokens work only on the local port, never through a relay.
  consoleViewer?: (authorization: string | undefined) => ViewerPrincipal | undefined,
  advertiseAddress?: string
): Viewer {
  const ffmpeg = (): string => resolveFfmpegPath(dir, config.ffmpegPath)
  let ffmpegState: 'ok' | 'missing' | 'downloading' = 'missing'
  if (config.webrtc) {
    ffmpegState = ffmpegAvailable(ffmpeg()) ? 'ok' : 'missing'
    if (ffmpegState === 'missing' && canInstallFfmpeg() && !config.ffmpegPath) {
      ffmpegState = 'downloading'
      installFfmpeg(dir, log)
        .then(() => (ffmpegState = ffmpegAvailable(ffmpeg()) ? 'ok' : 'missing'))
        .catch((error: Error) => {
          ffmpegState = 'missing'
          log(`ffmpeg download failed (${error.message}); the viewer falls back to screenshots`)
        })
    }
    if (ffmpegState === 'missing') log('ffmpeg not found; the viewer falls back to screenshots')
  }
  const stream = new ScreenStream({
    dataDir: dir,
    ffmpeg,
    fps: config.streamFps,
    maxWidth: config.streamMaxWidth,
    bitrateKbps: config.streamBitrateKbps,
    log
  })
  const rtc = config.webrtc
    ? new RtcSessions({
        stream,
        log,
        onMessage: (principal, message) => viewer.channelMessage(principal, message),
        reauthorize: (token) => consoleViewer?.(`Bearer ${token}`),
        ...(advertiseAddress ? { advertiseAddress } : {}),
        ...(config.rtcPortRange ? { portRange: config.rtcPortRange } : {})
      })
    : undefined
  const viewer: Viewer = createViewer({
    computer,
    authenticate: viewerAuthenticator(
      (header) => consoleViewer?.(header),
      (header) => authenticate(config, header)
    ),
    log,
    ...(rtc ? { rtc } : {}),
    rtcUnavailable: () =>
      ffmpegState === 'ok'
        ? undefined
        : ffmpegState === 'downloading'
          ? 'ffmpeg is still downloading'
          : 'ffmpeg not found',
    streamError: () => stream.lastError,
    ...(refusal ? { refusal } : {})
  })
  return viewer
}

async function loadDriverTools(driver: CuaDriver, config: DesktopConfig): Promise<DriverTool[]> {
  if (!config.exposeDriverTools) return []
  return exposedDriverTools(await driver.listTools())
}

// A container registers from its environment on first start; a stored key for the same CP keeps the spent token unused.
async function registerFromEnvironment(dir: string): Promise<void> {
  const wanted = registrationFromEnv()
  // Nothing this daemon starts (doctor, the driver, apps an agent launches) inherits the token.
  delete process.env[REGISTER_TOKEN_ENV]
  if (!wanted) return
  const current = loadRegistration(dir)
  if (current && keepsRegistration(current, wanted.cpUrl)) {
    log(`registered as computer ${current.computerId}; the registration token in the environment is not used again`)
    return
  }
  try {
    await registerComputer(dir, wanted.token, wanted.cpUrl, wanted.name)
  } catch (error) {
    // A revoked desktop restarting with its spent token keeps running revoked rather than crash-looping.
    if (!(error instanceof RegistrationTokenRefused) || !current || !staysRevoked(current, wanted.cpUrl)) throw error
    log(`registration refused (${error.message}); keeping computer ${current.computerId}, which refuses all input`)
  }
}

async function run(dir: string, initial: DesktopConfig, clientName: string): Promise<void> {
  // First run sets itself up, so unzip + `run` is enough; nothing is installed as a service.
  let config = initial
  await registerFromEnvironment(dir)
  const registration = loadRegistration(dir)
  if (config.clients.length === 0 && !registration) {
    const issued = issueClientToken(config, clientName)
    config = issued.config
    saveConfig(config, dir)
    // Without a terminal the output is a log (a service or `docker logs`), so the token goes to a file instead.
    printClientSetup(config, clientName, issued.token, process.stdout.isTTY ? undefined : join(dir, 'client-token'))
  }
  if (!config.driverPath && !existsSync(installedDriverPath(dir))) await installDriver(dir)
  const setTitle = (status: string): void => {
    process.title = `AgentConnect Desktop — ${status}`
  }
  // Filled once built; the authority and status callbacks below fire only after that.
  const live: {
    viewer?: Viewer
    channel?: { client: ComputerCpClient; relays: RelayLinks; stop(): void }
    local?: LocalControls
  } = {}
  // Registered with a Control Plane: act only while its channel key is live, never after a revoke (§8.2).
  const authority = new ChannelAuthority({
    registered: Boolean(registration),
    ...(registration?.revokedAt ? { revokedReason: registration.revokedReason ?? 'revoked' } : {}),
    log,
    onLost: (state) => {
      const reason = state.kind === 'revoked' ? 'computer revoked' : 'Control Plane unreachable'
      computer.suspend(reason)
      live.viewer?.disconnectAll(reason)
      // No new data-plane calls without a live key; the next roster push after reconnecting reattaches.
      live.channel?.relays.stop()
    }
  })
  // A registered desktop also reports every call to the Control Plane, which keeps the owner's per-Computer audit (§8.2).
  const auditReport =
    registration && !registration.revokedAt
      ? new AuditReporter({
          send: (entries) => live.channel?.client.reportAudit(entries) ?? Promise.resolve('retry' as const),
          log
        })
      : undefined
  auditReport?.start()
  // Agent sessions' screenshots go to the object store when the CP keeps them (§9); 0 retention writes nothing.
  const screenshotStore =
    registration && !registration.revokedAt
      ? new ScreenshotStore({
          retentionDays: () => live.channel?.client.screenshotRetentionDays() ?? 0,
          computerId: () => registration.computerId,
          sign: (put) => live.channel?.client.signScreenshot(put) ?? Promise.resolve('retry' as const),
          commit: (commit) => live.channel?.client.commitScreenshot(commit) ?? Promise.resolve('retry' as const),
          log
        })
      : undefined
  const { driver, computer } = buildComputer(
    dir,
    config,
    (status) => {
      setTitle(status)
      live.channel?.client.beat()
      live.local?.update()
    },
    () => authority.refusal(),
    auditReport?.sink,
    screenshotStore?.stash
  )
  setTitle('online')
  if (registration?.revokedAt)
    log(`this computer was revoked (${registration.revokedReason ?? 'revoked'}); all input is refused`)
  const screenSize = (await driver.call('get_screen_size', {})).structuredContent ?? {}
  const sized = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  computer.setScreenSize({
    screenWidth: sized(screenSize.width),
    screenHeight: sized(screenSize.height),
    scale: sized(screenSize.scale_factor) || 1
  })
  log(`Cua Driver ${driver.version ?? '?'} started (${resolveDriverPath(dir, config.driverPath)})`)
  if (process.platform === 'darwin') await warnMissingMacPermissions(driver)
  // Under launchd the .app asks for its own grants once; the dialogs appear on the Mac's screen.
  if (process.platform === 'darwin' && appBundlePath() && !process.stdin.isTTY) {
    const state = await macPermissions(driver).catch(() => undefined)
    if (state && (!state.accessibility || !state.screenRecording)) {
      void runSelf(['permissions', '--json', '--prompt'], 200_000).catch(() => undefined)
    }
  }
  const releaseDisplay = config.keepAwake ? keepDisplayAwake(log) : () => undefined
  const driverTools = await loadDriverTools(driver, config)
  const viewer = buildViewer(
    dir,
    config,
    computer,
    () => authority.refusal(),
    registration ? (header) => viewerPrincipal(header, authority, () => registration.computerId) : undefined,
    config.webrtc ? await rtcAdvertiseAddress(config, undefined, log) : undefined
  )
  live.viewer = viewer
  live.local = await startLocalControls({
    computer,
    refusal: () => authority.refusal(),
    stopHotkey: config.stopHotkey,
    headless: sessionKind() === 'xvfb',
    log
  })
  const createMcpServer = ({ client, viewOnly, agent }: McpPrincipal): McpServer =>
    createComputerMcpServer({ computer, client, driverTools, viewOnly, ...(agent ? { agent } : {}) })
  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    computer,
    // A CP-issued session token also works directly, the same-network shortcut past the relay (§3.7).
    authenticate: (header) => {
      const channel = registration ? channelPrincipal(header, authority, () => registration.computerId) : undefined
      if (channel) return channel
      const client = authenticate(config, header)
      return client ? { client, viewOnly: false } : undefined
    },
    createMcpServer,
    log,
    viewer,
    localChecks: () => live.local?.checks() ?? []
  })
  live.channel = startCpChannel({
    dir,
    config,
    registration,
    authority,
    computer,
    driver,
    screenSize,
    createMcpServer,
    viewer,
    local: () => live.local
  })
  // Behind NAT the local addresses mean nothing to a client, so only the public one is printed.
  const publicBase = publicBaseUrl(config)
  const urls = publicBase
    ? [`${publicBase}/mcp`]
    : isWildcardHost(config.host)
      ? [server.url, ...lanAddresses().map((ip) => `http://${ip}:${config.port}/mcp`)]
      : [server.url]
  const clients = config.clients.map((client) => client.name).join(', ')
  log(`MCP endpoint ${urls.join(' , ')} (${clients ? `clients: ${clients}` : 'Control Plane session tokens only'})`)
  log(
    `Remote desktop viewer ${urls.map((url) => url.replace(/\/mcp$/, '/view')).join(' , ')} (sign in with a client token)`
  )
  if (!isLoopbackHost(config.host)) {
    log(
      `WARNING: listening on ${config.host} over plain HTTP; anyone with a token on this network can control this desktop`
    )
  }
  if (driverTools.length) log(`exposing ${driverTools.length} raw Cua Driver tools as cua_*`)
  installConsoleControls(computer)

  let stopping = false
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    log('shutting down')
    computer.pause('daemon shutting down')
    auditReport?.stop()
    screenshotStore?.stop()
    await auditReport?.flush()
    live.channel?.stop()
    live.local?.close()
    authority.close()
    releaseDisplay()
    await Promise.allSettled([server.close(), driver.close()])
    process.exit(exitCode)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  // The systemd service lives as long as the desktop session it was started for (computer-use.md §3.3).
  const session = process.env[linuxService.SESSION_ENV]
  if (process.platform === 'linux' && process.env.INVOCATION_ID && session) {
    log(`following desktop session ${session}`)
    linuxService.watchSession({
      session,
      onIgnored: log,
      onEnded: (exitCode, reason) => {
        log(reason)
        void shutdown(exitCode)
      }
    })
  }
}

// macOS grants Accessibility and Screen Recording to the app that started us (Terminal), never to an SSH session.
async function warnMissingMacPermissions(driver: CuaDriver): Promise<void> {
  const state = await macPermissions(driver).catch(() => undefined)
  if (!state) return
  const missing = [!state.accessibility && 'Accessibility', !state.screenRecording && 'Screen Recording'].filter(
    Boolean
  )
  if (missing.length === 0) return
  log(
    `WARNING: macOS ${missing.join(' and ')} not granted to ${process.env.TERM_PROGRAM ?? 'the app running this daemon'}`
  )
  log(`  run \`${selfCommand()} setup\` in Terminal on this Mac, then \`doctor\` to verify`)
}

const controlFetch = async (config: DesktopConfig, path: string, timeoutMs: number): Promise<Response> =>
  fetch(`${controlBaseUrl(config)}${path}`, {
    headers: { [CONTROL_HEADER]: '1' },
    signal: AbortSignal.timeout(timeoutMs)
  })

async function daemonDoctor(
  config: DesktopConfig,
  captureMs = 15_000
): Promise<(Check[] & { host?: string }) | undefined> {
  const response = await controlFetch(
    config,
    `/control/doctor?captureTimeoutMs=${captureMs}`,
    captureMs + 120_000
  ).catch(() => undefined)
  if (!response?.ok) return undefined
  const checks: Check[] & { host?: string } = localizeChecks((await response.json()) as Check[])
  checks.host = ((detail) => /host app (.+)$/.exec(detail)?.[1] ?? (detail || 'the daemon'))(
    checks.find((check) => check.name === 'session')?.detail ?? ''
  )
  return checks
}

async function waitForDaemon(config: DesktopConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await controlFetch(config, '/control/status', 2000)
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

interface Grants {
  accessibility: boolean
  screenRecording: boolean
}

// .app mode: launchd starts the daemon in the GUI session, the app asks for its own grants, setup waits and restarts it.
async function setupMacApp(dir: string, config: DesktopConfig): Promise<Check[]> {
  const app = basename(appBundlePath()!)
  if (!appBundlePath()!.startsWith('/Applications/') && !appBundlePath()!.includes('/Applications/')) {
    console.log(
      `Note: the service runs ${process.execPath}; move ${app} to /Applications first if you plan to keep it.`
    )
  }
  installService(process.execPath, join(dir, 'daemon.log'))
  console.log(`Installed LaunchAgent ${plistPath()} and started ${app}.`)
  if (!(await waitForDaemon(config, 60_000)))
    throw new Error(`the service did not come up; see ${join(dir, 'daemon.log')}`)

  const grants = async (prompt: boolean): Promise<Grants> =>
    (await (await controlFetch(config, `/control/permissions${prompt ? '?prompt=1' : ''}`, 210_000)).json()) as Grants
  let state = await grants(false)
  const initiallyMissingScreen = !state.screenRecording
  if (!state.accessibility || !state.screenRecording) {
    console.log(
      `Requesting Accessibility and Screen Recording for ${app}: answer the macOS dialogs on this Mac's screen.`
    )
    state = await grants(true).catch(() => state)
    open(state.accessibility ? MAC_PANES.screenRecording : MAC_PANES.accessibility)
    console.log(`In System Settings switch on ${app} (Accessibility is "Device Control and Data Access" on macOS 27).`)
    const interactive = process.stdin.isTTY
    if (interactive) console.log('Waiting for the grants (press Enter to stop waiting)...')
    let skipped = false
    const rl = interactive ? createInterface({ input: process.stdin }) : undefined
    rl?.once('line', () => (skipped = true))
    const deadline = Date.now() + 10 * 60_000
    let screenPaneOpened = state.accessibility
    let lastRestart = Date.now()
    try {
      while (!skipped && Date.now() < deadline && !(state.accessibility && state.screenRecording)) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        // A Screen Recording grant only shows in a freshly started app, so keep restarting the service while waiting.
        if (state.accessibility && Date.now() - lastRestart > 20_000) {
          lastRestart = Date.now()
          restartService()
          await waitForDaemon(config, 60_000)
        }
        const next = await grants(false).catch(() => state)
        if (next.accessibility && !state.accessibility) console.log(`Accessibility granted to ${app}.`)
        if (next.screenRecording && !state.screenRecording) console.log(`Screen Recording granted to ${app}.`)
        state = next
        if (state.accessibility && !state.screenRecording && !screenPaneOpened) {
          screenPaneOpened = true
          open(MAC_PANES.screenRecording)
          console.log(`Now switch on Screen & System Audio Recording for ${app}.`)
        }
      }
    } finally {
      rl?.close()
    }
  }
  if (initiallyMissingScreen && state.screenRecording) {
    console.log(`Restarting ${app} so the Screen Recording grant takes effect...`)
    restartService()
    await waitForDaemon(config, 60_000)
  }
  console.log(`Checking from inside ${app} (if macOS asks to let it bypass the window picker, click Allow):`)
  return (await daemonDoctor(config, 120_000)) ?? doctor(setupContext(dir, config))
}

function serviceCommand(dir: string, config: DesktopConfig, action: string | undefined): void {
  if (process.platform === 'linux') return linuxServiceCommand(dir, config, action)
  if (process.platform !== 'darwin') throw new Error('service is macOS/Linux-only; on Windows use: autostart enable')
  if (action === 'install' || action === 'start' || action === 'restart') {
    if (!appBundlePath())
      throw new Error('run this from the AgentConnect Desktop.app binary (…/Contents/MacOS/agentconnect-desktop)')
  }
  if (action === 'install') installService(process.execPath, join(dir, 'daemon.log'))
  else if (action === 'uninstall') uninstallService()
  else if (action === 'start') startService()
  else if (action === 'stop') stopService()
  else if (action === 'restart') restartService()
  else if (action !== 'status') throw new Error('usage: service install | uninstall | start | stop | restart | status')
  const status = serviceStatus()
  console.log(
    JSON.stringify(
      { ...status, plist: plistPath(), log: join(dir, 'daemon.log'), port: config.port, app: hostApp() },
      null,
      2
    )
  )
}

function linuxServiceCommand(dir: string, config: DesktopConfig, action: string | undefined): void {
  if (action === 'install') linuxService.installService(dir, resolve(process.argv[1]!))
  else if (action === 'uninstall') linuxService.uninstallService()
  else if (action === 'start') linuxService.startService()
  else if (action === 'stop') linuxService.stopService()
  else if (action === 'restart') linuxService.restartService()
  else if (action !== 'status') throw new Error('usage: service install | uninstall | start | stop | restart | status')
  console.log(
    JSON.stringify(
      {
        ...linuxService.serviceStatus(),
        unit: linuxService.unitPath(),
        log: `journalctl --user -u ${linuxService.UNIT}`,
        port: config.port
      },
      null,
      2
    )
  )
}

// Linux: approvals ran in this process (tokens land in files the service reuses); then the session service takes over.
async function setupLinuxService(dir: string, config: DesktopConfig): Promise<Check[] | undefined> {
  const running = await waitForDaemon(config, 1000)
  if (running && !linuxService.serviceStatus().loaded) {
    console.log(`A daemon started by hand is already on port ${config.port}; stop it so the service can take over.`)
    return undefined
  }
  linuxService.installService(dir, resolve(process.argv[1]!))
  console.log(`Installed and started the systemd user service ${linuxService.unitPath()}.`)
  if (!(await waitForDaemon(config, 60_000))) {
    console.log(`The service did not come up; see: journalctl --user -u ${linuxService.UNIT}`)
    return undefined
  }
  return daemonDoctor(config)
}

function setupContext(dir: string, config: DesktopConfig): SetupContext {
  return {
    dir,
    config,
    driverCommand: resolveDriverPath(dir, config.driverPath),
    ffmpeg: resolveFfmpegPath(dir, config.ffmpegPath),
    log: (line) => console.log(line)
  }
}

// One-time install: downloads, a person's approvals, then doctor; with CP registration no local token is minted.
async function setup(
  dir: string,
  initial: DesktopConfig,
  clientName: string | undefined,
  withService: boolean
): Promise<void> {
  let config = initial
  let token: string | undefined
  if (clientName && !config.clients.some((client) => client.name === clientName)) {
    ;({ config, token } = issueClientToken(config, clientName))
  }
  saveConfig(config, dir)
  console.log(`Config: ${configPath(dir)}`)
  await installDriver(dir)
  if (config.webrtc && !config.ffmpegPath && !ffmpegAvailable(resolveFfmpegPath(dir)) && canInstallFfmpeg()) {
    await installFfmpeg(dir).catch((error: Error) => console.log(`ffmpeg install failed: ${error.message}`))
  }
  console.log('')
  let checks: Check[]
  if (process.platform === 'darwin' && appBundlePath()) {
    checks = await setupMacApp(dir, config)
  } else if (process.platform === 'linux' && withService && !linuxService.inGraphicalSession()) {
    // Over SSH there is no display to check or approve against; the session's autostart entry starts the service.
    linuxService.installService(dir, resolve(process.argv[1]!))
    console.log(`Installed the systemd user service ${linuxService.unitPath()}.`)
    console.log('No graphical session in this shell: the service starts when you next log in to the desktop.')
    console.log(`Then check it there with: ${selfCommand()} doctor`)
    if (token && clientName) printClientSetup(config, clientName, token)
    return
  } else {
    await setupPermissions(setupContext(dir, config))
    const serviceChecks = process.platform === 'linux' && withService ? await setupLinuxService(dir, config) : undefined
    console.log(serviceChecks ? '\nChecking from inside the service:' : '\nChecking the installation:')
    checks = serviceChecks ?? (await doctor(setupContext(dir, config)))
  }
  const ok = printChecks(checks)
  if (token && clientName) printClientSetup(config, clientName, token)
  const serviceRunning =
    process.platform === 'darwin'
      ? serviceStatus().loaded
      : process.platform === 'linux' && linuxService.serviceStatus().loaded
  console.log(
    !ok
      ? `Fix the failed checks, then run: ${selfCommand()} doctor`
      : withService && serviceRunning
        ? `The daemon runs as a background service: ${selfCommand()} service status | restart | stop`
        : `Start the daemon with: ${selfCommand()} run`
  )
  if (!ok) process.exitCode = 1
}

// Console window as the prototype's tray: p = pause (emergency stop), r = resume, Ctrl+C = quit.
function installConsoleControls(computer: Computer): void {
  if (!process.stdin.isTTY) return
  log('console controls: [p] pause all agent input   [r] resume   [s] status   [Ctrl+C] quit')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (data: Buffer) => {
    const key = data.toString('utf8')
    if (key === '\u0003') return void process.emit('SIGINT')
    if (key === 'p') computer.pause(DAEMON_CONSOLE_STOP_REASON)
    else if (key === 'r') computer.resume()
    else if (key === 's') console.error(JSON.stringify(computer.info(), null, 2))
  })
}

async function stdio(dir: string, config: DesktopConfig): Promise<void> {
  // A registered desktop acts only under its Control Plane channel, which stdio mode does not hold.
  const registration = loadRegistration(dir)
  const refusal = registration
    ? () =>
        registration.revokedAt
          ? 'this computer was revoked; register it again'
          : 'this computer is registered with a Control Plane; use the running daemon instead of stdio'
    : undefined
  const { driver, computer } = buildComputer(dir, config, undefined, refusal)
  const driverTools = await loadDriverTools(driver, config)
  const server = createComputerMcpServer({ computer, client: 'stdio', driverTools })
  await server.connect(new StdioServerTransport())
  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([server.close(), driver.close()])
    process.exit(0)
  }
  process.stdin.once('end', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

async function controlCommand(config: DesktopConfig, command: 'status' | 'pause' | 'resume'): Promise<void> {
  const response = await fetch(`${controlBaseUrl(config)}/control/${command}`, {
    method: command === 'status' ? 'GET' : 'POST',
    headers: { [CONTROL_HEADER]: '1' }
  })
  console.log(await response.text())
  if (!response.ok) process.exitCode = 1
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
