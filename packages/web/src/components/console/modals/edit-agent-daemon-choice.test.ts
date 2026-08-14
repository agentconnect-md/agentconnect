import { describe, expect, it } from 'vitest'
import { editAgentDaemonChoices } from './edit-agent-daemon-choice'

type Row = {
  caps: { features: string[] }
  cloud: boolean
  daemonId: string
  status: 'online' | 'offline'
}

const row = (daemonId: string, cloud = false, status: Row['status'] = 'online', movable = true): Row => ({
  caps: { features: movable ? ['agent-move-v1'] : [] },
  cloud,
  daemonId,
  status
})

describe('editAgentDaemonChoices', () => {
  it('collapses every Cloud member into one first choice', () => {
    const choices = editAgentDaemonChoices(
      [row('local-1'), row('cloud-1', true), row('cloud-2', true), row('cloud-3', true), row('local-2')],
      'local-1',
      'local-1'
    )

    expect(choices.cloudChoice?.daemonId).toBe('cloud-1')
    expect(choices.currentCloudChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-1', 'local-2'])
  })

  it('keeps the selected Cloud member as the concrete placement target', () => {
    const choices = editAgentDaemonChoices(
      [row('cloud-offline', true, 'offline'), row('cloud-serving', true), row('local-1')],
      'cloud-serving',
      'local-1'
    )

    expect(choices.cloudChoice?.daemonId).toBe('cloud-serving')
    expect(choices.currentCloudChoice).toBeUndefined()
  })

  it('keeps an unavailable Cloud source as an explicit cancellation choice', () => {
    const choices = editAgentDaemonChoices(
      [row('cloud-source', true, 'offline'), row('cloud-serving', true), row('local-1')],
      'local-1',
      'cloud-source'
    )

    expect(choices.cloudChoice?.daemonId).toBe('cloud-serving')
    expect(choices.currentCloudChoice?.daemonId).toBe('cloud-source')
  })

  it('offers a healthy Cloud sibling when the current Cloud placement is unavailable', () => {
    const choices = editAgentDaemonChoices(
      [row('cloud-source', true, 'offline'), row('cloud-serving', true), row('local-1')],
      'cloud-source',
      'cloud-source'
    )

    expect(choices.cloudChoice?.daemonId).toBe('cloud-serving')
    expect(choices.currentCloudChoice?.daemonId).toBe('cloud-source')
  })

  it('puts move-ready local daemons before unavailable local daemons', () => {
    const choices = editAgentDaemonChoices(
      [row('local-offline', false, 'offline'), row('local-old', false, 'online', false), row('local-ready')],
      'local-offline',
      'local-offline'
    )

    expect(choices.cloudChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-ready', 'local-offline', 'local-old'])
  })
})
