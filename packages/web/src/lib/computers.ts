'use client'

// Console helpers for Computers (computer-use.md §2.2, §10): reads, status presentation and the install command.
import { useCallback } from 'react'
import useSWR from 'swr'
import { useFormatter } from 'next-intl'
import type { ComputerDoctorCheck, ComputerStatus } from '@agentconnect.md/protocol/computer'
import { fetchComputer, fetchComputers, type ComputerDto } from '@/lib/api'
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

/** Agents a Computer's policy grants that the caller can see, in policy order. */
export function grantedAgentIds(computer: Pick<ComputerDto, 'policy'>): string[] {
  return computer.policy.allowedAgents
}

export type InstallOs = 'linux' | 'macos' | 'windows'

const CLI = '@agentconnect.md/cli'

/** The one-line command that installs the desktop daemon's service and registers this desktop (computer-use.md §3.6). */
export function computerInstallCommand(os: InstallOs, token: string, exchangeUrl: string): string {
  // PowerShell takes double quotes; POSIX shells single quotes, which keep the token literal.
  const q = (value: string) => (os === 'windows' ? `"${value}"` : `'${value}'`)
  return `npx -y ${CLI} desktop setup --register ${q(token)} --cp-url ${q(exchangeUrl)}`
}
