import { describe, expect, it } from 'vitest'
import { daemonFromDto, type DaemonFleetDto } from '@/lib/api'
import { autoUpgradeNotes } from '@/lib/daemon-auto-upgrade'
import { daemonLifecycleLabel } from '@/components/console/DaemonLifecycleBadge'
import type { DaemonAutoUpgradeResult, DaemonLifecycleOp } from '@/lib/data'

const fleetRow = {
  daemonId: 'd-1',
  host: 'edge-1',
  name: 'edge-1',
  agentVersion: '1.40.2',
  releaseChannel: 'latest',
  latestVersion: '1.41.0',
  availableVersions: ['1.41.0', '1.40.2'],
  lifecycleOp: null,
  status: 'ready',
  health: 'ok',
  load: null,
  sessionEpoch: 1,
  maxAgents: 8,
  activeSessions: 0,
  lastSeenAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: null,
  lastModifiedAt: '2026-08-01T00:00:00.000Z',
  lastModifiedBy: null,
  sessionRetention: '90d',
  workspaceRetention: '7d',
  visibility: 'org',
  sharedWith: [],
  canEdit: true,
  canManageSharing: true,
  canManageLifecycle: true
} as DaemonFleetDto

const autoOp: DaemonLifecycleOp = {
  id: 'op-1',
  op: 'upgrade',
  status: 'pending',
  phase: null,
  targetVersion: '1.41.0',
  outcome: null,
  trigger: 'auto'
}

const result = (over: Partial<DaemonAutoUpgradeResult>): DaemonAutoUpgradeResult => ({
  id: 'op-1',
  status: 'succeeded',
  targetVersion: '1.41.0',
  outcome: null,
  settledAt: '2026-10-28T10:00:00.000Z',
  ...over
})

describe('daemon auto-upgrade mapping', () => {
  it('reads an older CP as switched off, unsupported, and every op as manual', () => {
    const row = daemonFromDto({ ...fleetRow, lifecycleOp: { ...autoOp, trigger: undefined } })
    expect(row.autoUpgrade).toBe(false)
    expect(row.autoUpgradeSupported).toBe(false)
    expect(row.lastAutoUpgrade).toBeNull()
    expect(row.lifecycleOp?.trigger).toBe('manual')
  })

  it('carries the switch, support, trigger, and last automatic outcome through', () => {
    const last = result({ status: 'failed', outcome: 'rolled back: crashed on start' })
    const row = daemonFromDto({
      ...fleetRow,
      autoUpgrade: true,
      autoUpgradeSupported: true,
      lastAutoUpgrade: last,
      lifecycleOp: autoOp
    })
    expect(row.autoUpgrade).toBe(true)
    expect(row.autoUpgradeSupported).toBe(true)
    expect(row.lastAutoUpgrade).toEqual(last)
    expect(row.lifecycleOp?.trigger).toBe('auto')
  })
})

describe('daemonLifecycleLabel', () => {
  it('names an automatic upgrade as such, with or without its target', () => {
    expect(daemonLifecycleLabel(autoOp)).toBe('Auto-upgrading to v1.41.0…')
    expect(daemonLifecycleLabel({ ...autoOp, targetVersion: null })).toBe('Auto-upgrading…')
    expect(daemonLifecycleLabel({ ...autoOp, phase: 'preparing' })).toBe('Preparing auto-upgrade to v1.41.0…')
  })

  it('keeps the manual labels unchanged', () => {
    expect(daemonLifecycleLabel({ ...autoOp, trigger: 'manual' })).toBe('Upgrading to 1.41.0…')
    expect(daemonLifecycleLabel({ ...autoOp, trigger: undefined, op: 'restart', targetVersion: null })).toBe(
      'Restarting…'
    )
  })
})

describe('autoUpgradeNotes', () => {
  const base = {
    autoUpgrade: true,
    upgradeAvailable: true,
    latestVersion: '1.41.0',
    lifecycleOp: null,
    lastAutoUpgrade: null
  }

  it('waits for an idle window while the switch is on and a release is newer', () => {
    expect(autoUpgradeNotes(base)).toEqual([{ kind: 'waiting', version: '1.41.0' }])
    expect(autoUpgradeNotes({ ...base, autoUpgrade: false })).toEqual([])
    expect(autoUpgradeNotes({ ...base, upgradeAvailable: false })).toEqual([])
  })

  it('shows an automatic op in flight instead of waiting', () => {
    expect(autoUpgradeNotes({ ...base, lifecycleOp: autoOp })).toEqual([{ kind: 'upgrading', version: '1.41.0' }])
    expect(autoUpgradeNotes({ ...base, lastAutoUpgrade: result({ status: 'pending', settledAt: null }) })).toEqual([
      { kind: 'upgrading', version: '1.41.0' }
    ])
  })

  it('does not wait behind a manual op that is still pending', () => {
    expect(autoUpgradeNotes({ ...base, lifecycleOp: { ...autoOp, trigger: 'manual' } })).toEqual([])
  })

  it('reports the last outcome, and the wait for a newer release after it', () => {
    const upgraded = result({ targetVersion: '1.40.2' })
    expect(autoUpgradeNotes({ ...base, lastAutoUpgrade: upgraded })).toEqual([
      { kind: 'upgraded', version: '1.40.2', settledAt: upgraded.settledAt },
      { kind: 'waiting', version: '1.41.0' }
    ])
  })

  it('does not wait on a release the daemon has given up on', () => {
    const failed = result({ status: 'failed', outcome: 'rolled back: crashed on start' })
    expect(autoUpgradeNotes({ ...base, lastAutoUpgrade: failed })).toEqual([
      { kind: 'failed', version: '1.41.0', outcome: 'rolled back: crashed on start' }
    ])
  })
})
