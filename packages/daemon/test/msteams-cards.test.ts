// Teams' approval and question cards (teams-integration.md §4.4): Adaptive Cards on the turn's conversation, answered by relay-forwarded clicks and replaced in place.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable'
import {
  APPROVAL_DM_ROUTE_V1_FEATURE,
  CHAT_ACTOR_V1_FEATURE,
  elicitFormBlockId,
  type WireMsTeamsCardAction
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MSTEAMS_ADAPTIVE_CARD_TYPE, MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'
import { buildMsTeamsApprovalCard, msTeamsApprovalCards } from '../src/platforms/msteams/approval-card.js'
import { MSTEAMS_APPROVAL_VERB, MSTEAMS_ELICIT_VERB } from '../src/platforms/msteams/card.js'
import {
  buildMsTeamsElicitForm,
  msTeamsElicitCards,
  parseMsTeamsElicitClick
} from '../src/platforms/msteams/elicit-card.js'
import { decodeMsTeamsCardClick } from '../src/platforms/msteams/module.js'
import { elicitForm, elicitOptionToken } from '../src/slack/render.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const AGENT = '11111111-1111-4111-8111-111111111111'
const INT = '22222222-2222-4222-8222-222222222222'
const OTHER_INT = '33333333-3333-4333-8333-333333333333'
const BOT = '44444444-4444-4444-8444-444444444444'
const CHAT = '19:example-chat@thread.v2'
const THREAD = 'msteams:1700000000001'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TARGET = { serviceUrl: SERVICE_URL, conversationId: CHAT }
const ADA = { aadObjectId: '00000000-0000-4000-8000-0000000000a1', userId: '29:1example-ada', userName: 'Ada Example' }
const EDITOR = { aadObjectId: '00000000-0000-4000-8000-0000000000e1', userId: '29:1example-editor', userName: 'Ed' }
const MEMBER = { aadObjectId: '00000000-0000-4000-8000-0000000000b1', userId: '29:1example-member' }

/** Who clicked, as the relay's click names them. */
type Clicker = { aadObjectId?: string; userId: string; userName?: string }

const NOT_EDITOR = 'Only an Agent editor can answer this request.'
const UNAVAILABLE =
  "Who you are can't be checked right now, so this request can't be answered here. Try again in a moment."

const permission = (count = 3): RequestPermissionRequest =>
  ({
    sessionId: 's1',
    options: [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ...Array.from({ length: Math.max(0, count - 3) }, (_, i) => ({
        optionId: `extra-${i}`,
        name: `Extra ${i}`,
        kind: 'allow_once'
      }))
    ].slice(0, count),
    toolCall: { toolCallId: 'tc-1', title: 'Write **example**.txt' }
  }) as unknown as RequestPermissionRequest

function question(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }
const FORM = {
  note: { type: 'string', title: 'Note' },
  count: { type: 'integer', title: 'Count' },
  env: { type: 'string', title: 'Environment', enum: ['test', 'prod'] },
  regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['east', 'west', 'north'] } }
}

/** Every element of a card, depth first. */
function elements(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object') return []
  const obj = node as Record<string, unknown>
  return [obj, ...Object.values(obj).flatMap(elements)]
}
const ofType = (card: unknown, type: string) => elements(card).filter((e) => e.type === type)
const textOf = (card: unknown): string =>
  ofType(card, 'TextRun')
    .map((r) => r.text as string)
    .join('\n')

/** A daemon holding one live Teams turn, its card posts and replacements captured on a fake connection. */
async function world(opts: { level?: 'talk' | 'approve'; core?: Record<string, unknown>; editors?: Set<string> } = {}) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = {
    id: INT,
    platform: 'msteams',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [] as string[],
      gated: false,
      sessionModes: [],
      externalChannels: [],
      decisions: { bindings: [], definitions: [] },
      ...opts.core
    }
  }
  const agent = { id: AGENT, name: 'Butler', chatActions: opts.level ?? 'approve', integrations: [int] }
  daemon.agents.set(AGENT, agent)
  let n = 0
  const conn = Object.create(MsTeamsConnection.prototype)
  conn.targetFor = vi.fn(() => TARGET)
  conn.postCard = vi.fn(async () => `1700000000${++n}`)
  conn.replaceCard = vi.fn(async () => {})
  daemon.msTeamsConnByIntegration.set(INT, conn)
  const asked: string[] = []
  const approvalRoute = vi.fn(async (payload: { requestId: string; verify?: { userId: string } }) => {
    const userId = payload.verify?.userId ?? ''
    asked.push(userId)
    return opts.editors?.has(userId)
      ? { requestId: payload.requestId, allowed: true, displayName: 'Ed Itor' }
      : { requestId: payload.requestId, allowed: false, linked: true }
  })
  const features = new Set([CHAT_ACTOR_V1_FEATURE, APPROVAL_DM_ROUTE_V1_FEATURE])
  daemon.cpClient = { supportsServerFeature: (f: string) => features.has(f), approvalRoute }
  const applied: any[] = []
  daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'msteams',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: `msteams:${CHAT}:${THREAD}:${AGENT}`,
      requesterId: MEMBER.aadObjectId,
      channel: CHAT,
      thread: THREAD,
      transcriptChannel: CHAT,
      statusThread: THREAD,
      sessionThread: THREAD,
      isDm: false,
      approvalSurfaceSuppressed: false,
      suppressReplyConn: false
    },
    entry: { msg: { source: 'user', text: 'please write it', sender: { id: MEMBER.aadObjectId, isBot: false } } },
    egress: conn,
    hostKey: AGENT,
    outwardSessionId: 'sid-1',
    turnState: { conn, target: TARGET },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const permissions = daemon.permissions
  const onlyRequest = (): string => [...permissions.pendingApprovals.keys(), ...permissions.pendingElicits.keys()][0]
  const posts = (): { target: unknown; card: any; summary?: string }[] =>
    conn.postCard.mock.calls.map((c: unknown[]) => ({ target: c[0], card: c[1], summary: c[2] }))
  const replaced = (): { id: string; card: any }[] =>
    conn.replaceCard.mock.calls.map((c: unknown[]) => ({ id: c[0] as string, card: c[1] }))
  /** Deliver one click as the relay forwards it; answers the daemon's ack. */
  const click = async (verb: string, data: Record<string, unknown>, who: Clicker = ADA, integrationId = INT) => {
    const payload: WireMsTeamsCardAction = {
      verb,
      data,
      cardActivityId: '17000000001',
      conversationId: CHAT,
      serviceUrl: SERVICE_URL,
      ...who
    }
    return await daemon.handleRelayPlatformAction({
      source: 'platform_action',
      platformId: 'msteams',
      agentId: AGENT,
      integrationId,
      sessionKey: `msteams-action:${CHAT}/17000000001`,
      msgId: `msteams-action:${Math.random()}`,
      botId: BOT,
      userId: who.aadObjectId ?? who.userId,
      payload
    })
  }
  const approve = (option: number, who: Clicker = ADA) =>
    click(MSTEAMS_APPROVAL_VERB, { approval: onlyRequest(), option: String(option) }, who)
  const answer = (token: string, inputs: Record<string, unknown> = {}, who: Clicker = ADA) =>
    click(MSTEAMS_ELICIT_VERB, { request: onlyRequest(), token, ...inputs }, who)
  const notices = (): string[] => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  return { daemon, store, int, conn, permissions, posts, replaced, click, approve, answer, notices, asked }
}

describe('the Teams approval card', () => {
  it('is an Adaptive Card 1.5 with one Action.Execute per option, carrying its position and never its value', () => {
    const card = buildMsTeamsApprovalCard({ requestId: 'req-1', params: permission() })
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.5' })
    const buttons = ofType(card, 'Action.Execute')
    expect(buttons.map((b) => b.title)).toEqual(['Always allow', 'Allow', 'Deny'])
    expect(buttons.map((b) => b.data)).toEqual([
      { approval: 'req-1', option: '0' },
      { approval: 'req-1', option: '1' },
      { approval: 'req-1', option: '2' }
    ])
    expect(buttons.every((b) => b.verb === MSTEAMS_APPROVAL_VERB && b.associatedInputs === 'none')).toBe(true)
    expect(buttons.map((b) => b.style)).toEqual(['positive', 'positive', 'destructive'])
    expect(JSON.stringify(card)).not.toContain('"allow"')
    // The runtime's words ride a TextRun, which Teams never reads as Markdown.
    expect(textOf(card)).toBe('🔒 Permission requested — Write **example**.txt')
    expect(ofType(card, 'TextBlock')).toEqual([])
  })

  it('declines a list longer than its cap, so it goes to the console', () => {
    expect(msTeamsApprovalCards.build({ requestId: 'r', params: permission(26) })).toBeNull()
    expect(msTeamsApprovalCards.build({ requestId: 'r', params: permission(25) })).not.toBeNull()
  })

  it('reads a click’s position and the clicker’s Entra object ID; a bare 29: ID is no member key', () => {
    const payload = {
      verb: MSTEAMS_APPROVAL_VERB,
      data: { approval: 'req-1', option: '1' },
      cardActivityId: '17000000001',
      conversationId: CHAT,
      serviceUrl: SERVICE_URL,
      ...ADA
    }
    expect(decodeMsTeamsCardClick({ payload })).toEqual({
      answer: { kind: 'approval', requestId: 'req-1', option: 1 },
      ts: '17000000001',
      actor: { userId: ADA.aadObjectId, memberId: ADA.aadObjectId, name: 'Ada Example' }
    })
    const { aadObjectId: _aad, ...bare } = payload
    expect(decodeMsTeamsCardClick({ payload: bare })?.actor).toEqual({ userId: ADA.userId, name: 'Ada Example' })
    expect(decodeMsTeamsCardClick({ payload: { ...payload, data: { approval: 'r', option: 'x' } } })).toBeNull()
    expect(decodeMsTeamsCardClick({ payload: { ...payload, verb: 'other' } })).toBeNull()
    expect(decodeMsTeamsCardClick({ payload: { nope: true } })).toBeNull()
  })
})

describe('a Teams turn’s permission card', () => {
  it('posts in the turn’s conversation, takes a participant’s click, and replaces the card with the decision', async () => {
    const w = await world()
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(w.posts()[0]).toMatchObject({ target: TARGET, summary: 'Permission requested: Write **example**.txt' })
    await vi.waitFor(() =>
      expect(w.permissions.pendingApprovals.get(w.permissions.pendingApprovals.keys().next().value).chat.ts).toBe(
        '17000000001'
      )
    )
    const ack = await w.approve(1)
    expect(ack).toEqual({ msgId: expect.any(String), accepted: true })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await vi.waitFor(() => expect(w.replaced()).toHaveLength(1))
    const settled = w.replaced()[0]!
    expect(settled.id).toBe('17000000001')
    expect(ofType(settled.card, 'Action.Execute')).toEqual([])
    expect(textOf(settled.card)).toContain('✅ Allow — Ada Example')
    expect((await w.store.listPermissionRequests(AGENT))[0]).toMatchObject({
      status: 'allowed',
      resolvedBy: `msteams:${ADA.aadObjectId}`,
      resolvedByName: 'Ada Example'
    })
    await w.store.close()
  })

  it('posts the editor path’s notice as a card and replaces it with the outcome once an editor decides', async () => {
    const w = await world({ level: 'talk' })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect(textOf(w.posts()[0]!.card)).toContain('Ask an Agent editor to allow it')
    expect(ofType(w.posts()[0]!.card, 'Action.Execute')).toEqual([])
    const id = [...w.permissions.pendingApprovals.keys()][0]
    await w.permissions.decideEditorPermission({
      agentId: AGENT,
      requestId: id,
      decision: 'allow',
      decidedByName: 'Ed'
    })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await vi.waitFor(() => expect(w.replaced()).toHaveLength(1))
    expect(w.replaced()[0]!.id).toBe('17000000001')
    expect(textOf(w.replaced()[0]!.card)).toContain('✅ Permission granted by Ed.')
    expect(w.notices()).toEqual([])
    await w.store.close()
  })

  it('leaves the card unchanged for a refused clicker and hands the refusal back on the ack', async () => {
    const w = await world()
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    w.int.core.mutedChannels = [CHAT]
    const ack = await w.approve(1)
    expect(ack.accepted).toBe(true)
    expect(ack.response.note).toContain('Only an Agent editor can answer this request')
    expect(ack.response.note.length).toBeLessThanOrEqual(500)
    expect(w.replaced()).toEqual([])
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })

  it('takes only a linked editor’s click where permissions are synced, matched by Entra object ID', async () => {
    const w = await world({ core: { chatAuthority: 'editors' }, editors: new Set([EDITOR.aadObjectId]) })
    const decided = w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    expect((await w.approve(1, MEMBER)).response).toEqual({ note: NOT_EDITOR })
    // A click Teams sent without an Entra object ID cannot be matched, so the control plane is not asked.
    const bare = { userId: '29:1example-editor', userName: 'Ed' }
    expect((await w.approve(1, bare)).response).toEqual({ note: UNAVAILABLE })
    expect(w.replaced()).toEqual([])
    expect(await w.approve(1, EDITOR)).not.toHaveProperty('response')
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(w.asked.filter(Boolean)).toEqual([MEMBER.aadObjectId, EDITOR.aadObjectId])
    await vi.waitFor(() => expect(w.replaced()).toHaveLength(1))
    await w.store.close()
  })

  it('drops a click for an integration the agent lacks, and a payload that is no card click', async () => {
    const w = await world()
    void w.permissions.onAcpPermission(AGENT, 's1', permission())
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    const request = w.permissions.pendingApprovals.keys().next().value
    await expect(
      w.click(MSTEAMS_APPROVAL_VERB, { approval: request, option: '1' }, ADA, OTHER_INT)
    ).resolves.toMatchObject({ accepted: false, reason: 'not_found' })
    await expect(w.click('agentconnect.other', { approval: request, option: '1' })).resolves.toMatchObject({
      accepted: false,
      reason: 'unsupported_action'
    })
    expect(w.permissions.pendingApprovals.size).toBe(1)
    await w.store.close()
  })
})

describe('the Teams question card', () => {
  const formOf = (req: CreateElicitationRequest) => elicitForm(req, msTeamsElicitCards.reduction)!

  it('renders text, number, single and multiple choice as inputs under one Confirm and a Dismiss', () => {
    const req = question(FORM)
    const card = buildMsTeamsElicitForm('req-1', req, formOf(req))!
    expect(ofType(card, 'Input.Text')[0]).toMatchObject({ id: elicitFormBlockId(0), label: 'Note' })
    expect(ofType(card, 'Input.Number')[0]).toMatchObject({ id: elicitFormBlockId(1), label: 'Count' })
    const [single, multi] = ofType(card, 'Input.ChoiceSet')
    expect(single).toMatchObject({ id: elicitFormBlockId(2), style: 'compact', isMultiSelect: false })
    expect(multi).toMatchObject({ id: `${elicitFormBlockId(3)}_multi`, style: 'expanded', isMultiSelect: true })
    // Each choice carries its position, never its value.
    expect((multi!.choices as { value: string }[]).map((c) => c.value)).toEqual([0, 1, 2].map(elicitOptionToken))
    expect(ofType(card, 'Action.Execute').map((b) => [b.title, b.data, b.associatedInputs])).toEqual([
      ['Confirm', { request: 'req-1', token: 'ok' }, 'auto'],
      ['Dismiss', { request: 'req-1', token: 'x' }, 'none']
    ])
  })

  it('declines a URL consent ask and a list longer than its cap', () => {
    const ask = {
      requestId: 'r',
      params: question(BRANCH),
      message: 'm',
      fallback: 'm',
      url: { elicitationId: 'e', url: 'https://example.test' }
    }
    expect(msTeamsElicitCards.build({} as never, {} as never, ask)).toBeNull()
    const long = question({ pick: { type: 'string', enum: Array.from({ length: 25 }, (_, i) => `v${i}`) } })
    expect(elicitForm(long, msTeamsElicitCards.reduction)).toBeNull()
  })

  it('reads the inputs Teams merged into the Confirm’s data, splitting a multi-select and leaving a blank out', () => {
    const click = (data: Record<string, unknown>) =>
      parseMsTeamsElicitClick({
        verb: MSTEAMS_ELICIT_VERB,
        data,
        cardActivityId: '1',
        conversationId: CHAT,
        serviceUrl: SERVICE_URL,
        userId: ADA.userId
      })
    expect(
      click({
        request: 'r',
        token: 'ok',
        [elicitFormBlockId(0)]: 'ship it',
        [elicitFormBlockId(1)]: 3,
        [elicitFormBlockId(2)]: 'ac_o1',
        [`${elicitFormBlockId(3)}_multi`]: 'ac_o0,ac_o2',
        [elicitFormBlockId(4)]: '',
        stray: 'ignored'
      })
    ).toEqual({
      kind: 'submit',
      requestId: 'r',
      values: {
        [elicitFormBlockId(0)]: 'ship it',
        [elicitFormBlockId(1)]: '3',
        [elicitFormBlockId(2)]: 'ac_o1',
        [elicitFormBlockId(3)]: ['ac_o0', 'ac_o2']
      }
    })
    expect(click({ request: 'r', token: 'x' })).toEqual({ kind: 'choice', requestId: 'r', token: null })
    expect(click({ request: 'r', token: 'ac_o1' })).toEqual({ kind: 'choice', requestId: 'r', token: 'ac_o1' })
    expect(click({ token: 'ok' })).toBeNull()
  })
})

describe('a Teams turn’s question card', () => {
  async function ask(w: Awaited<ReturnType<typeof world>>, req: CreateElicitationRequest) {
    const result = w.permissions.onAcpElicit(AGENT, 's1', req)
    await vi.waitFor(() => expect(w.permissions.pendingElicits.size).toBe(1))
    const id = w.permissions.pendingElicits.keys().next().value
    await vi.waitFor(() => expect(w.permissions.pendingElicits.get(id).ts).toBe('17000000001'))
    return { result }
  }

  it('posts a one-tap card and settles it from the tapped option', async () => {
    const w = await world({ level: 'talk' })
    const { result } = await ask(w, question(BRANCH, ['branch']))
    expect(w.posts()[0]!.target).toEqual(TARGET)
    expect(ofType(w.posts()[0]!.card, 'Action.Execute').map((b) => b.title)).toEqual(['main', 'develop', 'Dismiss'])
    await expect(w.answer(elicitOptionToken(1))).resolves.toMatchObject({ accepted: true })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(w.replaced()).toHaveLength(1))
    expect(ofType(w.replaced()[0]!.card, 'Action.Execute')).toEqual([])
    expect(textOf(w.replaced()[0]!.card)).toBe('💬 Which branch should I cut from?\n✅ develop')
    await w.store.close()
  })

  it('answers a form from the text, number and choice inputs its Confirm carried', async () => {
    const w = await world({ level: 'talk' })
    const { result } = await ask(w, question(FORM, ['note']))
    await w.answer('ok', {
      [elicitFormBlockId(0)]: 'ship it',
      [elicitFormBlockId(1)]: '3',
      [elicitFormBlockId(2)]: elicitOptionToken(1),
      [`${elicitFormBlockId(3)}_multi`]: `${elicitOptionToken(0)},${elicitOptionToken(2)}`
    })
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { note: 'ship it', count: 3, env: 'prod', regions: ['east', 'north'] }
    })
    await w.store.close()
  })

  it('keeps a form live when its Confirm leaves a required field blank', async () => {
    const w = await world({ level: 'talk' })
    void ask(w, question(FORM, ['note']))
    await vi.waitFor(() => expect(w.posts()).toHaveLength(1))
    await vi.waitFor(() => expect(w.permissions.pendingElicits.size).toBe(1))
    await w.answer('ok', { [elicitFormBlockId(0)]: '' })
    expect(w.permissions.pendingElicits.size).toBe(1)
    expect(w.replaced()).toEqual([])
    await w.store.close()
  })

  it('declines on Dismiss', async () => {
    const w = await world({ level: 'talk' })
    const { result } = await ask(w, question(BRANCH, ['branch']))
    await w.answer('x')
    await expect(result).resolves.toEqual({ action: 'decline' })
    await vi.waitFor(() => expect(textOf(w.replaced()[0]!.card)).toContain('🚫'))
    await w.store.close()
  })

  it('declines an ask it has no control for, posting nothing and inventing no answer', async () => {
    const w = await world({ level: 'talk' })
    const long = question({ pick: { type: 'string', enum: Array.from({ length: 25 }, (_, i) => `v${i}`) } }, ['pick'])
    const consent = {
      sessionId: 's1',
      mode: 'url',
      message: 'Open this page',
      elicitationId: 'e1',
      url: 'https://example.test/consent'
    } as unknown as CreateElicitationRequest
    for (const req of [long, consent]) {
      const res = await w.permissions.onAcpElicit(AGENT, 's1', req)
      expect(res?.action).not.toBe('accept')
    }
    expect(w.posts()).toEqual([])
    expect(w.permissions.pendingElicits.size).toBe(0)
    await w.store.close()
  })
})

describe('a forwarded Teams card click with a stale or foreign card', () => {
  it('replaces nothing and still acks a click for a request already settled', async () => {
    const w = await world({ level: 'talk' })
    const ack = await w.click(MSTEAMS_ELICIT_VERB, { request: 'gone', token: elicitOptionToken(0) })
    expect(ack).toEqual({ msgId: expect.any(String), accepted: true })
    expect(w.replaced()).toEqual([])
    await w.store.close()
  })
})

describe('MsTeamsConnection cards', () => {
  it('posts a card as an Adaptive Card attachment and replaces it with a PUT on its activity where it landed', async () => {
    const calls: { method: string; url: string; body: any }[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const json = (body: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }) as unknown as Response
      if (String(url) === msTeamsTokenEndpoint(ZERO)) return json({ access_token: 'tok', expires_in: 3600 })
      calls.push({ method: String(init?.method), url: String(url), body: JSON.parse(String(init?.body)) })
      return json({ id: '17000000001' })
    }) as typeof fetch
    const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
    const conn = new MsTeamsConnection({
      group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
      fetchImpl,
      sendIntervalMs: 0
    })
    const thread = {
      serviceUrl: SERVICE_URL,
      conversationId: '19:example-channel@thread.tacv2;messageid=1700000000000'
    }
    const card = buildMsTeamsApprovalCard({ requestId: 'req-1', params: permission() })
    expect(await conn.postCard(thread, card, 'Permission requested')).toBe('17000000001')
    const settled = { type: 'AdaptiveCard', version: '1.5', body: [] }
    // The card's own thread is remembered, so a replacement with no thread still lands there.
    await conn.replaceCard('17000000001', settled, { channel: '19:example-channel@thread.tacv2' })
    const activities = `${SERVICE_URL}v3/conversations/${encodeURIComponent(thread.conversationId)}/activities`
    expect(calls).toEqual([
      {
        method: 'POST',
        url: activities,
        body: {
          type: 'message',
          attachments: [{ contentType: MSTEAMS_ADAPTIVE_CARD_TYPE, content: card }],
          summary: 'Permission requested'
        }
      },
      {
        method: 'PUT',
        url: `${activities}/17000000001`,
        body: {
          type: 'message',
          attachments: [{ contentType: MSTEAMS_ADAPTIVE_CARD_TYPE, content: settled }],
          id: '17000000001'
        }
      }
    ])
    // A card of a conversation this process never saw is left as it is.
    await expect(conn.replaceCard('17000000009', settled, { channel: '19:unseen@thread.v2' })).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })

  it('keeps two conversations’ cards apart when Teams gives them the same activity ID', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const json = (body: unknown) =>
        ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }) as unknown as Response
      if (String(url) === msTeamsTokenEndpoint(ZERO)) return json({ access_token: 'tok', expires_in: 3600 })
      urls.push(`${String(init?.method)} ${String(url)}`)
      return json({ id: '17000000001' })
    }) as typeof fetch
    const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
    const conn = new MsTeamsConnection({
      group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
      fetchImpl,
      sendIntervalMs: 0
    })
    const a = { serviceUrl: SERVICE_URL, conversationId: '19:example-channel-a@thread.tacv2;messageid=1700000000000' }
    const b = { serviceUrl: SERVICE_URL, conversationId: '19:example-group-b@thread.v2' }
    const card = buildMsTeamsApprovalCard({ requestId: 'req-1', params: permission() })
    await conn.postCard(a, card)
    await conn.postCard(b, card)
    await conn.replaceCard(
      '17000000001',
      { type: 'AdaptiveCard', version: '1.5', body: [] },
      {
        channel: '19:example-channel-a@thread.tacv2'
      }
    )
    expect(urls.at(-1)).toBe(
      `PUT ${SERVICE_URL}v3/conversations/${encodeURIComponent(a.conversationId)}/activities/17000000001`
    )
  })
})
