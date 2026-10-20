import { z } from 'zod'
import { frameSchema } from '../envelope.js'
import { tolerantSchemas } from '../tolerant.js'
import { buildEnvelopeRaw, decodeEnvelopeWith, type BuildOpts, type DecodeResultOf } from '../wire.js'
import { ErrorFrame } from './error.js'
import { ComputerControlLease } from './computer-lease.js'
import { COMPUTER_RELAYS_MAX, ComputerRelayEntry } from './computer-channel.js'

// The lease schemas ride both wires, so the `./computer` entry serves them to the desktop too.
export * from './computer-lease.js'
// The data plane's grant, relays and channel tokens, for the desktop and the agent daemon alike.
export * from './computer-channel.js'
export * from './relay-computer.js'
export * from '../computer-channel-token.js'

// The Computer channel (computer-use.md §3.6, §8.2): the desktop daemon's own control wire; no screen content rides it.

/** Subprotocol negotiated on the desktop daemon ↔ CP socket. */
export const COMPUTER_CP_SUBPROTOCOL = 'agentconnect.computer.v1'

/** The channel's public path; the CP serves it under both `/v1` and `/api/v1`. */
export const COMPUTER_WS_PUBLIC_PATH = '/v1/computers/ws'

/** The registration exchange's public path, beside the channel. */
export const COMPUTER_REGISTER_PUBLIC_PATH = '/v1/computers/register'

export const COMPUTER_KINDS = ['self-hosted', 'managed'] as const
export const COMPUTER_ISOLATIONS = ['none', 'container', 'vm'] as const
export const COMPUTER_OSES = ['macos', 'windows', 'linux'] as const
export const COMPUTER_SESSIONS = ['aqua', 'console', 'rdp', 'x11', 'xvfb', 'wayland-gnome'] as const
export const COMPUTER_STATUSES = [
  'online',
  'offline',
  'locked',
  'paused',
  'human_in_control',
  'busy',
  'revoked'
] as const
/** What a connected desktop daemon reports; `offline` and `revoked` are the CP's own verdicts. */
export const COMPUTER_LIVE_STATUSES = ['online', 'locked', 'paused', 'human_in_control', 'busy'] as const

export type ComputerKind = (typeof COMPUTER_KINDS)[number]
export type ComputerIsolation = (typeof COMPUTER_ISOLATIONS)[number]
export type ComputerOs = (typeof COMPUTER_OSES)[number]
export type ComputerSession = (typeof COMPUTER_SESSIONS)[number]
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number]
export type ComputerLiveStatus = (typeof COMPUTER_LIVE_STATUSES)[number]

const HHMM = '(?:[01]\\d|2[0-3]):[0-5]\\d'
const QUIET_RANGE_RE = new RegExp(`^${HHMM}-${HHMM}$`)

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const AppId = z.string().trim().min(1).max(256)

export const ComputerApprovalsSchema = z.object({
  firstInputPerSession: z.boolean().default(true),
  launchApp: z.enum(['always', 'session', 'never-ask']).default('always'),
  submitLikeKeys: z.boolean().default(true)
})

/** Who may use a Computer and how (computer-use.md §4.1); every field has a safe default. */
export const ComputerPolicySchema = z
  .object({
    allowedAgents: z.array(z.uuid()).max(200).default([]),
    allowedMembers: z.array(z.string().min(1).max(128)).max(500).default([]),
    agentMode: z.enum(['view', 'control']).default('control'),
    approvals: ComputerApprovalsSchema.default({
      firstInputPerSession: true,
      launchApp: 'always',
      submitLikeKeys: true
    }),
    appAllowlist: z.array(AppId).max(200).optional(),
    redactApps: z.array(AppId).max(200).default([]),
    exposeDriverTools: z.boolean().default(false),
    quietHours: z
      .object({
        tz: z.string().min(1).max(64).refine(isTimeZone, 'unknown IANA time zone'),
        ranges: z.array(z.string().regex(QUIET_RANGE_RE, 'expected HH:MM-HH:MM')).min(1).max(24)
      })
      .optional(),
    leaseIdleSeconds: z.number().int().min(10).max(3600).default(120),
    leaseMaxSeconds: z.number().int().min(60).max(86_400).default(1800)
  })
  .refine((p) => p.leaseIdleSeconds <= p.leaseMaxSeconds, {
    message: 'leaseIdleSeconds must not exceed leaseMaxSeconds',
    path: ['leaseIdleSeconds']
  })
export type ComputerPolicy = z.infer<typeof ComputerPolicySchema>

/** What the desktop daemon reports from `doctor` and its heartbeat (§2.2, §3.5). */
export const ComputerCapabilitiesSchema = z.object({
  screenshot: z.boolean().default(false),
  input: z.boolean().default(false),
  textInput: z.enum(['full', 'keymap-only']).default('full'),
  backgroundInput: z.boolean().default(false),
  accessibilityTree: z.boolean().default(false),
  viewer: z.boolean().default(false),
  displays: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        width: z.number().int().positive().max(100_000),
        height: z.number().int().positive().max(100_000),
        scale: z.number().positive().max(16)
      })
    )
    .max(16)
    .default([]),
  permissions: z
    .object({
      accessibility: z.boolean().optional(),
      screenRecording: z.boolean().optional(),
      portal: z.boolean().optional(),
      firewall: z.boolean().optional()
    })
    .default({})
})
export type ComputerCapabilities = z.infer<typeof ComputerCapabilitiesSchema>

/** One `doctor` check; every failure carries its fix (§3.5). */
export const ComputerDoctorCheck = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(['ok', 'info', 'warn', 'fail']),
  detail: z.string().max(1000),
  fix: z.string().max(1000).optional()
})
export type ComputerDoctorCheck = z.infer<typeof ComputerDoctorCheck>

export const ComputerDoctorReport = z.object({
  checkedAt: z.string().datetime(),
  checks: z.array(ComputerDoctorCheck).max(64)
})
export type ComputerDoctorReport = z.infer<typeof ComputerDoctorReport>

/** The short-lived key only the CP renews; the desktop verifies channel tokens with it and stops when the last expires (§8.2). */
export const ComputerChannelCredential = z.object({
  keyId: z.string().min(1).max(64),
  // 32 random-looking bytes, base64url without padding; secret material, never logged.
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
})
export type ComputerChannelCredential = z.infer<typeof ComputerChannelCredential>

// D→C REQ, the first frame; the key is secret material, never logged.
export const ComputerAuth = z
  .object({
    apiKey: z.string().min(1).max(256),
    desktopDaemonVersion: z.string().trim().min(1).max(64)
  })
  .strict()
export type ComputerAuth = z.infer<typeof ComputerAuth>

// C→D REP; a refusal is an `error` REP then close 4401.
export const ComputerAuthOk = z.object({
  computerId: z.string().uuid(),
  orgId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  heartbeatSec: z.number().int().positive(),
  serverTime: z.string().datetime(),
  credential: ComputerChannelCredential,
  policy: ComputerPolicySchema
})
export type ComputerAuthOk = z.infer<typeof ComputerAuthOk>

// D→C EVT every heartbeatSec; the profile, capabilities and doctor ride along when they change and after every auth.
export const ComputerHeartbeat = z
  .object({
    status: z.enum(COMPUTER_LIVE_STATUSES),
    osVersion: z.string().trim().min(1).max(120).optional(),
    session: z.enum(COMPUTER_SESSIONS).optional(),
    desktopDaemonVersion: z.string().trim().min(1).max(64).optional(),
    driverVersion: z.string().trim().min(1).max(64).optional(),
    capabilities: ComputerCapabilitiesSchema.optional(),
    doctor: ComputerDoctorReport.optional(),
    // The local lease, how long since its last input, and how long it has been held without idling out.
    lease: z
      .object({
        holder: z.string().min(1).max(256),
        idleMs: z.number().int().min(0),
        heldMs: z.number().int().min(0).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type ComputerHeartbeat = z.infer<typeof ComputerHeartbeat>

// C→D EVT: a renewed credential, sent before the current one runs out.
export const ComputerCredentialRenewal = z.object({ credential: ComputerChannelCredential })
export type ComputerCredentialRenewal = z.infer<typeof ComputerCredentialRenewal>

// C→D EVT: the owner changed the policy.
export const ComputerPolicyPush = z.object({ policy: ComputerPolicySchema })
export type ComputerPolicyPush = z.infer<typeof ComputerPolicyPush>

// C→D EVT, then close 4401: stop all input, close viewers, forget the key.
export const ComputerRevoke = z.object({
  reason: z.enum(['revoked', 'deleted', 'owner_removed']),
  message: z.string().max(500).optional()
})
export type ComputerRevoke = z.infer<typeof ComputerRevoke>

// C→D EVT: the control lease the CP granted, or null when none is held; only its holder may send input.
export const ComputerLeasePush = z.object({ lease: ComputerControlLease.nullable() })
export type ComputerLeasePush = z.infer<typeof ComputerLeasePush>

// C→D EVT after auth and whenever the roster changes: the relays to dial out to for the data plane (§3.7).
export const ComputerRelaysPush = z.object({ relays: z.array(ComputerRelayEntry).max(COMPUTER_RELAYS_MAX) })
export type ComputerRelaysPush = z.infer<typeof ComputerRelaysPush>

export const COMPUTER_CP_SCHEMAS = {
  'computer/auth': ComputerAuth,
  'computer/auth/ok': ComputerAuthOk,
  'computer/heartbeat': ComputerHeartbeat,
  'computer/credential': ComputerCredentialRenewal,
  'computer/policy': ComputerPolicyPush,
  'computer/revoke': ComputerRevoke,
  'computer/lease': ComputerLeasePush,
  'computer/relays': ComputerRelaysPush,
  error: ErrorFrame
} as const

export type ComputerCpFrameType = keyof typeof COMPUTER_CP_SCHEMAS
export const COMPUTER_CP_FRAME_TYPES = Object.keys(COMPUTER_CP_SCHEMAS) as ComputerCpFrameType[]

export const ComputerCpFrame = z.discriminatedUnion('type', [
  frameSchema('computer/auth', COMPUTER_CP_SCHEMAS['computer/auth']),
  frameSchema('computer/auth/ok', COMPUTER_CP_SCHEMAS['computer/auth/ok']),
  frameSchema('computer/heartbeat', COMPUTER_CP_SCHEMAS['computer/heartbeat']),
  frameSchema('computer/credential', COMPUTER_CP_SCHEMAS['computer/credential']),
  frameSchema('computer/policy', COMPUTER_CP_SCHEMAS['computer/policy']),
  frameSchema('computer/revoke', COMPUTER_CP_SCHEMAS['computer/revoke']),
  frameSchema('computer/lease', COMPUTER_CP_SCHEMAS['computer/lease']),
  frameSchema('computer/relays', COMPUTER_CP_SCHEMAS['computer/relays']),
  frameSchema('error', COMPUTER_CP_SCHEMAS['error'])
])
export type ComputerCpFrame = z.infer<typeof ComputerCpFrame>

// The desktop reads CP-authored frames tolerantly, so a field a newer CP adds never fails an older desktop's handshake.
const TOLERANT_COMPUTER_CP_SCHEMAS = tolerantSchemas(COMPUTER_CP_SCHEMAS)

/** CP side: decode a desktop daemon's frame strictly. */
export function decodeComputerCpFrame(text: string): DecodeResultOf<ComputerCpFrame> {
  return decodeEnvelopeWith<ComputerCpFrame>(COMPUTER_CP_SCHEMAS, text)
}

/** Desktop side: decode a CP frame, dropping keys this build does not know. */
export function decodeComputerCpFrameTolerant(text: string): DecodeResultOf<ComputerCpFrame> {
  return decodeEnvelopeWith<ComputerCpFrame>(TOLERANT_COMPUTER_CP_SCHEMAS, text)
}

export function buildComputerCpFrame<T extends ComputerCpFrameType>(
  type: T,
  payload: z.input<(typeof COMPUTER_CP_SCHEMAS)[T]>,
  opts: BuildOpts = {}
): ComputerCpFrame {
  return buildEnvelopeRaw(type, payload, opts) as ComputerCpFrame
}
