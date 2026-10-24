'use client'

// Console helpers for Computers (computer-use.md §2.2, §10): reads, status presentation and the install command.
import { useCallback } from 'react'
import useSWR from 'swr'
import { useFormatter } from 'next-intl'
import type { ComputerAgentAccess, ComputerDoctorCheck, ComputerStatus } from '@agentconnect.md/protocol/computer'
import {
  fetchComputer,
  fetchComputerPool,
  fetchComputerEgress,
  type ComputerEgressDto,
  fetchComputers,
  type ComputerDto,
  type ComputerPoolPhase,
  type ComputerPoolStatusDto,
  type ComputerRegistrationDto
} from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'

/** How often an open Computers page re-reads status; the desktop heartbeats every 15 s. */
export const COMPUTERS_REFRESH_MS = 10_000

export function useComputers() {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  return useSWR<ComputerDto[]>(
    !MOCK_MODE && orgId ? ['computers', orgId] : null,
    ([, scoped]: [string, string]) => fetchComputers(scoped),
    { refreshInterval: COMPUTERS_REFRESH_MS }
  )
}

export function useComputer(id: string | undefined) {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  return useSWR<ComputerDto>(
    !MOCK_MODE && orgId && id ? ['computer', orgId, id] : null,
    ([, scoped, cid]: [string, string, string]) => fetchComputer(cid, scoped),
    { refreshInterval: COMPUTERS_REFRESH_MS }
  )
}

/** Whether this deployment runs managed computers (computer-use.md §15.1); an older Control Plane reads as none. */
export function useComputerPool() {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  return useSWR<ComputerPoolStatusDto>(
    !MOCK_MODE && orgId ? ['computer-pool', orgId] : null,
    ([, scoped]: [string, string]) =>
      fetchComputerPool(scoped).catch((): ComputerPoolStatusDto => ({ enabled: false, available: false })),
    { refreshInterval: COMPUTERS_REFRESH_MS * 3 }
  )
}

/** Where the organization's managed computers' browser traffic leaves (computer-use.md §15.4); null before it existed. */
export function useComputerEgress() {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  return useSWR<ComputerEgressDto | null>(
    !MOCK_MODE && orgId ? ['computer-egress', orgId] : null,
    ([, scoped]: [string, string]) => fetchComputerEgress(scoped).catch(() => null)
  )
}

/** A pool phase worth naming beside the status: the computer is on its way somewhere, or stuck. */
export function poolPhaseNote(computer: Pick<ComputerDto, 'poolPhase'>): ComputerPoolPhase | null {
  const phase = computer.poolPhase
  return phase && phase !== 'awake' && phase !== 'sleeping' ? phase : null
}

/** The managed computers made for this agent: its one `per-agent` desktop and any session desktops. */
export function agentOwnComputers(computers: readonly ComputerDto[], agentId: string): ComputerDto[] {
  return computers.filter(
    (c) => c.ownerAgentId === agentId && (c.allocation === 'per-agent' || c.allocation === 'ephemeral')
  )
}

/** Relative time against the render's clock, so the formatter never falls back to its own. */
export function useAgo(): (iso: string) => string {
  const format = useFormatter()
  return useCallback((iso: string) => format.relativeTime(new Date(iso), { now: Date.now() }), [format])
}

export interface ComputerStatusTone {
  dot: string
  bg: string
  text: string
}

// The amber text matches the daemon status pills (lib/data STATUS_MAP), which have no token for it.
const PAUSED: ComputerStatusTone = { dot: 'var(--status-paused)', bg: 'var(--status-paused-soft)', text: '#9a6500' }

const TONES: Record<ComputerStatus, ComputerStatusTone> = {
  online: { dot: 'var(--status-online)', bg: 'var(--status-online-soft)', text: 'var(--status-online-text, #0f7a48)' },
  busy: { dot: 'var(--status-info)', bg: 'var(--status-info-soft)', text: 'var(--status-info)' },
  paused: PAUSED,
  human_in_control: PAUSED,
  locked: PAUSED,
  offline: { dot: 'var(--text-tertiary)', bg: 'var(--surface-sunken)', text: 'var(--text-secondary)' },
  sleeping: { dot: 'var(--text-tertiary)', bg: 'var(--surface-sunken)', text: 'var(--text-secondary)' },
  revoked: { dot: 'var(--status-error)', bg: 'var(--status-error-soft)', text: 'var(--status-error)' }
}

export function computerStatusTone(status: ComputerStatus): ComputerStatusTone {
  return TONES[status] ?? TONES.offline
}

/** Failures first, then warnings, then the rest, keeping the desktop's order within each. */
export function sortedDoctorChecks(checks: ComputerDoctorCheck[]): ComputerDoctorCheck[] {
  const rank = { fail: 0, warn: 1, info: 2, ok: 3 } as const
  return checks
    .map((check, i) => ({ check, i }))
    .sort((a, b) => rank[a.check.status] - rank[b.check.status] || a.i - b.i)
    .map(({ check }) => check)
}

export function doctorCounts(computer: Pick<ComputerDto, 'doctor'>): { fail: number; warn: number; total: number } {
  const checks = computer.doctor?.checks ?? []
  return {
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    total: checks.length
  }
}

const NO_ACCESS: ComputerAgentAccess = { mode: 'none', agents: [] }

/** A Computer's agent access (computer-use.md §4.1); an older Control Plane that sends none reads as no agents. */
export function agentAccessOf(computer: Pick<ComputerDto, 'agentAccess'>): ComputerAgentAccess {
  return computer.agentAccess ?? NO_ACCESS
}

/** Whether a Computer's agent access admits this agent: it lists the agent or grants every agent. */
export function computerGrantsAgent(computer: Pick<ComputerDto, 'agentAccess'>, agentId: string): boolean {
  const access = agentAccessOf(computer)
  return access.mode === 'all' || (access.mode === 'selected' && access.agents.includes(agentId))
}

export type InstallOs = 'linux' | 'macos' | 'windows' | 'docker'

const CLI = '@agentconnect.md/cli'
const DEFAULT_DESKTOP_IMAGE = 'ghcr.io/agentconnect-md/desktop:latest'

/** The one-line command that installs the computer daemon and registers this desktop (computer-use.md §3.5, §3.6). */
export function computerInstallCommand(
  os: InstallOs,
  registration: Pick<ComputerRegistrationDto, 'token' | 'exchangeUrl' | 'desktopImage' | 'cliChannel'>
): string {
  // PowerShell takes double quotes; POSIX shells single quotes, which keep the token literal.
  const q = (value: string) => (os === 'windows' ? `"${value}"` : `'${value}'`)
  // The desktop image on a server (computer-use.md §3.8); the volume keeps the key the token buys.
  if (os === 'docker') {
    return `docker run -d --name agentconnect-desktop --hostname agentconnect-desktop --restart unless-stopped --shm-size=1g -v agentconnect-desktop:/home/desktop -e LISTEN_HOST=127.0.0.1 -e AGENTCONNECT_CP_URL=${q(registration.exchangeUrl)} -e AGENTCONNECT_REGISTER_TOKEN=${q(registration.token)} ${registration.desktopImage ?? DEFAULT_DESKTOP_IMAGE}`
  }
  const register = `--register ${q(registration.token)} --cp-url ${q(registration.exchangeUrl)}`
  // Always a dist-tag: an untagged npx runs npm latest, which can predate `computer install` while this CP is an rc.
  const rc = registration.cliChannel !== 'stable'
  const cli = `${CLI}@${rc ? 'rc' : 'latest'}`
  // Linux installs the daemon from npm into the CLI's version store; macOS and Windows run setup in their installed app (M3 / M4).
  if (os === 'linux') return `npx -y ${cli} computer install${rc ? ' --channel rc' : ''} ${register}`
  return `npx -y ${cli} computer setup ${register}`
}
