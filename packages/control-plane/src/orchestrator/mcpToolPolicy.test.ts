// Grouping, save-time expansion and drift of per-agent MCP tool policies (mcp-tool-permissions.md §3, §5.2, §5.3, §5.6).
import { describe, expect, it } from 'vitest'
import {
  definitionToolDecisions,
  expandToolPolicy,
  relayToolPolicy,
  toolGroup,
  toolPolicyDrift
} from './mcpToolPolicy.js'
import type { McpToolDecision, McpToolGroup } from '../persistence/ports.js'

const READ_ONLY: Record<McpToolGroup, McpToolDecision> = { readOnly: 'allow', write: 'block', other: 'block' }
const APPROVE_WRITES: Record<McpToolGroup, McpToolDecision> = {
  readOnly: 'allow',
  write: 'approval',
  other: 'approval'
}

const catalog = [
  { name: 'list_issues', readOnlyHint: true },
  { name: 'create_issue', readOnlyHint: false },
  { name: 'delete_issue', readOnlyHint: false },
  { name: 'mystery' }
]

describe('toolGroup', () => {
  it('sorts by an explicit readOnlyHint only; an absent hint is Other, never Write', () => {
    expect(toolGroup({ name: 'a', readOnlyHint: true })).toBe('readOnly')
    expect(toolGroup({ name: 'b', readOnlyHint: false })).toBe('write')
    expect(toolGroup({ name: 'c' })).toBe('other')
  })
})

describe('expandToolPolicy', () => {
  it('expands the catalog by group, with overrides taking precedence', () => {
    expect(expandToolPolicy(READ_ONLY, { mystery: 'allow', list_issues: 'ask' }, catalog)).toEqual({
      allowTools: ['mystery'],
      approvalTools: [],
      askTools: ['list_issues']
    })
  })

  it('covers all four decisions, leaving Blocked names out of every list', () => {
    const table = expandToolPolicy(APPROVE_WRITES, { delete_issue: 'block', create_issue: 'ask' }, catalog)
    expect(table).toEqual({ allowTools: ['list_issues'], approvalTools: ['mystery'], askTools: ['create_issue'] })
  })

  it('adds hand-typed override names the catalog does not list', () => {
    expect(expandToolPolicy(READ_ONLY, { not_listed: 'allow' }, catalog).allowTools).toEqual([
      'list_issues',
      'not_listed'
    ])
  })

  it('without a catalog, the table is the overrides alone', () => {
    expect(expandToolPolicy(APPROVE_WRITES, { a: 'allow', b: 'approval', c: 'block' })).toEqual({
      allowTools: ['a'],
      approvalTools: ['b'],
      askTools: []
    })
  })
})

describe('toolPolicyDrift', () => {
  const saved = { groups: READ_ONLY, overrides: {}, ...expandToolPolicy(READ_ONLY, {}, catalog) }

  it('reports nothing against the catalog the table was expanded from', () => {
    expect(toolPolicyDrift(saved, catalog)).toEqual({ newTools: [], changedTools: [], missingTools: [] })
  })

  it('reports new, regrouped and vanished tools without touching the table', () => {
    const refreshed = [
      { name: 'list_issues', readOnlyHint: false }, // relabelled as a write tool
      { name: 'create_issue', readOnlyHint: false },
      { name: 'search', readOnlyHint: true }, // new, and a re-save would allow it
      { name: 'purge', readOnlyHint: false } // new, but Blocked either way
    ]
    const before = structuredClone(saved)
    expect(toolPolicyDrift(saved, refreshed)).toEqual({
      newTools: ['search'],
      changedTools: ['list_issues'],
      missingTools: []
    })
    expect(toolPolicyDrift(saved, [])).toMatchObject({ missingTools: ['list_issues'] })
    expect(saved).toEqual(before)
  })
})

describe('custody', () => {
  const table = { allowTools: ['read'], approvalTools: ['write'], askTools: ['delete'] }

  it('a runtime grant’s relay table never carries approval-gated names', () => {
    expect(relayToolPolicy(table, 'runtime')).toEqual({ allow: ['read'], approval: [], ask: [] })
    expect(relayToolPolicy(table, 'daemon')).toEqual({ allow: ['read'], approval: ['write'], ask: ['delete'] })
  })

  it('a runtime definition lists approval-gated and unlisted catalog names as Blocked', () => {
    expect(definitionToolDecisions(table, 'runtime', [{ name: 'read' }, { name: 'admin' }])).toEqual({
      allow: ['read'],
      approval: [],
      ask: [],
      block: ['admin', 'delete', 'write']
    })
    expect(definitionToolDecisions(table, 'daemon')).toEqual({
      allow: ['read'],
      approval: ['write'],
      ask: ['delete'],
      block: []
    })
  })
})
