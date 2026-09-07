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

/** A multi-select: renderable on webchat, never on a Slack button row. */
function multiElicitation(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return formElicitation({
    message: 'Which checks should I run?',
    requestedSchema: {
      type: 'object',
      properties: { checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] } } },
      required: ['checks']
    },
    ...overrides
  })
}

function installPending(daemon: Daemon): any {
  ;(daemon as any).store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    createPermissionRequest: vi.fn(),
    resolvePermissionRequest: vi.fn(() => true)
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

describe('an elicitation declined for want of a surface says so in the channel', () => {
  it('posts the notice and still declines when a Slack card cannot express the form', async () => {
    const { daemon, notices } = slackTurn()
    await expect(daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())).resolves.toBeUndefined()
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
      multiElicitation({ message: 'Sign in at [your account](https://evil.example/x) or https://evil.example/y' })
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
    await daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation({ message: 'Is hunter2 still the token?' }))
    expect(notices()[0]).toContain('Is •••• still the token?')
    expect(notices()[0]).not.toContain('hunter2')
  })

  it('collapses a repeated question to one notice, and lets a different question through', async () => {
    const { daemon, notices } = slackTurn()
    await daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())
    await daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())
    expect(notices()).toHaveLength(1)
    await daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation({ message: 'And which runner?' }))
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

  it('says nothing on a webchat turn, which renders every shape itself', async () => {
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
    void daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())
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
        multiElicitation({ _meta: { codex_approval_kind: 'mcp_tool_call' } })
      )
    ).resolves.toBeUndefined()
    expect(notices()).toEqual([])
  })

  it('says nothing on a turn whose surface was deliberately suppressed', async () => {
    const suppressed = slackTurn()
    suppressed.pending.plan.approvalSurfaceSuppressed = true
    await expect(suppressed.daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())).resolves.toEqual({
      action: 'cancel'
    })
    expect(suppressed.notices()).toEqual([])

    const quiet = slackTurn()
    quiet.pending.outputSuppressed = 'paused'
    await expect(quiet.daemon.permissions.onAcpElicit('agent-1', 's1', multiElicitation())).resolves.toEqual({
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
