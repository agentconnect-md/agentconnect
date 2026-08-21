import { describe, expect, it } from 'vitest'
import { GITLAB_COM_V1_FEATURE } from '@agentconnect.md/protocol'
import { AgentDelivery } from './agentDelivery.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { AgentRecord } from '../persistence/ports.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'

function agentWith(mode: string): AgentRecord {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    daemonId: DAEMON,
    workspace: { mode } as AgentRecord['workspace']
  } as AgentRecord
}

function harness(features: readonly string[] | undefined) {
  const sent: string[] = []
  const delivery = new AgentDelivery({
    control: {
      agentUpsert: async (daemonId: string) => {
        sent.push(daemonId)
      },
      agentRemove: async () => {},
      integrationUpsert: async () => {},
      integrationRemove: async () => {},
      cronUpsert: async () => ({ ok: true }),
      cronRemove: async () => ({ ok: true })
    },
    specs: { assemble: async () => ({ agentId: 'a' }) } as unknown as AgentSpecAssembler,
    daemonFeatures: () => features
  })
  return { delivery, sent }
}

describe('AgentDelivery §17.3 projection gate', () => {
  it('delivers ungated agents regardless of advertised features', async () => {
    const { delivery, sent } = harness(undefined)
    await delivery.upsert(agentWith('github'), () => {})
    expect(sent).toEqual([DAEMON])
  })

  it('skips a target that has not advertised a gated agent required feature', async () => {
    const { delivery, sent } = harness([])
    await delivery.upsert(agentWith('gitlab'), () => {})
    expect(sent).toEqual([])
  })

  it('delivers a gated agent once the target advertises the feature', async () => {
    const { delivery, sent } = harness([GITLAB_COM_V1_FEATURE])
    await delivery.upsert(agentWith('gitlab'), () => {})
    expect(sent).toEqual([DAEMON])
  })
})
