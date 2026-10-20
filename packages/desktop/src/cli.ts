#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { fileAuditSink } from './audit.js'
import { disableAutostart, enableAutostart, startAutostartNow } from './autostart.js'
import { Computer } from './computer.js'
import {
  authenticate,
  configPath,
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
import { createComputerMcpServer, exposedDriverTools } from './tools.js'
import { createViewer, type Viewer } from './viewer.js'
import { hasCommand, keepDisplayAwake } from './keep-awake.js'
import { appBundlePath, runSelf } from './self.js'
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
  MAC_PANES,
  macPermissions,
  open,
  printChecks,
  setupPermissions,
  type Check,
  type SetupContext
} from './setup.js'

const HELP = `agentconnect-desktop — prototype desktop daemon (Cua Driver + computer_* MCP tools)

Usage: agentconnect-desktop <command> [options]

Commands:
  setup [--client NAME] [--host H] [--port P] [--no-service]
                                               one-time install, run on the desktop itself: config + client token,
                                               Cua Driver ${CUA_DRIVER_VERSION}, ffmpeg, then the OS approvals (macOS
                                               Accessibility + Screen Recording, Windows Firewall), then doctor
  init [--client NAME] [--host H] [--port P]   non-interactive part of setup: config + token + Cua Driver
  install-driver                               download and verify the pinned Cua Driver build
  install-ffmpeg                               download the pinned ffmpeg (${FFMPEG_VERSION}) for the WebRTC viewer
  run [--host H] [--port P] [--expose-driver-tools] [--rtc-address A] [--rtc-ports MIN-MAX]
                                               foreground: serve MCP at http://H:P/mcp and the remote
                                               desktop viewer at http://H:P/view until Ctrl+C
                                               (first run creates the token and downloads the driver);
                                               H defaults to 127.0.0.1, --host 0.0.0.0 opens every interface
  stdio [--expose-driver-tools]                serve MCP over stdio (agent runs on this machine)
  token add NAME | token list | token remove NAME
  status | pause | resume                      owner controls for the running daemon (loopback)
  doctor                                       check install, session, permissions, capture, firewall
                                               (read-only; exits 1 when a required check fails)
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
      'rtc-address': { type: 'string' },
      'rtc-ports': { type: 'string' },
      client: { type: 'string', default: 'claude' },
      'expose-driver-tools': { type: 'boolean' },
      json: { type: 'boolean' },
      here: { type: 'boolean' },
      prompt: { type: 'boolean' },
      'capture-timeout': { type: 'string' },
      'no-service': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [command, ...rest] = positionals
  if (values.help || !command) return void console.log(HELP)
  const dir = dataDir()
  const overrides = (config: DesktopConfig): DesktopConfig => ({
    ...config,
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values['expose-driver-tools'] ? { exposeDriverTools: true } : {}),
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
    case 'setup':
      return setup(dir, overrides(loadConfig(dir)), values.client, !values['no-service'])
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
      const config = loadConfig(dir)
      // On macOS the daemon's permissions are what matter; a running daemon checks from inside itself.
      const remote = process.platform !== 'win32' && !values.here ? await daemonDoctor(config) : undefined
      const captureMs = Number(values['capture-timeout']) || 15_000
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
      throw new Error(`unknown command "${command}"\n\n${HELP}`)
  }
}

const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net!.address)

function printClientSetup(config: DesktopConfig, client: string, token: string): void {
  const host = urlHost(isWildcardHost(config.host) ? (lanAddresses()[0] ?? hostname()) : config.host)
  console.log(`\nClient "${client}" token (shown once, stored only as a hash):\n  ${token}\n`)
  console.log('Register with Claude Code:')
  console.log(
    `  claude mcp add --transport http computer http://${host}:${config.port}/mcp --header "Authorization: Bearer ${token}"\n`
  )
  console.log(`Remote desktop in a browser (the token stays in the URL fragment, never sent to the server):`)
  console.log(`  http://${host}:${config.port}/view#token=${token}\n`)
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

function buildComputer(dir: string, config: DesktopConfig, onStatus?: (status: string) => void) {
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
    audit: fileAuditSink(join(dir, 'audit.log')),
    log,
    ...(onStatus ? { onStatus } : {})
  })
  return { driver, computer }
}

// Viewer with WebRTC when ffmpeg is usable; a missing ffmpeg is fetched in the background where a build is pinned.
function buildViewer(dir: string, config: DesktopConfig, computer: Computer): Viewer {
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
        onMessage: (client, message) => viewer.channelMessage(client, message),
        ...(config.rtcAddress ? { advertiseAddress: config.rtcAddress } : {}),
        ...(config.rtcPortRange ? { portRange: config.rtcPortRange } : {})
      })
    : undefined
  const viewer: Viewer = createViewer({
    computer,
    authenticate: (header) => authenticate(config, header),
    log,
    ...(rtc ? { rtc } : {}),
    rtcUnavailable: () =>
      ffmpegState === 'ok'
        ? undefined
        : ffmpegState === 'downloading'
          ? 'ffmpeg is still downloading'
          : 'ffmpeg not found',
    streamError: () => stream.lastError
  })
  return viewer
}

async function loadDriverTools(driver: CuaDriver, config: DesktopConfig): Promise<DriverTool[]> {
  if (!config.exposeDriverTools) return []
  return exposedDriverTools(await driver.listTools())
}

async function run(dir: string, initial: DesktopConfig, clientName: string): Promise<void> {
  // First run sets itself up, so unzip + `run` is enough; nothing is installed as a service.
  let config = initial
  if (config.clients.length === 0) {
    const issued = issueClientToken(config, clientName)
    config = issued.config
    saveConfig(config, dir)
    printClientSetup(config, clientName, issued.token)
  }
  if (!config.driverPath && !existsSync(installedDriverPath(dir))) await installDriver(dir)
  const setTitle = (status: string): void => {
    process.title = `AgentConnect Desktop — ${status}`
  }
  const { driver, computer } = buildComputer(dir, config, setTitle)
  setTitle('online')
  await driver.call('get_screen_size', {})
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
  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    computer,
    authenticate: (header) => authenticate(config, header),
    createMcpServer: (client) => createComputerMcpServer({ computer, client, driverTools }),
    log,
    viewer: buildViewer(dir, config, computer)
  })
  const urls = isWildcardHost(config.host)
    ? [server.url, ...lanAddresses().map((ip) => `http://${ip}:${config.port}/mcp`)]
    : [server.url]
  log(`MCP endpoint ${urls.join(' , ')} (clients: ${config.clients.map((client) => client.name).join(', ')})`)
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
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    log('shutting down')
    computer.pause('daemon shutting down')
    releaseDisplay()
    await Promise.allSettled([server.close(), driver.close()])
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
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
  log('  run `agentconnect-desktop setup` in Terminal on this Mac, then `doctor` to verify')
}

const controlFetch = async (config: DesktopConfig, path: string, timeoutMs: number): Promise<Response> =>
  fetch(`http://127.0.0.1:${config.port}${path}`, {
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
  const checks = (await response.json()) as Check[] & { host?: string }
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

// One-time install on the desktop: everything that needs downloading or a person's approval, then doctor.
async function setup(dir: string, initial: DesktopConfig, clientName: string, withService: boolean): Promise<void> {
  let config = initial
  let token: string | undefined
  if (!config.clients.some((client) => client.name === clientName)) {
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
  } else {
    await setupPermissions(setupContext(dir, config))
    const serviceChecks = process.platform === 'linux' && withService ? await setupLinuxService(dir, config) : undefined
    console.log(serviceChecks ? '\nChecking from inside the service:' : '\nChecking the installation:')
    checks = serviceChecks ?? (await doctor(setupContext(dir, config)))
  }
  const ok = printChecks(checks)
  if (token) printClientSetup(config, clientName, token)
  const serviceRunning =
    process.platform === 'darwin'
      ? serviceStatus().loaded
      : process.platform === 'linux' && linuxService.serviceStatus().loaded
  console.log(
    !ok
      ? 'Fix the failed checks, then run: agentconnect-desktop doctor'
      : withService && serviceRunning
        ? 'The daemon runs as a background service: agentconnect-desktop service status | restart | stop'
        : 'Start the daemon with: agentconnect-desktop run'
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
    if (key === 'p') computer.pause('stopped from the daemon console')
    else if (key === 'r') computer.resume()
    else if (key === 's') console.error(JSON.stringify(computer.info(), null, 2))
  })
}

async function stdio(dir: string, config: DesktopConfig): Promise<void> {
  const { driver, computer } = buildComputer(dir, config)
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
  const response = await fetch(`http://127.0.0.1:${config.port}/control/${command}`, {
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
