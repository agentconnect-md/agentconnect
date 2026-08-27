import { describe, expect, it } from 'vitest'
import { editAgentCapabilitySource, editAgentDaemonChoices, preselectPlacementReset } from './edit-agent-daemon-choice'

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
      'local-1',
      true
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-1')
    expect(choices.currentPoolChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-1', 'local-2'])
  })

  it('keeps the selected Cloud member as the concrete placement target', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-offline', true, 'offline'), row('pool-serving', true), row('local-1')],
      'pool-serving',
      'local-1',
      true
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice).toBeUndefined()
  })

  it('keeps an unavailable Cloud source as an explicit cancellation choice', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-source', true, 'offline'), row('pool-serving', true), row('local-1')],
      'local-1',
      'pool-source',
      true
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice?.daemonId).toBe('pool-source')
  })

  it('offers a healthy Cloud sibling when the current Cloud placement is unavailable', () => {
    const choices = editAgentDaemonChoices(
      [row('pool-source', true, 'offline'), row('pool-serving', true), row('local-1')],
      'pool-source',
      'pool-source',
      true
    )

    expect(choices.poolChoice?.daemonId).toBe('pool-serving')
    expect(choices.currentPoolChoice?.daemonId).toBe('pool-source')
  })

  it('puts move-ready local daemons before unavailable local daemons', () => {
    const choices = editAgentDaemonChoices(
      [row('local-offline', false, 'offline'), row('local-old', false, 'online', false), row('local-ready')],
      'local-offline',
      'local-offline',
      true
    )

    expect(choices.poolChoice).toBeUndefined()
    expect(choices.localChoices.map((choice) => choice.daemonId)).toEqual(['local-ready', 'local-offline', 'local-old'])
  })

  it('lists Cloud only where the deployment offers the pool', () => {
    const daemons = [row('pool-1', true), row('local-1')]

    expect(editAgentDaemonChoices(daemons, 'local-1', 'local-1', true).offerPool).toBe(true)
    expect(editAgentDaemonChoices(daemons, 'local-1', 'local-1', false).offerPool).toBe(false)
  })

  it('keeps Cloud listed for an agent already on it, so a rollback still tells the truth', () => {
    // Both halves matter: the pool answers as itself even with every member gone, which is exactly
    // when a placed agent would otherwise read as "No daemon".
    expect(editAgentDaemonChoices([row('pool-1', true)], 'pool', 'pool', false).offerPool).toBe(true)
    expect(editAgentDaemonChoices([row('local-1')], 'pool', 'pool', false).offerPool).toBe(true)
  })

  it('does not reopen the hidden pool for a group-placed agent', () => {
    // A group placement is a `set` too. Classified by kind rather than by the resolved placement,
    // every group-placed agent would be handed the Cloud target the deployment just hid.
    const choices = editAgentDaemonChoices([row('pool-1', true), row('local-1')], 'set:g1', 'set:g1', false)

    expect(choices.offerPool).toBe(false)
  })

  it('offers a daemon that is in a group — membership does not disqualify it as a target', () => {
    // A `daemon` placement is eligible for exactly that machine either way, so it stays the only
    // holder whether or not it has joined one (daemon-groups.md §3).
    const choices = editAgentDaemonChoices([row('grouped', false, 'online', true, 'set-1'), row('free')], '', '', true)

    expect(choices.localChoices.map((d) => d.daemonId).sort()).toEqual(['free', 'grouped'])
  })
})

describe('editAgentCapabilitySource', () => {
  const group = { setId: 'g1', name: 'Group 1', memberDaemonIds: ['grouped-offline', 'grouped'], agentCount: 0 }

  it('resolves the Cloud placement to a serving pool member', () => {
    // `POOL_PLACEMENT` matches no daemon row. Resolving it to nothing is what fell the runtime and
    // model pickers back to the static fallback list, hiding whatever the pool actually reports.
    const daemons = [row('local-1'), row('pool-offline', true, 'offline'), row('pool-serving', true)]
    const poolChoice = editAgentDaemonChoices(daemons, 'pool', 'pool', true).poolChoice

    expect(editAgentCapabilitySource(daemons, 'pool', [], poolChoice)?.daemonId).toBe('pool-serving')
  })

  it('resolves a group placement to one live member, never the placement', () => {
    const daemons = [row('grouped-offline', false, 'offline', true, 'g1'), row('grouped', false, 'online', true, 'g1')]

    expect(editAgentCapabilitySource(daemons, 'set:g1', [group], undefined)?.daemonId).toBe('grouped')
  })

  it('reads a machine placement from that machine', () => {
    const daemons = [row('local-1'), row('local-2')]

    expect(editAgentCapabilitySource(daemons, 'local-2', [group], undefined)?.daemonId).toBe('local-2')
    expect(editAgentCapabilitySource(daemons, 'gone', [group], undefined)).toBeUndefined()
  })
})

describe('preselectPlacementReset', () => {
  const profiles = [
    { runtime: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'] },
    { runtime: 'codex', models: ['gpt-5'] }
  ]

  it('keeps a pair the new machine reports', () => {
    expect(preselectPlacementReset(profiles, 'claude', 'claude-sonnet-5')).toBeNull()
  })

  it('switches to the machine’s first runtime when it does not run the saved one', () => {
    expect(preselectPlacementReset(profiles, 'gemini', 'gemini-3-pro')).toEqual({ kind: 'runtime', runtime: 'claude' })
  })

  it('falls the model back to the runtime default when only the model is unknown', () => {
    expect(preselectPlacementReset(profiles, 'codex', 'gpt-4')).toEqual({ kind: 'model' })
  })

  it('resets nothing when the machine reports no profiles, or the runtime advertises no models', () => {
    expect(preselectPlacementReset(undefined, 'claude', 'claude-opus-5')).toBeNull()
    expect(preselectPlacementReset([], 'claude', 'claude-opus-5')).toBeNull()
    expect(preselectPlacementReset([{ runtime: 'cursor', models: [] }], 'cursor', 'auto')).toBeNull()
  })
})
