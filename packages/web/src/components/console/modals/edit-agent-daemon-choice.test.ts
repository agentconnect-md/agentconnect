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

    expect(choices.map((choice) => choice.daemonId)).toEqual(['cloud-1', 'local-1', 'local-2'])
    expect(choices.filter((choice) => choice.cloud)).toHaveLength(1)
  })

  it('keeps the selected Cloud member as the concrete placement target', () => {
    const choices = editAgentDaemonChoices(
      [row('cloud-offline', true, 'offline'), row('cloud-serving', true), row('local-1')],
      'cloud-serving',
      'local-1'
    )

    expect(choices[0]?.daemonId).toBe('cloud-serving')
  })

  it('keeps the source Cloud member available so a pending move can be cancelled', () => {
    const choices = editAgentDaemonChoices(
      [row('cloud-source', true, 'offline'), row('cloud-serving', true), row('local-1')],
      'local-1',
      'cloud-source'
    )

    expect(choices[0]?.daemonId).toBe('cloud-source')
  })

  it('puts move-ready local daemons before unavailable local daemons', () => {
    const choices = editAgentDaemonChoices(
      [row('local-offline', false, 'offline'), row('local-old', false, 'online', false), row('local-ready')],
      'local-offline',
      'local-offline'
    )

    expect(choices.map((choice) => choice.daemonId)).toEqual(['local-ready', 'local-offline', 'local-old'])
  })
})
