import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 7681

// Whether a listen address only accepts connections from this machine.
export const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)

// Whether a listen address binds every interface, so clients need one of the machine's own addresses.
export const isWildcardHost = (host: string): boolean => host === '0.0.0.0' || host === '::'

// The loopback address the owner CLI dials for /control and /healthz on a daemon listening on host.
export const controlHost = (host: string): string => {
  if (host === '::' || host === '::1') return '::1'
  if (isLoopbackHost(host)) return host
  return '127.0.0.1'
}

// Base URL of the daemon's loopback owner controls.
export const controlBaseUrl = (config: { host: string; port: number }): string => {
  const host = controlHost(config.host)
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`
}

const ClientEntry = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/)
})

export const DesktopConfig = z.object({
  // Loopback unless the owner asks for another address (`--host 0.0.0.0`): traffic is plain HTTP behind a bearer token.
  host: z.string().min(1).default(DEFAULT_HOST),
  port: z.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  clients: z.array(ClientEntry).default([]),
  // Explicit driver binary; otherwise the installed pinned driver, then PATH.
  driverPath: z.string().optional(),
  // Long edge of every screenshot; fixed per daemon so the driver's capture-to-screen mapping stays consistent.
  maxImageDimension: z.number().int().min(320).max(4096).default(1280),
  leaseIdleSeconds: z.number().int().min(10).max(3600).default(120),
  leaseMaxSeconds: z.number().int().min(60).max(86_400).default(1800),
  humanIdleSeconds: z.number().min(0).max(60).default(5),
  actionScreenshot: z.boolean().default(true),
  actionSettleMs: z.number().int().min(0).max(5000).default(400),
  allowSystemKeys: z.boolean().default(false),
  exposeDriverTools: z.boolean().default(false),
  driverCallTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  // WebRTC viewer at /view: ffmpeg screen capture to H.264; falls back to screenshot polling without ffmpeg.
  webrtc: z.boolean().default(true),
  // Hold the display awake while running: a sleeping display cannot be captured or controlled.
  keepAwake: z.boolean().default(true),
  ffmpegPath: z.string().optional(),
  streamFps: z.number().int().min(1).max(60).default(30),
  streamMaxWidth: z.number().int().min(320).max(3840).default(1920),
  streamBitrateKbps: z.number().int().min(200).max(50_000).default(2500),
  // Behind NAT (e.g. Docker bridge): the only ICE host address offered to viewers, instead of the one they connected to.
  rtcAddress: z.string().min(1).optional(),
  // Fixed UDP port range for WebRTC media, so it can be published or allowed through a firewall.
  rtcPortRange: z
    .tuple([z.number().int().min(1024).max(65_535), z.number().int().min(1024).max(65_535)])
    .refine(([min, max]) => min <= max, 'rtcPortRange must be [min, max]')
    .optional()
})
export type DesktopConfig = z.infer<typeof DesktopConfig>

export function dataDir(): string {
  if (process.env.AGENTCONNECT_DESKTOP_HOME) return process.env.AGENTCONNECT_DESKTOP_HOME
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentConnect', 'desktop')
  }
  return join(homedir(), '.agentconnect', 'desktop')
}

export const configPath = (dir = dataDir()): string => join(dir, 'config.json')

export function loadConfig(dir = dataDir()): DesktopConfig {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(configPath(dir), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return DesktopConfig.parse(raw)
}

export function saveConfig(config: DesktopConfig, dir = dataDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${configPath(dir)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, configPath(dir))
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

// Adds (or rotates) a client token; the plaintext is returned once and only its hash is stored.
export function issueClientToken(config: DesktopConfig, name: string): { config: DesktopConfig; token: string } {
  const token = `acd_${randomBytes(24).toString('base64url')}`
  const clients = config.clients.filter((client) => client.name !== name)
  clients.push(ClientEntry.parse({ name, tokenSha256: sha256(token) }))
  return { config: { ...config, clients }, token }
}

export function authenticate(config: DesktopConfig, authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
  if (!match) return undefined
  const presented = Buffer.from(sha256(match[1]!), 'hex')
  return config.clients.find((client) => timingSafeEqual(Buffer.from(client.tokenSha256, 'hex'), presented))?.name
}
