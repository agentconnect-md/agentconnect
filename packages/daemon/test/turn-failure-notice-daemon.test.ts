import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A chat app gets the out-of-credits next steps as links; webchat keeps the tagged text for the console to read.
async function surface(opts: { keyServer: boolean; webchat?: 'person' | 'agent'; error?: string }) {
  const d = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null }) as any
  d.cfg = {}
  d.modelSessions = { enabled: opts.keyServer }
  d.cpOrgSlug = 'acme'
  d.cpWebAppUrl = 'https://console.example.test/'
  const postMessage = vi.fn(async () => undefined)
  const done = vi.fn()
  const webchatPost = vi.fn(async () => undefined)
  d.postWebchatAgentMessage = webchatPost
  await d.surfaceTurnFailure(new Error(opts.error ?? 'API Error: 402 [ERR:out_of_credits] Out of credits'), {
    agentId: 'agent-1',
    message: { platform: 'telegram', channel: 'c1', isDm: true },
    agentName: 'Helper',
    platform: 'telegram',
    isDm: true,
    channel: 'c1',
    sessionKey: 'k',
    transcriptChannel: 'c1',
    ...(opts.webchat
      ? { webchat: { conversationId: 'conv', turnId: 't1', initiator: opts.webchat, sink: { done } } }
      : { replyConn: { postMessage } })
  })
  return {
    posted: postMessage.mock.calls.map((call: unknown[]) => call[1]),
    done: done.mock.calls,
    webchatPosted: webchatPost.mock.calls.map((call: unknown[]) => call[2])
  }
}

describe('surfaceTurnFailure on an out-of-credits refusal', () => {
  it('posts the next steps as console links in a chat app', async () => {
    const { posted } = await surface({ keyServer: true })
    expect(posted).toEqual([
      [
        "⚠️ Your organization is out of credits, so Helper couldn't respond.",
        '• Add credits: https://console.example.test/acme/billing',
        '• Or move Helper to your own machine in its settings: https://console.example.test/acme/agents/agent-1?tab=config&edit=placement'
      ].join('\n')
    ])
  })

  it('reads no tag on a daemon whose credentials the key server does not issue', async () => {
    const { posted } = await surface({ keyServer: false })
    expect(posted).toEqual(['⚠️ Agent failed to respond: [ERR:out_of_credits] Out of credits'])
  })

  it('hands webchat the tagged reason for the console to present', async () => {
    const { done } = await surface({ keyServer: true, webchat: 'person' })
    expect(done).toEqual([[{ conversationId: 'conv', turnId: 't1', error: '[ERR:out_of_credits] Out of credits' }]])
  })

  it("posts a webchat task's refusal as the refusal alone, not as the agent failing", async () => {
    const { webchatPosted } = await surface({
      keyServer: true,
      webchat: 'agent',
      error: '[ERR:never_funded] This organization has no AgentConnect credits yet'
    })
    expect(webchatPosted).toEqual(['⚠️ [ERR:never_funded] This organization has no AgentConnect credits yet'])
  })
})
