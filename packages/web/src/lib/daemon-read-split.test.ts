/**
 * The fleet read is split by change rate: `GET /daemons` is polled for liveness, its
 * capability half is read separately, and a runtime's model catalog only comes from the
 * single-daemon read. `DaemonRow` is stitched back together here so views never learn
 * that happened — these tests pin the stitching and the deliberately absent catalog.
 */
import { describe, expect, it } from 'vitest'
import { daemonFromDto, withDaemonCapability, type DaemonCapabilityDto, type DaemonFleetDto } from '@/lib/api'
import { mergeDaemonCatalogs } from '@/lib/use-daemon-detail'
import type { DaemonRow } from '@/lib/data'

const fleetRow: DaemonFleetDto = {
  daemonId: 'd-1',
  host: 'edge-1',
  name: 'edge-1',
  agentVersion: '1.51.0',
  releaseChannel: 'latest',
  latestVersion: '1.51.0',
  availableVersions: ['1.51.0'],
  lifecycleOp: null,
  status: 'ready',
  health: 'ok',
  load: { cpu: 0.5, mem: 0.25, agents: 2 },
  sessionEpoch: 3,
  maxAgents: 32,
  activeSessions: 1,
  lastSeenAt: '2026-08-30T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: null,
  lastModifiedAt: '2026-08-01T00:00:00.000Z',
  lastModifiedBy: null,
  sessionRetention: '7d',
  visibility: 'org',
  sharedWith: [],
  canEdit: true,
  canManageSharing: true,
  canManageLifecycle: true
} as DaemonFleetDto

const capability: DaemonCapabilityDto = {
  daemonId: 'd-1',
  capabilities: { platforms: ['slack'], runtimes: ['claude-acp'], acp: true, features: ['sandbox'] },
  runtimeProfiles: [
    {
      runtime: 'claude-acp',
      version: '0.70.0',
      models: ['opus', 'sonnet'],
      contextWindow: null,
      acpSupport: 'full',
      acpProtocolVersion: 1,
      toolCalling: true,
      mcpCapabilities: { http: true, sse: true },
      modelsSource: 'probed',
      // The fleet read keeps the runtime-level answers and empties the matrix.
      modelCatalog: {
        models: [],
        defaultModel: 'sonnet',
        permissionModes: [{ value: 'auto', name: 'Auto' }],
        source: 'acp',
        observedAt: '2026-08-30T00:00:00.000Z'
      },
      authRequired: true
    }
  ],
  mcpServers: [{ name: 'github', transport: 'stdio' }]
}

describe('daemon read split', () => {
  it('maps a liveness row on its own, with capability still unknown', () => {
    const row = daemonFromDto(fleetRow)
    expect(row.status).toBe('online') // the console's word for a ready daemon
    expect(row.loadAgents).toBe(2)
    // Empty rather than wrong: views gate on `daemonsLoading` until capability lands.
    expect(row.caps).toEqual({ platforms: [], runtimes: [], acp: false, features: [] })
    expect(row.runtimeModels).toEqual([])
    expect(row.mcpServers).toEqual([])
  })

  it('stitches capability onto the liveness row without disturbing liveness', () => {
    const row = withDaemonCapability(daemonFromDto(fleetRow), capability)
    expect(row.status).toBe('online') // the console's word for a ready daemon
    expect(row.caps.features).toEqual(['sandbox'])
    expect(row.mcpServers).toEqual([{ name: 'github', transport: 'stdio' }])
    expect(row.runtimeModels).toHaveLength(1)
    expect(row.runtimeModels[0]!.models).toEqual(['opus', 'sonnet'])
    expect(row.runtimeModels[0]!.mcpCapabilities).toEqual({ http: true, sse: true })
    // The login warning is fleet-wide information, so it survives the split.
    expect(row.runtimeModels[0]!.authRequired).toBe(true)
    // The runtime-level answers survive, so the read-only model/permission labels resolve
    // for every agent; the per-model matrix is empty until `useDaemonDetail` reads one daemon.
    expect(row.runtimeModels[0]!.modelCatalog!.defaultModel).toBe('sonnet')
    expect(row.runtimeModels[0]!.modelCatalog!.permissionModes).toEqual([{ value: 'auto', name: 'Auto' }])
    expect(row.runtimeModels[0]!.modelCatalog!.models).toEqual([])
  })

  it('leaves the row alone when that daemon has no capability row yet', () => {
    const row = daemonFromDto(fleetRow)
    expect(withDaemonCapability(row, undefined)).toBe(row)
  })
})

describe('mergeDaemonCatalogs — the detail read owns catalogs, the fleet row owns the rest', () => {
  const fleet = [
    { runtime: 'claude-acp', version: '0.70.0', models: ['opus'], authRequired: true, modelCatalog: null }
  ] as DaemonRow['runtimeModels']
  const detail = [
    {
      runtime: 'claude-acp',
      version: '0.70.0',
      models: ['opus', 'sonnet'],
      authRequired: false,
      modelCatalog: { models: [{ id: 'opus' }], source: 'acp', observedAt: '2026-08-30T00:00:00.000Z' }
    },
    { runtime: 'codex-acp', version: '1.0.0', models: ['gpt-5'], modelCatalog: null }
  ] as DaemonRow['runtimeModels']

  it('takes the catalog from detail and everything else from the fleet row', () => {
    const [merged] = mergeDaemonCatalogs(fleet, detail)
    expect(merged!.modelCatalog!.models).toEqual([{ id: 'opus' }])
    // A slower detail response must not resurrect a stale runtime inventory or login state.
    expect(merged!.models).toEqual(['opus'])
    expect(merged!.authRequired).toBe(true)
  })

  it('never adds a runtime the fleet row no longer reports', () => {
    expect(mergeDaemonCatalogs(fleet, detail).map((p) => p.runtime)).toEqual(['claude-acp'])
  })

  it('falls back to the detail profiles before the fleet capability read lands', () => {
    expect(mergeDaemonCatalogs([], detail)).toBe(detail)
  })
})
