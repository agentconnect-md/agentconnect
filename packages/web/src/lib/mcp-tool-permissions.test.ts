import { describe, expect, it } from 'vitest'
import type { McpCatalogToolDto } from '@/lib/api'
import {
  PRESET_GROUPS,
  approvalDecisionsInUse,
  approvalRefusal,
  expandTable,
  needsResave,
  presetOf
} from '@/lib/mcp-tool-permissions'

const TOOLS: Pick<McpCatalogToolDto, 'name' | 'group'>[] = [
  { name: 'list', group: 'readOnly' },
  { name: 'create', group: 'write' },
  { name: 'misc', group: 'other' }
]

describe('presetOf', () => {
  it('reads no policy as Full access and each named preset by its groups', () => {
    expect(presetOf(null)).toBe('full')
    expect(presetOf({ groups: PRESET_GROUPS.readOnly, overrides: {} })).toBe('readOnly')
    expect(presetOf({ groups: PRESET_GROUPS.approveWrites, overrides: {} })).toBe('approveWrites')
    expect(presetOf({ groups: PRESET_GROUPS.askWrites, overrides: {} })).toBe('askWrites')
  })

  it('reads overrides or other groups as Custom', () => {
    expect(presetOf({ groups: PRESET_GROUPS.approveWrites, overrides: { misc: 'allow' } })).toBe('custom')
    expect(presetOf({ groups: { readOnly: 'allow', write: 'approval', other: 'ask' }, overrides: {} })).toBe('custom')
  })

  it('never makes Other more permissive than Write/delete in a named preset', () => {
    const rank = { allow: 0, approval: 1, ask: 2, block: 3 }
    for (const groups of Object.values(PRESET_GROUPS))
      expect(rank[groups.other]).toBeGreaterThanOrEqual(rank[groups.write])
  })
})

describe('expandTable and approvalDecisionsInUse', () => {
  it('expands approval decisions from groups, overrides and hand-typed names', () => {
    const table = expandTable(PRESET_GROUPS.approveWrites, { misc: 'ask', typed: 'approval' }, TOOLS)
    expect([...table.allow]).toEqual(['list'])
    expect([...table.approval].sort()).toEqual(['create', 'typed'])
    expect([...table.ask]).toEqual(['misc'])
  })

  it('names only the approval decisions some tool would get', () => {
    expect([...approvalDecisionsInUse(PRESET_GROUPS.readOnly, {}, TOOLS)]).toEqual([])
    expect([...approvalDecisionsInUse(PRESET_GROUPS.askWrites, {}, TOOLS)]).toEqual(['ask'])
    expect([...approvalDecisionsInUse(PRESET_GROUPS.askWrites, {}, [])]).toEqual([])
    expect([...approvalDecisionsInUse(PRESET_GROUPS.readOnly, { typed: 'approval' }, [])]).toEqual(['approval'])
  })

  it('asks for a re-save when a saved approval table no longer matches the catalog', () => {
    const saved = {
      groups: PRESET_GROUPS.approveWrites,
      overrides: {},
      allowTools: ['list'],
      approvalTools: ['create', 'misc'],
      askTools: []
    }
    expect(needsResave(saved, TOOLS)).toBe(false)
    expect(needsResave(saved, [...TOOLS, { name: 'update', group: 'write' }])).toBe(true)
  })
})

describe('approvalRefusal', () => {
  it.each([
    ['codex-acp', 'agent-full-access', { reason: 'noAsking', refused: ['approval', 'ask'] }],
    ['codex', 'agent', { reason: 'reviewerOnly', refused: ['ask'] }],
    ['codex-acp', 'read-only', null],
    ['codex-acp', 'workspace-write', null],
    ['codex-acp', 'something-new', { reason: 'noAsking', refused: ['approval', 'ask'] }],
    ['claude-acp', 'default', null],
    ['claude', 'auto', null],
    ['claude', 'bypassPermissions', null],
    ['claude', 'dontAsk', { reason: 'noAsking', refused: ['approval', 'ask'] }],
    ['opencode', 'default', { reason: 'unsupported', refused: ['approval', 'ask'] }],
    ['', 'default', null]
  ] as const)('%s in %s', (runtime, mode, expected) => {
    expect(approvalRefusal(runtime, mode)).toEqual(expected)
  })
})
