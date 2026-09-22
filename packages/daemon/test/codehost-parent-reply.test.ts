import { describe, expect, it, vi } from 'vitest'
import type { RdMsgHook } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { sessionKey } from '../src/store/local-store.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'
import { fakeCpClient, scaffold, scriptedHosts, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { WAIT } from './wait-support.js'

const PARENT = 'parent'
const CHILD = 'child'

function hook(provider: 'github' | 'gitlab' | 'gitea', reviewRoot?: string): RdMsgHook {
  return {
    source: 'hook',
    agentId: PARENT,
    hookId: 'hook-1',
    deliveryKey: reviewRoot ?? 'delivery-1',
    msgId: `hook-1:${reviewRoot ?? 'delivery-1'}`,
    sessionKey: provider === 'github' ? 'acme/project#42' : `${provider}:123:issue:42`,
    firedAt: new Date().toISOString(),
    event: reviewRoot ? 'pull_request_review_comment:created' : 'issues:opened',
    context: {
      source: provider,
      event: reviewRoot ? 'pull_request_review_comment' : 'issues',
      action: reviewRoot ? 'created' : 'opened',
      repo: 'acme/project',
      number: 42,
      truncated: false
    },
    ...(provider === 'github'
      ? {
          github: {
            repoId: '123',
            repoFullName: 'acme/project',
            sourceInstallationId: '456',
            subjectKind: reviewRoot ? ('pull_request' as const) : ('issue' as const),
            ...(reviewRoot
              ? { pullNumber: 42, reviewCommentId: reviewRoot, reviewThreadRootCommentId: reviewRoot }
              : {})
          }
        }
      : {}),
    ...(provider === 'gitlab'
      ? { gitlab: { projectId: '123', projectPath: 'acme/project', target: { kind: 'issue' as const, iid: 42 } } }
      : {}),
    ...(provider === 'gitea'
      ? { gitea: { repoId: '123', repoPath: 'acme/project', target: { kind: 'issue' as const, index: 42 } } }
      : {})
  }
}

describe('code-host parent replies', () => {
  it.each(['gitlab', 'gitea'] as const)(
    'refuses publication to a changed instance when replaying a legacy %s hook target',
    async (provider) => {
      const root = scaffold([PARENT])
      const seed = new Daemon({ root, hostFactory: scriptedHosts({ [PARENT]: () => 'unused' }).factory })
      await seed.start()
      const delivery = hook(provider)
      const target = { provider, hookId: 'hook-1', repo: '123', number: 42, subjectKind: 'issue' }
      const key = sessionKey('hook', `${provider}:123`, '42', PARENT, `${provider}:123`)
      await (seed as any).store.appendInbox({
        id: 'legacy-hook',
        sessionKey: key,
        agentId: PARENT,
        enqueuedAt: '1',
        loopGuardCounted: 1,
        hookContext: JSON.stringify({ ...delivery, githubReply: target }),
        posterPublishState: 'not_started',
        msg: JSON.stringify({
          msgId: 'legacy-hook',
          source: 'hook',
          platform: 'hook',
          channel: `${provider}:123`,
          thread: '42',
          transportScope: `${provider}:123`,
          sender: { id: 'hook', isBot: true },
          text: 'Legacy hook.',
          mentionedBots: [],
          isDm: false
        })
      })
      await seed.stop()
      const runtime = scriptedHosts({ [PARENT]: () => 'Resumed.' })
      const restarted = new Daemon({ root, hostFactory: runtime.factory })
      const cp = {
        ...fakeCpClient(),
        emitEventSession: vi.fn(),
        emitHookReport: vi.fn(async () => 'acknowledged' as const)
      }
      ;(restarted as any).cpClient = cp
      const mint = vi.fn(async () => ({ token: 'test-token' }))
      Object.assign((restarted as any).githubReviews.turnFinalHost, {
        getGitlabPostToken: mint,
        getGiteaPostToken: mint,
        gitlabHostFor: () => 'https://replacement.example.test',
        giteaHostFor: () => 'https://replacement.example.test'
      })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected provider request'))
      try {
        await restarted.start()
        await vi.waitFor(() => expect(cp.emitHookReport).toHaveBeenCalledTimes(1), WAIT)
        expect(mint).not.toHaveBeenCalled()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(cp.emitHookReport).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'failed', reason: 'note_publish_failed:token_unavailable' })
        )
      } finally {
        await restarted.stop()
        fetchSpy.mockRestore()
      }
    }
  )

  it.each(['github', 'gitlab', 'gitea'] as const)(
    'resumes a %s parent and publishes only its answer after an explicit child report',
    async (provider) => {
      await roundTrip(provider, true)
    }
  )

  it('infers a child report into the same code-host output route', async () => {
    await roundTrip('github', false)
  })

  it.each([true, false])('keeps an inline report on thread A after thread B runs (explicit: %s)', async (explicit) => {
    await roundTrip('github', explicit, true)
  })

  it.each(['public', 'console', 'legacy'] as const)('replays a child with its %s origin snapshot', async (source) => {
    const root = scaffold([PARENT, CHILD])
    const seed = new Daemon({
      root,
      hostFactory: scriptedHosts({ [PARENT]: () => 'AC_NO_RESPONSE', [CHILD]: () => 'unused' }).factory
    })
    await seed.start()
    const seedCp = {
      ...fakeCpClient(),
      emitEventSession: vi.fn(),
      emitHookReport: vi.fn(async () => 'acknowledged' as const)
    }
    ;(seed as any).cpClient = seedCp
    const target = {
      provider: 'github',
      hookId: 'hook-1',
      repo: 'acme/project',
      number: 42,
      reviewThreadRootCommentId: '101'
    }
    const snapshot = source === 'public' ? target : source === 'console' ? null : undefined
    try {
      ;(seed as any).handleRelayMsg(hook('github', '202'), () => {})
      await vi.waitFor(() => expect(seedCp.emitHookReport).toHaveBeenCalledTimes(1), WAIT)
      const [parent] = await (seed as any).store.listSessions(PARENT)
      await (seed as any).store.appendInbox({
        id: 'delegated-work',
        sessionKey: sessionKey('dream', 'a2a:parent', 'work', CHILD),
        agentId: CHILD,
        enqueuedAt: '1',
        loopGuardCounted: 1,
        callMeta: JSON.stringify({
          callFrom: PARENT,
          hopCount: 0,
          deliveryId: 'delegated-work',
          originSessionId: parent.sessionId,
          originCodeHostReplyTarget: snapshot,
          needsReply: true,
          externalOrigin: await (seed as any).externalOriginForSession(PARENT, parent.key)
        }),
        msg: JSON.stringify({
          msgId: 'delegated-work',
          source: 'agent',
          platform: 'dream',
          channel: 'a2a:parent',
          thread: 'work',
          sender: { id: PARENT, isBot: true },
          text: 'Investigate.',
          mentionedBots: [],
          isDm: false
        })
      })
    } finally {
      await seed.stop()
    }
    const runtime = scriptedHosts({
      [CHILD]: () => 'Private child findings.',
      [PARENT]: () => 'Recovered parent answer.'
    })
    const restarted = new Daemon({ root, hostFactory: runtime.factory })
    const publish = vi.fn(async () => {})
    const makeReply = vi.fn(() => ({ poster: { publish }, collector: new GithubReplyCollector() }))
    ;(restarted as any).cpClient = { ...fakeCpClient(), emitEventSession: vi.fn() }
    ;(restarted as any).githubReviews.makeCodeHostReply = makeReply
    try {
      await restarted.start()
      await vi.waitFor(() => expect(runtime.prompts.get(PARENT)).toHaveLength(1), WAIT)
      await settle()
      if (source === 'public') {
        expect(makeReply).toHaveBeenCalledWith(PARENT, target, expect.any(String))
        expect(publish).toHaveBeenCalledExactlyOnceWith('Recovered parent answer.')
      } else {
        expect(makeReply).not.toHaveBeenCalled()
      }
      const [child] = await (restarted as any).store.listSessions(CHILD)
      expect(child.originCodeHostReplyTarget).toBe(snapshot === undefined ? null : JSON.stringify(snapshot))
    } finally {
      await restarted.stop()
    }
  })

  it.each(['not_started', 'in_flight', 'settled'] as const)(
    'replays a parent report with its %s publication fence and no hook run',
    async (state) => {
      const root = scaffold([PARENT])
      const seed = new Daemon({ root, hostFactory: scriptedHosts({ [PARENT]: () => 'unused' }).factory })
      await seed.start()
      const target = { provider: 'github', hookId: 'hook-1', repo: 'acme/project', number: 42 }
      const key = sessionKey('hook', 'github:123', '42', PARENT, 'github:123')
      await (seed as any).store.appendInbox({
        id: 'parent-report',
        sessionKey: key,
        agentId: PARENT,
        enqueuedAt: '1',
        loopGuardCounted: 1,
        codeHostReplyTarget: JSON.stringify(target),
        posterPublishState: state,
        msg: JSON.stringify({
          msgId: 'parent-report',
          source: 'agent',
          platform: 'hook',
          channel: 'github:123',
          thread: '42',
          transportScope: 'github:123',
          sender: { id: CHILD, isBot: true },
          text: 'Recovered private findings.',
          mentionedBots: [],
          isDm: false,
          parentReport: true
        })
      })
      await seed.stop()
      const runtime = scriptedHosts({ [PARENT]: () => 'Recovered parent answer.' })
      const restarted = new Daemon({ root, hostFactory: runtime.factory })
      const publish = vi.fn(async () => {})
      const makeReply = vi.fn(() => ({ poster: { publish }, collector: new GithubReplyCollector() }))
      const cp = { ...fakeCpClient(), emitEventSession: vi.fn(), emitHookReport: vi.fn() }
      ;(restarted as any).cpClient = cp
      ;(restarted as any).githubReviews.makeCodeHostReply = makeReply
      try {
        await restarted.start()
        await vi.waitFor(() => expect(runtime.prompts.get(PARENT)).toHaveLength(1), WAIT)
        await settle()
        if (state === 'not_started') {
          expect(publish).toHaveBeenCalledExactlyOnceWith('Recovered parent answer.')
          expect(makeReply).toHaveBeenCalledWith(PARENT, target, expect.any(String))
        } else {
          expect(makeReply).not.toHaveBeenCalled()
          expect(publish).not.toHaveBeenCalled()
        }
        expect(cp.emitHookReport).not.toHaveBeenCalled()
      } finally {
        await restarted.stop()
      }
    }
  )
})

async function roundTrip(provider: 'github' | 'gitlab' | 'gitea', explicit: boolean, interleave = false) {
  let releaseChild!: () => void
  const childCanFinish = new Promise<void>((resolve) => {
    releaseChild = resolve
  })
  const bindings = new Map<string, { endpoint: string; token: string }>()
  const parentInputs: string[] = []
  let childResult: unknown
  let delegateResult: unknown
  let seq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) => ({
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, mcpServers?: unknown) => {
      const sid = `acp-${agent.id}-${++seq}`
      const binding = daemonMcpBinding(mcpServers)
      if (binding) bindings.set(sid, binding)
      return sid
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
      const text = blocks.map((b) => b.text ?? '').join('\n')
      let answer: string
      if (agent.id === PARENT) {
        parentInputs.push(text)
        if (parentInputs.length === 1) {
          delegateResult = await callDaemonTool(bindings.get(sid)!, 'sendMessage', {
            toAgent: { agentId: CHILD, needsReply: true },
            message: 'Investigate and report back.'
          })
          answer = 'AC_NO_RESPONSE'
        } else if (interleave && parentInputs.length === 2) {
          answer = 'AC_NO_RESPONSE'
        } else {
          const d = daemon as any
          expect(d.activeGithubTurnMeta.size).toBe(0)
          expect(d.gitlabReviews.turns.size).toBe(0)
          expect(d.giteaReviews.turns.size).toBe(0)
          answer = 'Public summary from the parent.'
        }
      } else {
        await childCanFinish
        if (explicit) {
          const parentId = [...text.matchAll(/"sessionId":"([^"]+)"/g)]
            .map((m) => m[1])
            .find((v) => !v!.startsWith('<'))
          childResult = await callDaemonTool(bindings.get(sid)!, 'sendMessage', {
            sessionId: parentId,
            message: 'Private child findings.'
          })
        }
        answer = explicit ? 'Reported.' : 'Private child findings.'
      }
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
  const daemon = new Daemon({ root: scaffold([PARENT, CHILD]), hostFactory: factory as never })
  const cp = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
    emitHookReport: vi.fn(async () => 'acknowledged' as const)
  }
  await daemon.start()
  const d = daemon as any
  d.cpClient = cp
  Object.assign(d.githubReviews.turnFinalHost, {
    getPostToken: async () => ({ token: 'test-token' }),
    getGitlabPostToken: async () => ({ token: 'test-token' }),
    getGiteaPostToken: async () => ({ token: 'test-token' })
  })
  const requests: { url: string; body: Record<string, unknown> }[] = []
  const localFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const hostname = new URL(String(url)).hostname
    if (hostname === '127.0.0.1' || hostname === 'localhost') return localFetch(url, init)
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ id: 9001, html_url: 'https://example.test/comment/9001' }), { status: 201 })
  })
  seedCallPolicy(daemon, [PARENT, CHILD], {
    [PARENT]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [CHILD]
    },
    [CHILD]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [PARENT],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: []
    }
  })
  try {
    d.handleRelayMsg(hook(provider, interleave ? '101' : undefined), () => {})
    await vi.waitFor(() => expect(cp.emitHookReport).toHaveBeenCalledTimes(1), WAIT)
    expect(delegateResult).toMatchObject({ ok: true })
    await vi.waitFor(async () => {
      const [child] = await d.store.listSessions(CHILD)
      expect(JSON.parse(child?.originCodeHostReplyTarget ?? 'null')).toMatchObject({
        provider,
        hookId: 'hook-1',
        number: 42
      })
    }, WAIT)
    if (interleave) {
      d.handleRelayMsg(hook(provider, '202'), () => {})
      await vi.waitFor(() => expect(cp.emitHookReport).toHaveBeenCalledTimes(2), WAIT)
      expect(await d.store.listSessions(PARENT)).toHaveLength(1)
    }
    releaseChild()
    const replies = () => requests.filter((r) => typeof r.body.body === 'string')
    await vi.waitFor(() => expect(replies()).toHaveLength(1), WAIT)
    await settle()
    if (explicit) expect(childResult).toMatchObject({ ok: true })
    expect(parentInputs).toHaveLength(interleave ? 3 : 2)
    expect(parentInputs.at(-1)).toContain('Private child findings.')
    expect(parentInputs.at(-1)?.includes('[inferred reply]')).toBe(!explicit)
    const endpoints = {
      github: interleave
        ? 'https://api.github.com/repos/acme/project/pulls/42/comments/101/replies'
        : 'https://api.github.com/repos/acme/project/issues/42/comments',
      gitlab: 'https://gitlab.com/api/v4/projects/123/issues/42/notes',
      gitea: 'https://gitea.com/api/v1/repos/acme/project/issues/42/comments'
    }
    expect(replies()).toEqual([
      { url: endpoints[provider], body: { body: expect.stringContaining('Public summary from the parent.') } }
    ])
    expect(JSON.stringify(requests)).not.toContain('Private child findings.')
    // A report resumes an ordinary turn, not the completed hook or its formal-review authority.
    expect(cp.emitHookReport).toHaveBeenCalledTimes(interleave ? 2 : 1)
  } finally {
    releaseChild()
    await daemon.stop()
    fetchSpy.mockRestore()
  }
}
