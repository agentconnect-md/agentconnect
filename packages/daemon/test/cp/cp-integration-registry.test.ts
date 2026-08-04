import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntegrationSpec } from '@agentconnect.md/protocol'
import { CpIntegrationRegistry } from '../../src/cp/cp-integration-registry.js'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const integration = (id: string, agentId = A1, token = 'xoxb-one'): IntegrationSpec => ({
  integrationId: id,
  agentId,
  platform: 'slack',
  config: { mode: 'direct', botToken: token, appToken: 'xapp-one', bindRules: [], mutedChannels: [], gated: false }
})

function makeReg() {
  const onChange = vi.fn()
  const warn = vi.fn()
  const reg = new CpIntegrationRegistry(mkdtempSync(join(tmpdir(), 'ac-cpintreg-')), { warn }, onChange)
  return { reg, onChange, warn }
}

describe('CpIntegrationRegistry (memory-only)', () => {
  it('upserts/replaces integrations by id without requiring an agent.json', () => {
    const { reg } = makeReg()
    reg.upsert(integration('i1'))
    reg.upsert(integration('i1', A1, 'xoxb-two'))
    expect(reg.forAgent(A1)).toHaveLength(1)
    expect(reg.forAgent(A1)[0]).toMatchObject({ id: 'i1', origin: 'cp', slack: { botToken: 'xoxb-two' } })
  })

  it('keeps agent ownership, removes by id, and exact-prunes one agent only', () => {
    const { reg } = makeReg()
    reg.converge([integration('i1'), integration('i2'), integration('i3', A2)])
    reg.retainForAgent(A1, new Set(['i2']))
    expect(reg.forAgent(A1).map((item) => item.id)).toEqual(['i2'])
    expect(reg.forAgent(A2).map((item) => item.id)).toEqual(['i3'])
    reg.remove('i3')
    expect(reg.forAgent(A2)).toEqual([])
  })

  it('rejects an unusable envelope without retaining secret material', () => {
    const { reg, warn } = makeReg()
    reg.upsert({ integrationId: 'bad', agentId: A1, platform: 'slack' } as IntegrationSpec)
    expect(reg.forAgent(A1)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })
})
