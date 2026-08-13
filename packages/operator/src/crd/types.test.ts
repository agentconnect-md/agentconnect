import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { AgentConnectOrgSpecSchema, AgentConnectOrgStatusSchema } from './types.js'

const FULL_SPEC = {
  targetNamespace: 'test-ac-org-acme',
  displayName: 'Acme',
  suspend: false,
  daemon: { image: 'registry.example.test/daemon:1', tier: 'standard' },
  controlPlane: { url: 'wss://api.example.test/daemon/ws' },
  runtime: { image: 'registry.example.test/runtime:1', tiers: [{ name: 'small', warmReplicas: 0 }] },
  quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
  llmLimits: {
    perSession: { tokensPerMinute: 0 },
    perOrg: { tokensPerMinute: 0, requestsPerMinute: 0, tokensPerDay: 0 }
  },
  egressPolicy: 'curated',
  llmDeny: { all: false, agents: [] },
  deletionPolicy: 'Delete'
}

describe('AgentConnectOrg schemas', () => {
  it('round-trips a fully specified spec', () => {
    const parsed = AgentConnectOrgSpecSchema.parse(FULL_SPEC)
    expect(parsed).toEqual(FULL_SPEC)
  })

  it('fills the documented defaults', () => {
    const parsed = AgentConnectOrgSpecSchema.parse({
      daemon: { image: 'i', tier: 't' },
      runtime: { image: 'r', tiers: [{ name: 'small' }] }
    })
    // Unset is the normal path: the operator derives the namespace from the CR name.
    expect(parsed.targetNamespace).toBeUndefined()
    expect(parsed.suspend).toBe(false)
    // Absent is legal in the schema and reported as a warning by the pass that would
    // stamp it: the operator cannot invent an address, and refusing the whole spec would
    // take the rest of the envelope down with it.
    expect(parsed.controlPlane).toBeUndefined()
    expect(parsed.runtime.tiers[0]?.warmReplicas).toBe(0)
    expect(parsed.quota).toEqual({ maxAgents: 0, cpu: '0', memory: '0', storage: '0' })
    expect(parsed.egressPolicy).toBe('curated')
    expect(parsed.deletionPolicy).toBe('Delete')
  })

  it('rejects closed-enum violations and negative limits', () => {
    expect(() => AgentConnectOrgSpecSchema.parse({ ...FULL_SPEC, egressPolicy: 'baseline' })).toThrow()
    expect(() => AgentConnectOrgSpecSchema.parse({ ...FULL_SPEC, deletionPolicy: 'Archive' })).toThrow()
    expect(() =>
      AgentConnectOrgSpecSchema.parse({
        ...FULL_SPEC,
        llmLimits: { perSession: { tokensPerMinute: -1 } }
      })
    ).toThrow()
    expect(() => AgentConnectOrgSpecSchema.parse({ ...FULL_SPEC, targetNamespace: 'Not_A_Label' })).toThrow()
  })
})

// --- CRD YAML parity: the chart's CRD is authoritative for the API server;
// --- these zod schemas are the operator's runtime guard. Property-name trees
// --- must match or one of the two has drifted.

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

/** Nested property-name paths of an (openAPIV3|JSON) schema object tree. */
function propertyPaths(schema: JsonSchema, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    const into = child.type === 'array' ? (child.items ?? {}) : child
    out.push(...propertyPaths(into, path))
  }
  return out.sort()
}

function loadCrdSchema(): { spec: JsonSchema; status: JsonSchema } {
  const here = dirname(fileURLToPath(import.meta.url))
  // The chart's plain manifest, not the template that includes it — this is the exact
  // text `kubectl apply -f` and Helm both install, parsed with nothing filtered out.
  const file = join(here, '../../../../charts/operator/crd/agentconnectorg.yaml')
  const crd = parse(readFileSync(file, 'utf8')) as {
    spec: { versions: { schema: { openAPIV3Schema: { properties: { spec: JsonSchema; status: JsonSchema } } } }[] }
  }
  const root = crd.spec.versions[0]?.schema.openAPIV3Schema.properties
  if (!root) throw new Error('CRD schema not found')
  return { spec: root.spec, status: root.status }
}

describe('CRD YAML parity', () => {
  const crd = loadCrdSchema()

  it('spec property names match the zod schema', () => {
    const fromZod = propertyPaths(z.toJSONSchema(AgentConnectOrgSpecSchema, { io: 'input' }) as JsonSchema)
    expect(propertyPaths(crd.spec)).toEqual(fromZod)
  })

  it('status property names match the zod schema', () => {
    const fromZod = propertyPaths(z.toJSONSchema(AgentConnectOrgStatusSchema, { io: 'input' }) as JsonSchema)
    expect(propertyPaths(crd.status)).toEqual(fromZod)
  })
})
