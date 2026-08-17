import { describe, expect, it } from 'vitest'
import { editAgentDaemonChoices } from './edit-agent-daemon-choice'

type Row = {
  caps: { features: string[] }
  pool: boolean
  daemonId: string
  status: 'online' | 'offline'
  memberSetId: string | null
}

const row = (
  daemonId: string,
  pool = false,
  status: Row['status'] = 'online',
  movable = true,
  memberSetId: string | null = null
): Row => ({
  caps: { features: movable ? ['agent-move-v1'] : [] },
  pool,
  daemonId,
  status,
  memberSetId
})

describe('editAgentDaemonChoices', () => {
  it('collapses every Cloud member into one first choice', () => {
    const choices = editAgentDaemonChoices(
      [row('local-1'), row('pool-1', true), row('pool-2', true), row('pool-3', true), row('local-2')],
      'local-1',
      'local-1'
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-1')
    expect(choices.currentPoolChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-1', 'local-2'])
  })

  it('keeps the selected Cloud member as the concrete placement target', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-offline', true, 'offline'), row('pool-serving', true), row('local-1')],
      'pool-serving',
      'local-1'
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice).toBeUndefined()
  })

  it('keeps an unavailable Cloud source as an explicit cancellation choice', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-source', true, 'offline'), row('pool-serving', true), row('local-1')],
      'local-1',
      'pool-source'
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice?.daemonId).toBe('pool-source')
  })

  it('offers a healthy Cloud sibling when the current Cloud placement is unavailable', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-source', true, 'offline'), row('pool-serving', true), row('local-1')],
      'pool-source',
      'pool-source'
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice?.daemonId).toBe('pool-source')
  })

  it('puts move-ready local daemons before unavailable local daemons', () => {
    const choices = editAgentDaemonChoices(
      [row('local-offline', false, 'offline'), row('local-old', false, 'online', false), row('local-ready')],
      'local-offline',
      'local-offline'
    )

    expect(choices.poolChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-ready', 'local-offline', 'local-old'])
  })

  it('offers a daemon that is in a group — membership does not disqualify it as a target', () => {
    // A `daemon` placement is eligible for exactly that machine either way, so it stays the only
    // holder whether or not it has joined one (daemon-groups.md §3).
    const choices = editAgentDaemonChoices([row('grouped', false, 'online', true, 'set-1'), row('free')], '', '')

    expect(choices.localChoices.map((d) => d.daemonId).sort()).toEqual(['free', 'grouped'])
  })
})
