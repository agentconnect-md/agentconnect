import { describe, it, expect } from 'vitest'
import type { RcHookAssign } from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'

const HOOK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function rule(overrides: Partial<RcHookAssign> = {}): RcHookAssign {
  return {
    hookId: HOOK_A,
    kind: 'webhook',
    agentId: AGENT,
    daemonId: DAEMON,
    sessionMode: 'perDelivery',
    webhook: { urlToken: 'wh_tok1' },
    ...overrides
  }
}

describe('HookTable', () => {
  it('upsert indexes a webhook rule by its urlToken', () => {
    const t = new HookTable()
    t.upsert(rule())
    expect(t.getByToken('wh_tok1')?.hookId).toBe(HOOK_A)
    expect(t.size()).toBe(1)
  })

  it('upsert is by hookId — a re-assign replaces, not duplicates', () => {
    const t = new HookTable()
    t.upsert(rule())
    t.upsert(rule({ sessionMode: 'shared' }))
    expect(t.size()).toBe(1)
    expect(t.getByHookId(HOOK_A)?.sessionMode).toBe('shared')
    expect(t.getByToken('wh_tok1')?.sessionMode).toBe('shared')
  })

  it('a token change re-indexes: the old token stops resolving', () => {
    const t = new HookTable()
    t.upsert(rule())
    t.upsert(rule({ webhook: { urlToken: 'wh_tok2' } }))
    expect(t.getByToken('wh_tok1')).toBeUndefined()
    expect(t.getByToken('wh_tok2')?.hookId).toBe(HOOK_A)
  })

  it('remove drops both indexes', () => {
    const t = new HookTable()
    t.upsert(rule())
    t.remove(HOOK_A)
    expect(t.getByToken('wh_tok1')).toBeUndefined()
    expect(t.size()).toBe(0)
  })

  it('remove of an unknown hookId is a no-op', () => {
    const t = new HookTable()
    expect(() => t.remove(HOOK_A)).not.toThrow()
  })

  describe('byRepoId index (github kind)', () => {
    const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const gh = (repoId: string, hookId = HOOK_A): RcHookAssign =>
      rule({
        hookId,
        kind: 'github',
        sessionMode: 'perThread',
        webhook: undefined,
        github: {
          repoId,
          repoFullName: 'acme/infra',
          events: ['issues:opened'],
          labelFilter: [],
          mentionOnly: false,
          installationIds: ['41']
        }
      })

    it('indexes a github rule by repoId; one repo carries many hooks', () => {
      const t = new HookTable()
      t.upsert(gh('100'))
      t.upsert(gh('100', HOOK_B))
      expect(
        t
          .getByRepoId('100')
          .map((r) => r.hookId)
          .sort()
      ).toEqual([HOOK_A, HOOK_B])
      expect(t.getByRepoId('999')).toEqual([])
    })

    it('a repoId change re-indexes: the old repo stops resolving', () => {
      const t = new HookTable()
      t.upsert(gh('100'))
      t.upsert(gh('200'))
      expect(t.getByRepoId('100')).toEqual([])
      expect(t.getByRepoId('200')[0]?.hookId).toBe(HOOK_A)
    })

    it('a kind flip github→webhook clears the repo index (and vice versa the token index)', () => {
      const t = new HookTable()
      t.upsert(gh('100'))
      t.upsert(rule()) // same hookId, back to webhook kind
      expect(t.getByRepoId('100')).toEqual([])
      expect(t.getByToken('wh_tok1')?.hookId).toBe(HOOK_A)
      t.upsert(gh('100'))
      expect(t.getByToken('wh_tok1')).toBeUndefined()
      expect(t.getByRepoId('100')).toHaveLength(1)
    })

    it('remove drops only that hook from the repo bucket', () => {
      const t = new HookTable()
      t.upsert(gh('100'))
      t.upsert(gh('100', HOOK_B))
      t.remove(HOOK_A)
      expect(t.getByRepoId('100').map((r) => r.hookId)).toEqual([HOOK_B])
      t.remove(HOOK_B)
      expect(t.getByRepoId('100')).toEqual([])
    })
  })
})
