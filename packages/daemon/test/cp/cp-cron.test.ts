import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CronUpsert } from '@agentconnect.md/protocol'
import { CpCronRegistry } from '../../src/cp/cp-cron.js'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const cron = (id: string, agentId = A1, over: Partial<CronUpsert> = {}): CronUpsert => ({
  cronId: id,
  agentId,
  schedule: '0 9 * * *',
  timezone: 'Asia/Singapore',
  trigger: 'post the daily report',
  enabled: true,
  ...over
})

function makeReg() {
  const onChange = vi.fn()
  const reg = new CpCronRegistry(mkdtempSync(join(tmpdir(), 'ac-cpcron-')), { warn: vi.fn() }, onChange)
  return { reg, onChange }
}

describe('CpCronRegistry (memory-only)', () => {
  it('upserts/replaces a cron without writing an owning agent.json', () => {
    const { reg } = makeReg()
    reg.upsert(cron('c1'))
    reg.upsert(cron('c1', A1, { enabled: false }))
    expect(reg.forAgent(A1)).toEqual([
      expect.objectContaining({ id: 'c1', origin: 'cp', enabled: false, timezone: 'Asia/Singapore' })
    ])
  })

  it('preserves platform/integration targets in the in-memory definition', () => {
    const { reg } = makeReg()
    reg.upsert(cron('c1', A1, { target: { platform: 'discord', channel: 'C1', integrationId: 'i1' } }))
    expect(reg.forAgent(A1)[0]?.target).toEqual({ platform: 'discord', channel: 'C1', integrationId: 'i1' })
  })

  it('converges, removes, and exact-prunes independently per agent', () => {
    const { reg } = makeReg()
    reg.converge([cron('c1'), cron('c2'), cron('c3', A2)])
    reg.retainForAgent(A1, new Set(['c2']))
    expect(reg.forAgent(A1).map((item) => item.id)).toEqual(['c2'])
    expect(reg.forAgent(A2).map((item) => item.id)).toEqual(['c3'])
    reg.remove('c3')
    expect(reg.forAgent(A2)).toEqual([])
  })
})
