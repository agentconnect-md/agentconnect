import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { SlackConnection } from '../src/slack/connection.js'
import { defuseNoticeText } from '../src/permissions/elicit-notice.js'

/**
 * An elicitation this turn's surface cannot render used to be declined in SILENCE (#1794): the
 * agent asked the reader a question and, from the channel, it was indistinguishable from the
 * agent ignoring them. The decline stands — nothing here answers on the reader's behalf — but
 * the channel now hears what was asked and where it can be answered.
 */

/** A plain single-enum form — renderable everywhere. */
function formElicitation(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: {
      type: 'object',
      properties: { branch: { type: 'string', enum: ['main', 'develop', 'release'] } },
      required: ['branch']
    },
    ...overrides
  } as CreateElicitationRequest
}

/** A required nested object: a field NO surface has a control for, so every one of them
 *  declines it — which is what leaves the in-channel notice as the only thing to say. */
function unrenderableElicitation(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: { checks: { type: 'object' } },
      required: ['checks']
    },
    ...overrides
  })
}

/** Two required fields: one webchat card asks both, while Slack's single-field card cannot. */
function twoFieldElicitation(): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: { checks: { type: 'string', enum: ['lint', 'test'] }, note: { type: 'string' } },
      required: ['checks', 'note']
    }
  })
}

/** A free-text field — which Slack now asks as a question answered by a thread reply. */
function textElicitation(): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: { checks: { type: 'string' } },
      required: ['checks']
    }
  })
}

/** A multi-select — which Slack renders as a select plus Confirm, so it keeps no notice. */
function multiElicitation(): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: { checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] } } },
      required: ['checks']
    }
  })
}

function installPending(daemon: Daemon): any {
  ;(daemon as any).store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    createPermissionRequest: vi.fn(),
    resolvePermissionRequest: vi.fn(() => true),
    upsertElicit: vi.fn(async () => {})
  }
  const pending = {
    plan: {
      platform: 'hook',
      agentId: 'agent-1',
      sessionKey: 'k1',
      channel: 'test',
      statusThread: 'test',
      approvalSurfaceSuppressed: false
    },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder()
  }
  ;(daemon as any).pending.set(JSON.stringify(['agent-1', 's1']), pending)
  return pending
}

/** A daemon whose turn is a Slack turn, with every enqueued render action captured. */
function slackTurn(): { daemon: any; pending: any; notices: () => string[] } {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const pending = installPending(daemon)
  pending.plan.platform = 'slack'
  const conn = Object.create(SlackConnection.prototype)
  conn.postBlocks = async () => 'ts-1'
  conn.updateBlocks = async () => true
  conn.workspaceId = () => 'T1'
  pending.conn = conn
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example' }
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  return {
    daemon,
    pending,
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  }
}

/** The same turn, on webchat — whose reader hears nothing through `enqueueApply` and everything
 *  through the reply stream, so its notices are stream events. */
function webchatTurn(): { daemon: any; pending: any; sink: any; events: () => any[]; notices: () => string[] } {
  const { daemon, pending } = slackTurn()
  pending.plan.platform = 'webchat'
  const sink = { output: vi.fn(), done: vi.fn() }
  pending.webchat = {
    conversationId: 'conv-1',
    turnId: 'turn-1',
    sink,
    index: 0,
    replyText: '',
    heldText: '',
    messageEmitted: false
  }
  const events = (): any[] => sink.output.mock.calls.map(([o]: any[]) => o.event)
  return {
    daemon,
    pending,
    sink,
    events,
    notices: () =>
      events()
        .filter((e) => e.kind === 'notice')
        .map((e) => e.text as string)
  }
}

describe('an elicitation declined for want of a surface says so in the channel', () => {
  it('posts the notice and still declines when a Slack card cannot express the form', async () => {
    const { daemon, notices } = slackTurn()
    await expect(daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())).resolves.toBeUndefined()
    expect(daemon.permissions.pendingElicits.size).toBe(0)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toContain("this chat can't collect an answer for")
    expect(notices()[0]).toContain('Which checks should I run?')
    expect(notices()[0]).toContain('/sessions/sess-1')
  })

  // A Slack NOTICE is a `type: 'markdown'` block (postMessage → markdownBlock), NOT the `mrkdwn`
  // section an elicitation CARD uses — so the syntax to kill here is `[label](url)`, not `<url|label>`.
  it('carries the agent’s question DEFUSED — a Slack notice is markdown, and links in it are taps', async () => {
    const { daemon, notices } = slackTurn()
    await daemon.permissions.onAcpElicit(
      'agent-1',
      's1',
      unrenderableElicitation({
        message: 'Sign in at [your account](https://evil.example/x) or https://evil.example/y'
      })
    )
    const text = notices()[0]!
    // The label form cannot survive as markup, and the bare URL cannot autolink.
    expect(text).not.toContain('[your account](')
    expect(text).toContain('\\[your account\\]')
    expect(text).toContain('`https://evil.example/y`')
  })

  it('quotes the MASKED question, not the raw one the runtime sent', async () => {
    const { daemon, notices } = slackTurn()
    daemon.maskAgentSecrets = (_id: string, params: any) => ({
      ...params,
      message: params.message.replace('hunter2', '••••')
    })
    await daemon.permissions.onAcpElicit(
      'agent-1',
      's1',
      unrenderableElicitation({ message: 'Is hunter2 still the token?' })
    )
    expect(notices()[0]).toContain('Is •••• still the token?')
    expect(notices()[0]).not.toContain('hunter2')
  })

  it('collapses a repeated question to one notice, and lets a different question through', async () => {
    const { daemon, notices } = slackTurn()
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    expect(notices()).toHaveLength(1)
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation({ message: 'And which runner?' }))
    expect(notices()).toHaveLength(2)
    expect(notices()[1]).toContain('And which runner?')
  })

  it('says nothing when the card WAS rendered', async () => {
    const { daemon, notices } = slackTurn()
    void daemon.permissions.onAcpElicit('agent-1', 's1', formElicitation())
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')
  })

  it('says nothing on a webchat turn, which renders a whole form Slack cannot', async () => {
    const { daemon, pending, notices } = slackTurn()
    pending.plan.platform = 'webchat'
    pending.webchat = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      sink: { output: vi.fn(), done: vi.fn() },
      index: 0,
      replyText: '',
      heldText: '',
      messageEmitted: false
    }
    void daemon.permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation())
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')
  })

  it('says nothing for a multi-select Slack now renders as a select plus Confirm', async () => {
    const { daemon, notices } = slackTurn()
    void daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')
  })

  it('says nothing for a text field Slack now answers by a thread reply', async () => {
    const { daemon, notices } = slackTurn()
    void daemon.permissions.onAcpElicit('agent-1', 's1', textElicitation())
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')
  })

  it('says nothing for a URL-mode ask Slack now renders as a consent card', async () => {
    const { daemon, notices } = slackTurn()
    void daemon.permissions.onAcpElicit('agent-1', 's1', {
      sessionId: 's1',
      mode: 'url',
      elicitationId: 'el-1',
      url: 'https://billing.example.com/oauth/authorize',
      message: 'Sign in to continue'
    } as CreateElicitationRequest)
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')

    // A URL no card may offer is still an ask Slack cannot render, so that one keeps its notice.
    await expect(
      daemon.permissions.onAcpElicit('agent-1', 's1', {
        sessionId: 's1',
        mode: 'url',
        elicitationId: 'el-2',
        url: 'javascript:alert(1)',
        message: 'Run this'
      } as CreateElicitationRequest)
    ).resolves.toBeUndefined()
    expect(notices()).toHaveLength(1)
  })

  it('says nothing for an MCP approval, which has its own notice on the editor path', async () => {
    const { daemon, notices } = slackTurn()
    // Chat approval enabled, so the request reaches the card path rather than the editor queue.
    daemon.agents.set('agent-1', { allowRuntimeChangesInChat: true })
    await expect(
      daemon.permissions.onAcpElicit(
        'agent-1',
        's1',
        unrenderableElicitation({ _meta: { codex_approval_kind: 'mcp_tool_call' } })
      )
    ).resolves.toBeUndefined()
    expect(notices()).toEqual([])
  })

  it('says nothing on a turn whose surface was deliberately suppressed', async () => {
    const suppressed = slackTurn()
    suppressed.pending.plan.approvalSurfaceSuppressed = true
    await expect(
      suppressed.daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    ).resolves.toEqual({
      action: 'cancel'
    })
    expect(suppressed.notices()).toEqual([])

    const quiet = slackTurn()
    quiet.pending.outputSuppressed = 'paused'
    await expect(quiet.daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())).resolves.toEqual({
      action: 'cancel'
    })
    expect(quiet.notices()).toEqual([])
  })
})

describe('a notice defuses agent text the way its own surface reads it', () => {
  it('neutralises Discord’s masked-link syntax and its autolink', () => {
    // Escaping only the brackets can CREATE the link it means to kill: the parser eats our
    // added pair as one literal backslash and hands an already-escaped bracket back, live.
    const preEscaped = defuseNoticeText(
      String.raw`Sign in at \[your account\](https\://evil.example/login)`,
      'markdown'
    )
    expect(preEscaped).toBe(String.raw`Sign in at \\\[your account\\\](https\\://evil.example/login)`)

    // A backslash-escaped scheme slips past a bare-URL scan while the parser still reads the
    // destination, so the LABEL is what has to die — escaping the brackets is what does it.
    const escaped = defuseNoticeText('Sign in at [your account](https\\://evil.example/login)', 'markdown')
    expect(escaped).not.toContain('[your account](')
    expect(escaped).toContain('\\[your account\\]')

    const out = defuseNoticeText('See [your account](https://evil.example/x) or https://evil.example/y', 'markdown')
    expect(out).toBe('See \\[your account\\](`https://evil.example/x`) or `https://evil.example/y`')
  })

  it('leaves a markup-less surface’s text verbatim — it has no label syntax to spoof with', () => {
    const raw = 'See <https://evil.example/x|your account> & [label](https://evil.example/y)'
    expect(defuseNoticeText(raw, undefined)).toBe(raw)
  })
})

/**
 * The plan for #1819 said webchat needed no notice because it renders every shape. It does not:
 * a `required` property no control can answer (#1795) is declined here exactly as it is on Slack,
 * and until now `awaitWebchatElicitation` returned `undefined` with NOTHING in the conversation.
 * Webchat says things by streaming them, so the notice is a stream event rather than a post.
 */
describe('webchat says a declined elicitation out loud too', () => {
  it('streams a standing notice, and still declines', async () => {
    const { daemon, events } = webchatTurn()
    await expect(daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())).resolves.toBeUndefined()
    expect(daemon.permissions.pendingElicits.size).toBe(0)
    expect(events()).toEqual([
      {
        kind: 'notice',
        // `standing` is the whole point: a wait notice is retired the moment output resumes,
        // which would delete the only thing the reader was ever told about this question.
        standing: true,
        text: expect.stringContaining("this chat can't collect an answer for")
      }
    ])
    expect(events()[0].text).toContain('Which checks should I run?')
  })

  it('quotes the MASKED question, and leaves its text VERBATIM — this card is our own DOM', async () => {
    const { daemon, notices } = webchatTurn()
    daemon.maskAgentSecrets = (_id: string, params: any) => ({
      ...params,
      message: params.message.replace('hunter2', '••••')
    })
    await daemon.permissions.onAcpElicit(
      'agent-1',
      's1',
      unrenderableElicitation({ message: 'Is hunter2 the token? See [your account](https://evil.example/x)' })
    )
    expect(notices()[0]).toContain('Is •••• the token?')
    expect(notices()[0]).not.toContain('hunter2')
    // No markup dialect reads this text — React renders it as a text node — so defusing it
    // would only show the reader backslashes it cannot tell from the agent's own.
    expect(notices()[0]).toContain('[your account](https://evil.example/x)')
  })

  it('does not send the reader to the console they are already reading it in', async () => {
    const { daemon, notices } = webchatTurn()
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    // The Slack notice's tail offers the session console; here that console's OWN surface is
    // what declined, so offering it would be a lie.
    expect(notices()[0]).not.toContain('/sessions/sess-1')
    expect(notices()[0]).not.toContain('session console')
  })

  it('collapses a repeated question to one notice, and lets a different question through', async () => {
    const { daemon, notices } = webchatTurn()
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation())
    expect(notices()).toHaveLength(1)
    await daemon.permissions.onAcpElicit('agent-1', 's1', unrenderableElicitation({ message: 'And which runner?' }))
    expect(notices()).toHaveLength(2)
  })

  it('says nothing when the STREAM is what failed — there is nothing left to say it with', async () => {
    const { daemon, sink } = webchatTurn()
    sink.output.mockImplementation(() => {
      throw new Error('socket closed')
    })
    await expect(daemon.permissions.onAcpElicit('agent-1', 's1', formElicitation())).resolves.toBeUndefined()
    expect(daemon.permissions.pendingElicits.size).toBe(0)
    // One attempt, the card's own: a notice would ride the same broken call, and a webchat turn
    // has no second surface to fall back to.
    expect(sink.output).toHaveBeenCalledTimes(1)
  })

  it('says nothing for the shapes webchat renders', async () => {
    const { daemon, notices } = webchatTurn()
    void daemon.permissions.onAcpElicit('agent-1', 's1', twoFieldElicitation())
    await vi.waitFor(() => expect(daemon.permissions.pendingElicits.size).toBe(1))
    expect(notices()).toEqual([])
    await daemon.permissions.releaseElicits('agent-1', 's1')
  })
})
