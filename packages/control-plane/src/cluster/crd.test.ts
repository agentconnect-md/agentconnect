/**
 * CRD parity: the chart's `AgentConnectOrg` CRD is authoritative for the API
 * server, and this package writes `spec` / reads `status` against it. A field
 * the control plane emits that the CRD does not declare would be pruned in
 * flight — silently — so assert containment in both directions that matter.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CONDITION_TYPES, DEFAULT_CREDENTIAL_SECRET_NAME, GROUP, KIND, PLURAL, VERSION } from './crd.js'
import { buildSpec, projectStatus } from './spec.js'
import type { ClusterExecutionSettings } from '../persistence/ports.js'

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema }

const SETTINGS: ClusterExecutionSettings = {
  orgId: 'org_example',
  enabled: true,
  resourceName: 'example',
  suspend: false,
  daemonImage: 'registry.example.test/daemon:1',
  daemonTier: 'small',
  credentialSecretName: DEFAULT_CREDENTIAL_SECRET_NAME,
  credentialRevision: '3',
  runtimeImage: 'registry.example.test/runtime:1',
  runtimeTiers: [{ name: 'small', warmReplicas: 1 }],
  quota: { maxAgents: 4, cpu: '8', memory: '16Gi', storage: '100Gi' },
  egressPolicy: 'curated',
  createdAt: new Date(0),
  updatedAt: new Date(0)
}

/** Nested property-name paths of an object tree, matching the operator's parity helper. */
function propertyPaths(schema: JsonSchema, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    out.push(...propertyPaths(child.type === 'array' ? (child.items ?? {}) : child, path))
  }
  return out.sort()
}

/** Property paths of a concrete value, so an emitted spec can be checked field by field. */
function valuePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuePaths(item, prefix))
  if (value === null || typeof value !== 'object') return []
  const out: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    out.push(...valuePaths(child, path))
  }
  return [...new Set(out)].sort()
}

function loadCrd(): { spec: JsonSchema; status: JsonSchema; group: string; version: string; plural: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '../../../../charts/operator/templates/crd.yaml')
  // The template is pure YAML wrapped in one {{- if }} / {{- end }} pair.
  const yaml = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('{{'))
    .join('\n')
  const crd = parse(yaml) as {
    spec: {
      group: string
      names: { kind: string; plural: string }
      versions: {
        name: string
        schema: { openAPIV3Schema: { properties: { spec: JsonSchema; status: JsonSchema } } }
      }[]
    }
  }
  const version = crd.spec.versions[0]
  if (!version) throw new Error('CRD version not found')
  expect(crd.spec.names.kind).toBe(KIND)
  return {
    spec: version.schema.openAPIV3Schema.properties.spec,
    status: version.schema.openAPIV3Schema.properties.status,
    group: crd.spec.group,
    version: version.name,
    plural: crd.spec.names.plural
  }
}

describe('AgentConnectOrg CRD parity', () => {
  const crd = loadCrd()

  it('addresses the collection the CRD serves', () => {
    expect([crd.group, crd.version, crd.plural]).toEqual([GROUP, VERSION, PLURAL])
  })

  it('emits only spec fields the CRD declares', () => {
    const declared = new Set(propertyPaths(crd.spec))
    for (const path of valuePaths(buildSpec(SETTINGS, 'Example Org'))) {
      expect(declared, `spec.${path} is not declared by the CRD`).toContain(path)
    }
  })

  it('reads only status fields the CRD declares', () => {
    const declared = new Set(propertyPaths(crd.status))
    const status = projectStatus({
      observedGeneration: 2,
      namespace: 'ac-org-example',
      conditions: [{ type: 'Ready', status: 'True', reason: 'Reconciled', message: 'ok', lastTransitionTime: 'now' }],
      daemon: { ready: true, image: 'registry.example.test/daemon:1' },
      sandboxes: { total: 3, running: 1, suspended: 2 },
      pools: [{ name: 'small', warmAvailable: 1, claimed: 0 }],
      rollout: { rolloutId: 'r1', targetImage: 'registry.example.test/runtime:2', pending: ['a'], failed: [] }
    })
    const { present, ...body } = status
    expect(present).toBe(true)
    for (const path of valuePaths(body)) {
      expect(declared, `status.${path} is not declared by the CRD`).toContain(path)
    }
  })

  // The CRD keeps the field as a deployment-level override; the control plane never
  // writes one, so the operator derives `<prefix><CR name>` for every org it provisions.
  it('never writes the namespace override the CRD still offers', () => {
    expect(propertyPaths(crd.spec)).toContain('targetNamespace')
    expect(valuePaths(buildSpec(SETTINGS, 'Example Org'))).not.toContain('targetNamespace')
  })

  it('names the credential secret default the CRD carries', () => {
    const daemon = crd.spec.properties?.daemon as { properties?: { credentialSecretName?: { default?: string } } }
    expect(daemon.properties?.credentialSecretName?.default).toBe(DEFAULT_CREDENTIAL_SECRET_NAME)
  })

  it('projects the conditions the operator publishes', () => {
    expect(CONDITION_TYPES).toEqual([
      'Ready',
      'NamespaceReady',
      'CredentialReady',
      'LimitsApplied',
      'Progressing',
      'Degraded'
    ])
  })
})
