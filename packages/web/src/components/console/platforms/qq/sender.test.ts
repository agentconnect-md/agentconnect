import { describe, expect, it } from 'vitest'
import { platformSenderFallback } from '../registry'

describe('QQ transcript sender labels', () => {
  const alice = '7E7B4D757AFCD32AE5F832834C30E226'
  const bob = 'E4F4AEA33253A2797FB897C50B81D7ED'

  it('gives unresolved users distinct stable labels in historical rows', () => {
    expect(platformSenderFallback('qq', alice)).toBe('QQ user · 4C30E226')
    expect(platformSenderFallback('qq', bob)).toBe('QQ user · 0B81D7ED')
    expect(platformSenderFallback('qq', alice)).not.toBe(platformSenderFallback('qq', bob))
  })

  it('does not change other platforms or invent a label without a sender', () => {
    for (const platform of ['slack', 'telegram', 'feishu', 'discord', 'hook', 'unknown'])
      expect(platformSenderFallback(platform, alice)).toBeUndefined()
    expect(platformSenderFallback('qq', '')).toBeUndefined()
    expect(platformSenderFallback('qq', 'Alice')).toBeUndefined()
  })
})
