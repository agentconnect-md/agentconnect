import { describe, expect, it } from 'vitest'
import { ABSENT_ENVELOPE, ClusterNamingError, buildSpec, orgNamespace, orgResourceName, projectStatus } from './spec.js'
import type { ClusterExecutionSettings } from '../persistence/ports.js'

const SETTINGS: ClusterExecutionSettings = {
  orgId: 'cm5exampleorgid0000000001',
  enabled: true,
  targetNamespace: 'ac-org-cm5exampleorgid0000000001',
  suspend: false,
  daemonImage: 'registry.example.test/daemon:1.2.3',
  daemonTier: 'small',
  credentialSecretName: 'ac-daemon-token',
  runtimeImage: 'registry.example.test/runtime:1.2.3',
  runtimeTiers: [{ name: 'small', warmReplicas: 2 }],
  quota: { maxAgents: 8, cpu: '16', memory: '32Gi', storage: '200Gi' },
  egressPolicy: 'curated',
  createdAt: new Date(0),
  updatedAt: new Date(0)
}

describe('orgNamespace', () => {
  it('joins the install prefix to the org id', () => {
    expect(orgNamespace('ac-org-', 'cm5exampleorgid0000000001')).toBe('ac-org-cm5exampleorgid0000000001')
  })

  it('folds an id that is not already a DNS label', () => {
    expect(orgNamespace('ac-org-', 'Org_ID.42')).toBe('ac-org-org-id-42')
  })

  it('truncates to 63 characters without leaving a trailing dash', () => {
    const name = orgNamespace('ac-org-', `${'a'.repeat(55)}-tail`)
    expect(name).toHaveLength(62)
    expect(name.endsWith('-')).toBe(false)
  })

  it('is stable — the same org always derives the same namespace', () => {
    expect(orgNamespace('ac-org-', 'abc')).toBe(orgNamespace('ac-org-', 'abc'))
  })

  it('refuses an org id that folds to nothing usable', () => {
    expect(() => orgNamespace('ac-org-', '___')).toThrow(ClusterNamingError)
  })

  it('names the resource after the namespace it targets', () => {
    expect(orgResourceName('ac-org-acme')).toBe('ac-org-acme')
  })
})

describe('buildSpec', () => {
  it('projects every control-plane-owned field', () => {
    expect(buildSpec(SETTINGS, 'acme')).toEqual({
      targetNamespace: 'ac-org-cm5exampleorgid0000000001',
      displayName: 'acme',
      suspend: false,
      daemon: {
        image: 'registry.example.test/daemon:1.2.3',
        tier: 'small',
        credentialSecretName: 'ac-daemon-token'
      },
      runtime: {
        image: 'registry.example.test/runtime:1.2.3',
        tiers: [{ name: 'small', warmReplicas: 2 }]
      },
      quota: { maxAgents: 8, cpu: '16', memory: '32Gi', storage: '200Gi' },
      egressPolicy: 'curated'
    })
  })

  it('omits credentialRevision until a credential has been issued', () => {
    expect(buildSpec(SETTINGS).daemon.credentialRevision).toBeUndefined()
    expect(buildSpec({ ...SETTINGS, credentialRevision: '7' }).daemon.credentialRevision).toBe('7')
  })

  it('omits displayName when the org has no name to show', () => {
    expect('displayName' in buildSpec(SETTINGS)).toBe(false)
  })

  it('carries suspend through so the operator can quiesce without deletion', () => {
    expect(buildSpec({ ...SETTINGS, suspend: true }).suspend).toBe(true)
  })
})

describe('projectStatus', () => {
  it('orders conditions the way the operator documents them', () => {
    const status = projectStatus({
      conditions: [
        { type: 'Degraded', status: 'False' },
        { type: 'Ready', status: 'True' },
        { type: 'CredentialReady', status: 'Unknown' }
      ]
    })
    expect(status.conditions.map((c) => c.type)).toEqual(['Ready', 'CredentialReady', 'Degraded'])
  })

  it('keeps a condition the operator adds later, after the known ones', () => {
    const status = projectStatus({
      conditions: [
        { type: 'SomethingNew', status: 'True' },
        { type: 'Ready', status: 'True' }
      ]
    })
    expect(status.conditions.map((c) => c.type)).toEqual(['Ready', 'SomethingNew'])
  })

  it('reports an empty status as present with no conditions', () => {
    expect(projectStatus(undefined)).toEqual({ present: true, conditions: [] })
  })

  it('drops absent optional condition fields rather than emitting nulls', () => {
    const [condition] = projectStatus({ conditions: [{ type: 'Ready', status: 'True' }] }).conditions
    expect(condition).toEqual({ type: 'Ready', status: 'True' })
  })

  it('passes the operator summaries through untouched', () => {
    const status = projectStatus({
      observedGeneration: 4,
      namespace: 'ac-org-acme',
      daemon: { ready: true, image: 'registry.example.test/daemon:1.2.3' },
      sandboxes: { total: 5, running: 3, suspended: 2 },
      pools: [{ name: 'small', warmAvailable: 2, claimed: 1 }],
      rollout: { rolloutId: 'r-1', targetImage: 'registry.example.test/runtime:2', pending: ['s-1'], failed: [] }
    })
    expect(status.observedGeneration).toBe(4)
    expect(status.namespace).toBe('ac-org-acme')
    expect(status.daemon).toEqual({ ready: true, image: 'registry.example.test/daemon:1.2.3' })
    expect(status.sandboxes).toEqual({ total: 5, running: 3, suspended: 2 })
    expect(status.pools).toEqual([{ name: 'small', warmAvailable: 2, claimed: 1 }])
    expect(status.rollout?.pending).toEqual(['s-1'])
  })

  it('distinguishes "no resource" from "a resource with no status"', () => {
    expect(ABSENT_ENVELOPE.present).toBe(false)
    expect(projectStatus({}).present).toBe(true)
  })
})
