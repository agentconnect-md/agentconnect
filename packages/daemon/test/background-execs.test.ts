import { describe, expect, it } from 'vitest'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { BackgroundExecs, noteOpenExec } from '../src/daemon/background-execs.js'
import { sdkLeaseKey } from '../src/daemon/turn-types.js'

const start = (id: string, kind = 'execute') => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  kind,
  status: 'in_progress'
})
const end = (id: string, status = 'completed') => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status })

describe('noteOpenExec', () => {
  it('keeps only the execute calls a turn has not settled', () => {
    const open = new Map<string, number>()
    noteOpenExec(open, start('a'), 1)
    noteOpenExec(open, start('b'), 2)
    noteOpenExec(open, start('read', 'read'), 3)
    noteOpenExec(open, { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'in_progress' }, 4)
    noteOpenExec(open, end('a'), 5)
    expect([...open]).toEqual([['b', 2]])
  })

  it('does not open a call that started already settled', () => {
    const open = new Map<string, number>()
    noteOpenExec(open, { ...start('a'), status: 'completed' }, 1)
    expect(open.size).toBe(0)
  })
})

describe('BackgroundExecs', () => {
  const shared = agentHostKey('bot-a')
  const confined = sessionHostKey('bot-a', 'session-x')
  const lease = sdkLeaseKey(shared, 'acp-1')
  const sibling = sdkLeaseKey(confined, 'acp-1')

  function make() {
    const clock = { now: 10 }
    const execs = new BackgroundExecs(
      () => clock.now,
      () => 100
    )
    return { clock, execs }
  }

  it('holds a session until the call it adopted settles, failure included', () => {
    const { execs } = make()
    execs.adopt(lease, 'bot-a', new Map([['a', 0]]))
    expect(execs.live(lease)).toBe(true)
    expect(execs.agentLive('bot-a')).toBe(true)
    expect(execs.ownerLive(shared)).toBe(true)
    expect(execs.ownerLive(confined)).toBe(false)
    execs.settle(lease, { ...end('a'), status: 'in_progress' })
    expect(execs.live(lease)).toBe(true)
    execs.settle(lease, end('a', 'failed'))
    expect(execs.live(lease)).toBe(false)
    expect(execs.agentLive('bot-a')).toBe(false)
  })

  it('stops counting a call past the ceiling from its start', () => {
    const { clock, execs } = make()
    execs.adopt(lease, 'bot-a', new Map([['a', 0]]))
    clock.now = 100
    expect(execs.live(lease)).toBe(true)
    clock.now = 101
    expect(execs.live(lease)).toBe(false)
  })

  it('drops by session, owner and agent', () => {
    const { execs } = make()
    execs.adopt(lease, 'bot-a', new Map([['a', 0]]))
    execs.adopt(sibling, 'bot-a', new Map([['b', 0]]))
    execs.dropOwner(confined)
    expect(execs.live(sibling)).toBe(false)
    expect(execs.live(lease)).toBe(true)
    execs.drop(lease)
    expect(execs.agentLive('bot-a')).toBe(false)
    execs.adopt(lease, 'bot-a', new Map([['a', 0]]))
    execs.dropAgent('bot-a')
    expect(execs.live(lease)).toBe(false)
  })

  it('ignores an empty or missing open set', () => {
    const { execs } = make()
    execs.adopt(lease, 'bot-a', undefined)
    execs.adopt(lease, 'bot-a', new Map())
    expect(execs.agentLive('bot-a')).toBe(false)
  })
})
