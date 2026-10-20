// The Computer resource's closed vocabularies, policy and capabilities (docs/designs/computer-use.md §2.2, §4.1).
import { z } from 'zod'

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

export type ComputerKind = (typeof COMPUTER_KINDS)[number]
export type ComputerIsolation = (typeof COMPUTER_ISOLATIONS)[number]
export type ComputerOs = (typeof COMPUTER_OSES)[number]
export type ComputerSession = (typeof COMPUTER_SESSIONS)[number]
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number]

/** Registration tokens live this long unless the console asks otherwise. */
export const COMPUTER_REGISTRATION_DEFAULT_TTL_MINUTES = 60
export const COMPUTER_REGISTRATION_MAX_TTL_MINUTES = 24 * 60

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

/** The policy a newly registered Computer starts with: its owner may manage it, no agent may use it yet. */
export function defaultComputerPolicy(ownerUserId: string): ComputerPolicy {
  return ComputerPolicySchema.parse({ allowedMembers: [ownerUserId] })
}

/** Reads a stored policy; a row written by a newer replica keeps its known fields and falls back on the rest. */
export function readComputerPolicy(raw: unknown, ownerUserId: string): ComputerPolicy {
  const parsed = ComputerPolicySchema.safeParse(raw)
  return parsed.success ? parsed.data : defaultComputerPolicy(ownerUserId)
}

/** The owner always stays among the members who may watch, take over and manage (§4.1). */
export function withOwnerMember(policy: ComputerPolicy, ownerUserId: string): ComputerPolicy {
  const members = [ownerUserId, ...policy.allowedMembers.filter((id) => id !== ownerUserId)]
  return { ...policy, allowedMembers: members }
}

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

/** Reads stored capabilities; an unreadable blob reports nothing rather than failing the read. */
export function readComputerCapabilities(raw: unknown): ComputerCapabilities {
  const parsed = ComputerCapabilitiesSchema.safeParse(raw)
  return parsed.success ? parsed.data : ComputerCapabilitiesSchema.parse({})
}
