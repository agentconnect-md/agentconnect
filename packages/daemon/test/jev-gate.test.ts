import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeImplicitWake, type JevGateConfig, type JevGateRequest } from '../src/router/jev-gate.js'

const cfg: JevGateConfig = {
  enabled: true,
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKeyEnv: 'JEV_TEST_KEY',
  model: 'jev-latest',
  threshold: 0.55,
  contextMessages: 12,
  timeoutMs: 2000
}

const req = (over: Partial<JevGateRequest> = {}): JevGateRequest => ({
  channelLabel: 'random group / #常规',
  isThread: true,
  recent: [
    { author: 'leon', kind: 'human', text: '这个报错谁懂啊', ago_s: 40 },
    { author: '哈基米', kind: 'agent', text: '看下堆栈第一行', ago_s: 12 }
  ],
  newMessage: { author: 'leon', text: '试了还是不行', mentions: [] },
  candidates: [
    { agentId: 'a1', name: '哈基米', role: '日常担当' },
    { agentId: 'a2', name: '打工牛马', role: '重活担当' }
  ],
  ...over
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('judgeImplicitWake', () => {
  it('returns null without an API key (fail-closed)', async () => {
    vi.stubEnv('JEV_TEST_KEY', '')
    expect(await judgeImplicitWake(cfg, req())).toBeNull()
  })

  it('returns null with no candidates', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    expect(await judgeImplicitWake(cfg, req({ candidates: [] }))).toBeNull()
  })

  it('returns per-agent probabilities from noul answers', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ answers: { wake_a1: { noul: 0.9 }, wake_a2: { noul: 0.1 } } }), { status: 200 })
      )
    )
    const verdict = await judgeImplicitWake(cfg, req())
    expect(verdict?.get('a1')).toBe(0.9)
    expect(verdict?.get('a2')).toBe(0.1)
  })

  it('sends structured mentions and per-agent role in the request', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    let sent: any
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        sent = JSON.parse(init.body)
        return new Response(JSON.stringify({ answers: { wake_a2: { noul: 0.8 } } }), { status: 200 })
      })
    )
    const r = req()
    r.newMessage.mentions = ['打工牛马']
    await judgeImplicitWake(cfg, r)
    expect(sent.model).toBe('jev-latest')
    expect(sent.state.new_message.mentions).toEqual(['打工牛马'])
    expect(sent.state.agents[1].role).toBe('重活担当')
    expect(sent.questions.wake_a2.type).toBe('noul')
    expect(sent.questions.wake_a2.instructions).toContain('打工牛马')
  })

  it('returns null on HTTP error', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    expect(await judgeImplicitWake(cfg, req())).toBeNull()
  })

  it('returns null on network failure', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      })
    )
    expect(await judgeImplicitWake(cfg, req())).toBeNull()
  })

  it('returns null when answers carry no usable probability', async () => {
    vi.stubEnv('JEV_TEST_KEY', 'k')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }))
    )
    expect(await judgeImplicitWake(cfg, req())).toBeNull()
  })
})
