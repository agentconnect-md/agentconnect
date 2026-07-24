import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { FeishuConverger } from '../src/feishu/render.js'

const chunk = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate

describe('FeishuConverger AC_NO_RESPONSE suppression', () => {
  it('suppresses a bare response-control marker', () => {
    const c = new FeishuConverger('low')
    c.onUpdate(chunk('AC_NO_RESPONSE'))
    expect(c.onFinal()).toEqual([])
  })

  it('delivers the old generic NO_RESPONSE phrase as ordinary content', () => {
    const c = new FeishuConverger('low')
    c.onUpdate(chunk('NO_RESPONSE'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'NO_RESPONSE' }])
  })

  it('drains whitespace-only buffers before the next response segment', () => {
    const c = new FeishuConverger('low')
    c.onUpdate(chunk('   '))
    expect(c.flushBuffered()).toEqual([])
    c.onUpdate(chunk('hello'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'hello' }])
  })
})
