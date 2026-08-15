import { describe, expect, it } from 'vitest'
import { addAgentDaemonChoice } from './add-agent-daemon-choice'

type Row = {
  cloud: boolean
  daemonId: string
  status: 'online' | 'offline'
}

const row = (daemonId: string, cloud = false, status: Row['status'] = 'online'): Row => ({
  cloud,
  daemonId,
  status
})

describe('addAgentDaemonChoice', () => {
  it('collapses frame-scoped members into one Cloud choice that places on the POOL', () => {
    const choice = addAgentDaemonChoice(
      [row('cloud-stale', true, 'offline'), row('local-1'), row('cloud-serving', true)],
      ''
    )

    expect(choice.cloudAvailable).toBe(true)
    expect(choice.value).toBe('')
    expect(choice.daemonId).toBeNull()
    expect(choice.daemon?.daemonId).toBe('cloud-serving')
    // The pool, not one of its members: a member id here is what a rollout invalidates.
    expect(choice.placement).toEqual({ kind: 'pool' })
    expect(choice.localDaemons.map((daemon) => daemon.daemonId)).toEqual(['local-1'])
  })

  it('keeps an explicitly selected local daemon when Cloud is available', () => {
    const choice = addAgentDaemonChoice([row('cloud-1', true), row('local-1')], 'local-1')

    expect(choice.value).toBe('local-1')
    expect(choice.daemonId).toBe('local-1')
    expect(choice.daemon?.daemonId).toBe('local-1')
    expect(choice.placement).toEqual({ kind: 'daemon', daemonId: 'local-1' })
  })

  it('requires and defaults to a local daemon when Cloud is unavailable', () => {
    const choice = addAgentDaemonChoice([row('local-offline', false, 'offline'), row('local-online')], '')

    expect(choice.cloudAvailable).toBe(false)
    expect(choice.value).toBe('local-online')
    expect(choice.daemonId).toBe('local-online')
    expect(choice.daemon?.daemonId).toBe('local-online')
    expect(choice.placement).toEqual({ kind: 'daemon', daemonId: 'local-online' })
  })

  it('falls back to a local daemon when no Cloud member is serving', () => {
    const choice = addAgentDaemonChoice([row('cloud-offline', true, 'offline'), row('local-online')], '')

    expect(choice.cloudAvailable).toBe(false)
    expect(choice.value).toBe('local-online')
    expect(choice.placement).toEqual({ kind: 'daemon', daemonId: 'local-online' })
  })

  it('has no valid choice when neither Cloud nor a local daemon exists', () => {
    expect(addAgentDaemonChoice([], '')).toMatchObject({
      cloudAvailable: false,
      daemon: undefined,
      daemonId: null,
      localDaemons: [],
      placement: null,
      value: ''
    })
  })
})
