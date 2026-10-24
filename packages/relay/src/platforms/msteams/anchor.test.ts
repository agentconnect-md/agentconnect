// The deployment app's anchor (teams-integration.md §8.4): a tenant no organization connected gets a welcome or Connect card the relay posts itself.
import { describe, expect, it, vi } from 'vitest'
import type { RcDeploymentConfig } from '@agentconnect.md/protocol'
import { createMsTeamsIngressPlugin, MSTEAMS_ANCHOR_BOT_ID } from './ingress-plugin.js'
import { msTeamsAnchorAnswer, msTeamsAnchorCard } from './anchor.js'
import type { RelayIngressHost } from '../contract.js'
import { NOW, bearer, fakeBotFramework } from '../../../test/fixtures/msteams-token.js'
import {
  APP_ID,
  AAD_USER,
  BOT_ID,
  CHANNEL,
  PERSONAL,
  ROOT,
  SERVICE_URL,
  TENANT,
  USER,
  channelMention,
  channelReply,
  conversationUpdate,
  edit,
  personalText
} from '../../../test/fixtures/msteams-activities.js'

const HOME_TENANT = '00000000-0000-4000-8000-0000000000b1'
const CONNECT_URL = 'https://console.example.test/msteams/connect'
const snapshot: RcDeploymentConfig = {
  revision: 1,
  msTeamsAnchor: { appId: APP_ID, tenantId: HOME_TENANT, clientSecret: 'secret-example', connectUrl: CONNECT_URL }
}

function setup() {
  const bf = fakeBotFramework()
  const posts: { url: string; body: { attachments: { content: { body: { text?: string }[] } }[] } }[] = []
  const tokens: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokens.push(url)
      return new Response(JSON.stringify({ access_token: 'bf-token', expires_in: 3600 }), { status: 200 })
    }
    // The roster names a member a team install left nameless.
    if (url.startsWith(SERVICE_URL) && url.includes('/members/'))
      return new Response(JSON.stringify({ id: USER, name: 'Looked-up Person' }), { status: 200 })
    if (url.startsWith(SERVICE_URL)) {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id: 'posted' }), { status: 201 })
    }
    return await bf.fetchImpl(input, init)
  }) as unknown as typeof fetch
  const plugin = createMsTeamsIngressPlugin({ fetch: fetchImpl })
  const [anchor] = plugin.deploymentAssignments!(snapshot)
  const h = {
    forwardAction: vi.fn(),
    forwardStrict: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  } as unknown as RelayIngressHost
  const ingest = plugin.buildIngest(anchor!, h)!
  const deliver = async (activity: unknown) => {
    const verified = await plugin.verify(
      ingest,
      Buffer.from(JSON.stringify(activity)),
      activity,
      { authorization: await bearer() },
      NOW
    )
    return verified ? await plugin.handle(ingest, verified, h) : undefined
  }
  return { anchor: anchor!, h, posts, tokens, deliver }
}

const texts = (post: { body: { attachments: { content: { body: { text?: string }[] } }[] } }) =>
  post.body.attachments[0]!.content.body.map((b) => b.text ?? '').join('\n')

describe('the Teams anchor', () => {
  it('is an app-only assignment of the deployment app, with no secret in it', () => {
    const { anchor } = setup()
    expect(anchor).toMatchObject({ botId: MSTEAMS_ANCHOR_BOT_ID, apiAppId: APP_ID, secrets: {}, claimUrl: CONNECT_URL })
    expect(anchor.teamId).toBeUndefined()
    expect(JSON.stringify(anchor)).not.toContain('secret-example')
  })

  it('welcomes its own install with a Connect card pinned to the tenant, minting a token from the home tenant', async () => {
    const s = setup()
    const install = edit(conversationUpdate, (a) => {
      a.membersAdded = [{ id: BOT_ID }]
      a.from = { id: USER, name: 'Example Person' }
      a.recipient = { id: BOT_ID, name: 'Example Bot' }
    })
    expect(await s.deliver(install)).toEqual({})
    expect(s.tokens).toEqual([`https://login.microsoftonline.com/${HOME_TENANT}/oauth2/v2.0/token`])
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0]!.url).toBe(`${SERVICE_URL}v3/conversations/${encodeURIComponent(CHANNEL)}/activities`)
    // The registration's name (the recipient) is not the app's, so the greeting names no app.
    expect(texts(s.posts[0]!)).toContain('Hi! I’m an AI agent powered by AgentConnect')
    expect(texts(s.posts[0]!)).not.toContain('Example Bot')
    expect(texts(s.posts[0]!)).toContain('Thanks for adding me, <at>Example Person</at>.')
    expect(JSON.stringify(s.posts[0]!.body)).toContain(`${CONNECT_URL}?tenant=${TENANT}`)
    expect(s.h.forwardAction).not.toHaveBeenCalled()
  })

  it('looks a team install’s nameless installer up in the roster to mention them', async () => {
    const s = setup()
    const install = edit(conversationUpdate, (a) => {
      a.membersAdded = [{ id: BOT_ID }]
      a.from = { id: USER, aadObjectId: AAD_USER }
    })
    await s.deliver(install)
    expect(texts(s.posts[0]!)).toContain('Thanks for adding me, <at>Looked-up Person</at>.')
    expect(JSON.stringify(s.posts[0]!.body)).toContain('"mentioned":{"id":"' + USER + '","name":"Looked-up Person"}')
  })

  it('answers every DM and mention with the Connect card in place, and nothing else', async () => {
    const s = setup()
    await s.deliver(personalText)
    await s.deliver(edit(personalText, (a) => (a.id = 'again')))
    await s.deliver(channelMention)
    await s.deliver(channelReply)
    expect(s.posts.map((p) => p.url)).toEqual([
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(PERSONAL)}/activities`,
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(PERSONAL)}/activities`,
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=${ROOT}`)}/activities`
    ])
    expect(texts(s.posts[0]!)).toContain('isn’t connected to AgentConnect yet')
    // One token serves every post until it nears expiry.
    expect(s.tokens).toHaveLength(1)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })
})

describe('the anchor’s answer', () => {
  it('ignores the bot’s own messages, other roster changes, and activities naming no tenant', () => {
    expect(
      msTeamsAnchorAnswer(
        edit(personalText, (a) => (a.from = { id: BOT_ID })),
        APP_ID,
        TENANT
      )
    ).toBeUndefined()
    expect(
      msTeamsAnchorAnswer(
        edit(conversationUpdate, (a) => (a.membersAdded = [{ id: USER }])),
        APP_ID,
        TENANT
      )
    ).toBeUndefined()
    expect(msTeamsAnchorAnswer(personalText, APP_ID, undefined)).toBeUndefined()
  })

  it('mentions no one in a 1:1 welcome', () => {
    const answer = msTeamsAnchorAnswer(
      edit(conversationUpdate, (a) => {
        a.membersAdded = [{ id: BOT_ID }]
        a.conversation = { id: PERSONAL, conversationType: 'personal', tenantId: TENANT }
      }),
      APP_ID,
      TENANT
    )!
    const card = msTeamsAnchorCard(answer, CONNECT_URL)
    expect(JSON.stringify(card)).not.toContain('<at>')
  })
})
