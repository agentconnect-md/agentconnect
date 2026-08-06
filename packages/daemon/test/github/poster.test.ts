/**
 * GitHub reply selection + posting: only the completed human-facing answer
 * reaches GitHub, in one comment carrying its attribution/session footer.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  GithubFinalPoster,
  GithubReplyCollector,
  githubAttributionFooter,
  type GithubCommentAttribution,
  type GithubCommentAttributionSource,
  type PosterScheduler
} from '../../src/github/poster.js'

/** A hand-driven clock with enough timer fidelity for the publish deadline. */
function fakeScheduler() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { fn: () => void; at: number }>()
  const sched: PosterScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++
      pending.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    }
  }
  return {
    sched,
    elapse(ms: number) {
      now += ms
    },
    advance(ms: number) {
      now += ms
      // A callback may schedule another already-due timer; drain deterministically.
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        pending.delete(due[0])
        due[1].fn()
      }
    }
  }
}

interface Call {
  method: string
  url: string
  body: string
}

function fakeFetch(opts: { failFirst?: number; failStatus?: number } = {}) {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    n += 1
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: JSON.parse(String(init?.body)).body })
    if (opts.failFirst && n <= opts.failFirst) {
      return new Response('', { status: opts.failStatus ?? 500 })
    }
    return new Response('{"id":90071992547409931}', {
      status: 201,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function hangingFetch() {
  const calls: Call[] = []
  let signal: AbortSignal | undefined
  let aborted = false
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: JSON.parse(String(init?.body)).body })
    signal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('aborted'))
        },
        { once: true }
      )
    })
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    get signal() {
      return signal
    },
    get aborted() {
      return aborted
    }
  }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const log = { warn: vi.fn() }

/** Let the poster's async token -> fetch chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const attribution: GithubCommentAttribution = {
  agentName: 'review-bot',
  agentUrl: 'https://app.example.test/acme/agents/review-bot',
  runtime: 'Codex',
  model: 'gpt-5.6-luna',
  sessionUrl: 'https://app.example.test/acme/sessions/session-1'
}

function make(
  fetchImpl: typeof fetch,
  sched: PosterScheduler,
  opts: {
    attribution?: GithubCommentAttributionSource
    finalizeTimeoutMs?: number
    token?: () => Promise<string>
    invalidateToken?: (token: string) => void
    reviewThreadRootCommentId?: string
  } = {}
) {
  return new GithubFinalPoster(
    {
      token: opts.token ?? (async () => 'ghs_test'),
      ...(opts.invalidateToken ? { invalidateToken: opts.invalidateToken } : {}),
      log,
      fetchImpl,
      scheduler: sched,
      ...(opts.finalizeTimeoutMs !== undefined ? { finalizeTimeoutMs: opts.finalizeTimeoutMs } : {})
    },
    'acme/infra',
    42,
    opts.attribution,
    opts.reviewThreadRootCommentId
  )
}

function message(text: string, opts: { id?: string; phase?: 'commentary' | 'final_answer' } = {}) {
  return {
    sessionUpdate: 'agent_message_chunk',
    ...(opts.id ? { messageId: opts.id } : {}),
    content: { type: 'text', text },
    ...(opts.phase ? { _meta: { codex: { phase: opts.phase } } } : {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GithubReplyCollector', () => {
  it('publishes only codex final_answer chunks, never commentary or unphased compaction chrome', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message("I'll inspect this.", { id: 'commentary-1', phase: 'commentary' }))
    c.onUpdate(message("*Context compacted to fit the model's context window.*\n\n"))
    c.onUpdate(message('The final ', { id: 'final-1', phase: 'final_answer' }))
    c.onUpdate(message('answer.', { id: 'final-1', phase: 'final_answer' }))
    expect(c.finalText()).toBe('The final answer.')
  })

  it('upgrades an earlier unphased chunk when final metadata arrives later for the same messageId', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('Complete ', { id: 'answer' }))
    c.onUpdate(message('answer', { id: 'answer', phase: 'final_answer' }))
    expect(c.finalText()).toBe('Complete answer')
  })

  it('joins multiple explicitly-final messages at message boundaries', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('First paragraph.', { id: 'final-1', phase: 'final_answer' }))
    c.onUpdate(message('Second paragraph.', { id: 'final-2', phase: 'final_answer' }))
    expect(c.finalText()).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('falls back to the last logical messageId for legacy phase-less adapters', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('intermediate status', { id: 'message-1' }))
    c.onUpdate(message('legacy final ', { id: 'message-2' }))
    c.onUpdate(message('answer', { id: 'message-2' }))
    expect(c.finalText()).toBe('legacy final answer')
  })

  it('falls back to the last unkeyed text run after a tool boundary for runtimes with no metadata', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('intermediate status'))
    c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Inspect repository' })
    c.onUpdate(message('legacy final answer'))
    expect(c.finalText()).toBe('legacy final answer')
  })

  it('retains an unkeyed final run even if the platform renderer idle-flushed it before turn end', () => {
    const c = new GithubReplyCollector()

    c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Inspect repository' })
    c.onUpdate(message('answer that may be idle-flushed'))
    // Idle flush is not an ACP update; final selection must retain its own copy.
    expect(c.finalText()).toBe('answer that may be idle-flushed')
  })

  it('does not promote unknown partial output on a failed turn', () => {
    const unknown = new GithubReplyCollector()
    unknown.onUpdate(message('partial legacy output'))
    expect(unknown.finalText(false)).toBeUndefined()

    const explicit = new GithubReplyCollector()
    explicit.onUpdate(message('authoritative answer', { id: 'final', phase: 'final_answer' }))
    expect(explicit.finalText(false)).toBe('authoritative answer')
  })

  it.each([
    ['an explicit final', message('AC_NO_RESPONSE', { id: 'final', phase: 'final_answer' })],
    [
      'a non-compliant explanation ending in the marker',
      message('This activation is not for me.\n\nAC_NO_RESPONSE', { id: 'final', phase: 'final_answer' })
    ],
    ['a phase-less fallback', message('AC_NO_RESPONSE')]
  ])('suppresses the no-response control marker from %s', (_label, update) => {
    const c = new GithubReplyCollector()
    c.onUpdate(update)
    expect(c.finalText()).toBeUndefined()
  })

  it('does not fall back to unphased chrome once codex emitted phase metadata', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message("*Context compacted to fit the model's context window.*\n\n"))
    c.onUpdate(message('Still working.', { id: 'commentary', phase: 'commentary' }))
    expect(c.finalText()).toBeUndefined()
  })

  it('uses a phase-unknown keyed answer as the completed fallback after known commentary', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('Checking the repository.', { id: 'commentary', phase: 'commentary' }))
    c.onUpdate(message('Fallback final answer.', { id: 'answer' }))
    expect(c.finalText()).toBe('Fallback final answer.')
  })

  it('keeps anonymous exited-review output as a valid final after known commentary', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('Reviewing the changes.', { id: 'commentary', phase: 'commentary' }))
    c.onUpdate(message('No findings.'))
    expect(c.finalText()).toBe('No findings.')
  })

  it.each([
    "*Context compacted to fit the model's context window.*\n\n",
    'Context compacted.',
    'Config warning: config.toml contains a deprecated setting\n\n',
    'Warning: falling back to the default model\n\n',
    '*Conversation interrupted*'
  ])('never promotes or merges anonymous Codex chrome: %s', (chrome) => {
    const onlyChrome = new GithubReplyCollector()
    onlyChrome.onUpdate(message(chrome))
    expect(onlyChrome.finalText()).toBeUndefined()

    const beforeFinal = new GithubReplyCollector()
    beforeFinal.onUpdate(message(chrome))
    beforeFinal.onUpdate(message('Actual answer.', { id: 'final', phase: 'final_answer' }))
    expect(beforeFinal.finalText()).toBe('Actual answer.')
  })

  it('merges an anonymous first delta into the final message once its id and phase arrive', () => {
    const c = new GithubReplyCollector()

    c.onUpdate(message('Complete '))
    c.onUpdate(message('answer.', { id: 'answer', phase: 'final_answer' }))
    expect(c.finalText()).toBe('Complete answer.')
  })

  it('chooses the unified last-seen fallback across keyed and unkeyed message runs', () => {
    const keyedThenUnkeyed = new GithubReplyCollector()
    keyedThenUnkeyed.onUpdate(message('older keyed answer', { id: 'keyed' }))
    keyedThenUnkeyed.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'More work' })
    keyedThenUnkeyed.onUpdate(message('newer unkeyed answer'))
    expect(keyedThenUnkeyed.finalText()).toBe('newer unkeyed answer')

    const unkeyedThenKeyed = new GithubReplyCollector()
    unkeyedThenKeyed.onUpdate(message('older unkeyed answer'))
    unkeyedThenKeyed.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'More work' })
    unkeyedThenKeyed.onUpdate(message('newer keyed answer', { id: 'keyed' }))
    expect(unkeyedThenKeyed.finalText()).toBe('newer keyed answer')
  })
})

describe('GithubFinalPoster', () => {
  it.each([undefined, '', '   '])('a turn with no completed final output posts nothing (%s)', async (body) => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched)

    await poster.publish(body)

    expect(f.calls).toHaveLength(0)
  })

  it('publishes the completed final in exactly one POST without exposing a partial snapshot', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched)
    const partial = 'Agent'
    const fullFinal = 'AgentConnect keeps the message hot path inside the daemon.'

    expect(f.calls).toHaveLength(0)
    await poster.publish(fullFinal)

    expect(f.calls).toEqual([
      {
        method: 'POST',
        url: expect.stringContaining('/repos/acme/infra/issues/42/comments'),
        body: fullFinal
      }
    ])
    expect(f.calls.some((call) => call.body === partial)).toBe(false)
  })

  it('replies inline to the trusted root of a PR review thread', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched, {
      attribution,
      reviewThreadRootCommentId: '3565283658'
    })

    await poster.publish('Paths must stay in the archive directory.')

    expect(f.calls).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/infra/pulls/42/comments/3565283658/replies',
        body:
          'Paths must stay in the archive directory.\n\n<sub>sent by ' +
          '[review-bot](<https://app.example.test/acme/agents/review-bot>) (Codex · gpt-5.6-luna) · ' +
          '[open in session](<https://app.example.test/acme/sessions/session-1>)\n</sub>'
      }
    ])
  })

  it('omits an unsafe session link without leaving dangling separator chrome', () => {
    expect(githubAttributionFooter({ ...attribution, sessionUrl: 'file:///tmp/session-1' })).toBe(
      '\n\n<sub>sent by [review-bot](<https://app.example.test/acme/agents/review-bot>) ' +
        '(Codex · gpt-5.6-luna)\n</sub>'
    )
  })

  it('renders the agent avatar inline ahead of the agent name when attribution carries an icon URL', () => {
    const iconUrl = 'https://api.example.test/v1/agents/agent-1/icon?v=1700000000000'
    expect(githubAttributionFooter({ ...attribution, iconUrl })).toBe(
      `\n\n<sub>sent by <sub><img src="${iconUrl}" width="11" height="11" alt=""></sub> ` +
        '[review-bot](<https://app.example.test/acme/agents/review-bot>) (Codex · gpt-5.6-luna) · ' +
        '[open in session](<https://app.example.test/acme/sessions/session-1>)\n</sub>'
    )
  })

  it('drops a non-http icon URL and keeps the text-only footer', () => {
    for (const iconUrl of ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'not a url', '']) {
      expect(githubAttributionFooter({ ...attribution, iconUrl })).toBe(
        '\n\n<sub>sent by [review-bot](<https://app.example.test/acme/agents/review-bot>) ' +
          '(Codex · gpt-5.6-luna) · ' +
          '[open in session](<https://app.example.test/acme/sessions/session-1>)\n</sub>'
      )
    }
  })

  it('returns the exact comment identity without rounding a large GitHub id', async () => {
    const clock = fakeScheduler()
    const fetchImpl = vi.fn(async () => new Response('{"id":90071992547409931}', { status: 201 }))
    const poster = make(fetchImpl as typeof fetch, clock.sched)

    await expect(poster.publish('Final answer.')).resolves.toEqual({
      kind: 'issue_comment',
      commentId: '90071992547409931'
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('adds agent attribution and the session deep link to the completed body', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched, { attribution })

    await poster.publish('Answer')

    expect(f.calls[0]!.body).toBe(
      'Answer\n\n<sub>sent by [review-bot](<https://app.example.test/acme/agents/review-bot>) ' +
        '(Codex · gpt-5.6-luna) · [open in session](<https://app.example.test/acme/sessions/session-1>)\n</sub>'
    )
    expect(f.calls[0]!.body.match(/open in session/g)).toHaveLength(1)
  })

  it('resolves attribution at publish time so the final session model is shown', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    let model = 'default'
    const attributionSource = vi.fn(() => ({ ...attribution, model }))
    const poster = make(f.fetchImpl, clock.sched, { attribution: attributionSource })

    model = 'gpt-5.6-luna'
    await poster.publish('Answer')

    expect(attributionSource).toHaveBeenCalledTimes(1)
    expect(f.calls[0]!.body).toContain('(Codex · gpt-5.6-luna)')
  })

  it('reserves truncation budget for both the marker and attribution footer', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched, { attribution })

    await poster.publish('x'.repeat(70_000))

    const body = f.calls[0]!.body
    expect(body).toHaveLength(60_000)
    expect(body).toContain('_(truncated — see the session transcript for the full reply)_')
    expect(
      body.endsWith(
        '<sub>sent by [review-bot](<https://app.example.test/acme/agents/review-bot>) ' +
          '(Codex · gpt-5.6-luna) · ' +
          '[open in session](<https://app.example.test/acme/sessions/session-1>)\n</sub>'
      )
    ).toBe(true)
  })

  it.each([String.fromCharCode(96).repeat(3), '~~~'])(
    'closes an open %s fence before truncation chrome without splitting a surrogate pair',
    async (fence) => {
      const clock = fakeScheduler()
      const f = fakeFetch()
      const poster = make(f.fetchImpl, clock.sched, { attribution })
      const marker = '_(truncated — see the session transcript for the full reply)_'

      // The single x makes a naive UTF-16 slice land halfway through one repeated emoji.
      await poster.publish(fence + '\nx' + '😀'.repeat(40_000))

      const body = f.calls[0]!.body
      const markerAt = body.indexOf(marker)
      const beforeMarker = body.slice(0, markerAt)
      expect(body.length).toBeLessThanOrEqual(60_000)
      expect(markerAt).toBeGreaterThan(0)
      expect(beforeMarker.trimEnd().endsWith(fence)).toBe(true)
      expect(body.split(fence)).toHaveLength(3) // one opener + one synthetic closer
      expect(hasUnpairedSurrogate(body)).toBe(false)
      expect(body.indexOf('open in session')).toBeGreaterThan(markerAt)
    }
  )

  it('closes an untruncated fence before the attribution footer', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched, { attribution })
    const fence = String.fromCharCode(96).repeat(3)

    await poster.publish(fence + 'ts\nconst answer = 42')

    expect(f.calls[0]!.body).toContain('const answer = 42\n' + fence + '\n\n<sub>sent by ')
  })

  it('degrades a non-auth create failure to one warning without rejecting or retrying', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch({ failFirst: 1 })
    const poster = make(f.fetchImpl, clock.sched)

    await expect(poster.publish('final answer')).resolves.toBeUndefined()

    expect(f.calls).toEqual([expect.objectContaining({ method: 'POST', body: 'final answer' })])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('github poster: create failed'))
  })

  it('evicts one rejected token and retries a 401/403 once with a fresh grant', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch({ failFirst: 1, failStatus: 403 })
    const token = vi.fn().mockResolvedValueOnce('ghs_read_only').mockResolvedValueOnce('ghs_comment')
    const invalidateToken = vi.fn()
    const poster = make(f.fetchImpl, clock.sched, { token, invalidateToken })

    await expect(poster.publish('final answer')).resolves.toEqual({
      kind: 'issue_comment',
      commentId: '90071992547409931'
    })

    expect(f.calls).toHaveLength(2)
    expect(token).toHaveBeenCalledTimes(2)
    expect(invalidateToken).toHaveBeenCalledWith('ghs_read_only')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('keeps an inline review reply on the same endpoint across one auth refresh', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch({ failFirst: 1, failStatus: 401 })
    const token = vi.fn().mockResolvedValueOnce('ghs_expired').mockResolvedValueOnce('ghs_refreshed')
    const invalidateToken = vi.fn()
    const poster = make(f.fetchImpl, clock.sched, {
      token,
      invalidateToken,
      reviewThreadRootCommentId: '3565283658'
    })

    await expect(poster.publish('inline final')).resolves.toEqual({
      kind: 'review_comment',
      commentId: '90071992547409931'
    })

    expect(f.calls).toEqual([
      expect.objectContaining({
        url: 'https://api.github.com/repos/acme/infra/pulls/42/comments/3565283658/replies',
        body: 'inline final'
      }),
      expect.objectContaining({
        url: 'https://api.github.com/repos/acme/infra/pulls/42/comments/3565283658/replies',
        body: 'inline final'
      })
    ])
    expect(token).toHaveBeenCalledTimes(2)
    expect(invalidateToken).toHaveBeenCalledOnce()
    expect(invalidateToken).toHaveBeenCalledWith('ghs_expired')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('still resolves when reporting a create failure through a broken logger', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch({ failFirst: 1 })
    const poster = new GithubFinalPoster(
      {
        token: async () => 'ghs_test',
        log: {
          warn: () => {
            throw new Error('logger unavailable')
          }
        },
        fetchImpl: f.fetchImpl,
        scheduler: clock.sched
      },
      'acme/infra',
      42
    )

    await expect(poster.publish('final answer')).resolves.toBeUndefined()
    expect(f.calls).toHaveLength(1)
  })

  it('fails closed without posting if the deadline scheduler cannot arm', async () => {
    const f = fakeFetch()
    const poster = new GithubFinalPoster(
      {
        token: async () => 'ghs_test',
        log,
        fetchImpl: f.fetchImpl,
        scheduler: {
          now: () => 0,
          setTimeout: () => {
            throw new Error('timer unavailable')
          },
          clearTimeout: () => {}
        }
      },
      'acme/infra',
      42
    )

    await expect(poster.publish('final answer')).resolves.toBeUndefined()
    await flush()
    expect(f.calls).toHaveLength(0)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('publish deadline failed'))
  })

  it('is idempotent: concurrent calls share one promise and the first body wins', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    const poster = make(f.fetchImpl, clock.sched)

    const first = poster.publish('first final')
    const second = poster.publish('must be ignored')
    expect(second).toBe(first)
    await first

    expect(f.calls).toEqual([expect.objectContaining({ method: 'POST', body: 'first final' })])
  })

  it('bounds token acquisition and never posts if the token arrives after the deadline', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    let resolveToken!: (token: string) => void
    const token = new Promise<string>((resolve) => (resolveToken = resolve))
    const poster = make(f.fetchImpl, clock.sched, {
      finalizeTimeoutMs: 50,
      token: () => token
    })

    const published = poster.publish('final answer')
    await Promise.resolve()
    clock.advance(49)
    let settled = false
    void published.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    clock.advance(1)
    await published
    resolveToken('ghs_late')
    await flush()

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('final publish timed out'))
    expect(f.calls).toHaveLength(0)
  })

  it('blocks a late token even when the overdue timer callback has not run yet', async () => {
    const clock = fakeScheduler()
    const f = fakeFetch()
    let resolveToken!: (token: string) => void
    const token = new Promise<string>((resolve) => (resolveToken = resolve))
    const poster = make(f.fetchImpl, clock.sched, {
      finalizeTimeoutMs: 50,
      token: () => token
    })

    const published = poster.publish('final answer')
    await Promise.resolve()
    clock.elapse(50) // Simulate a busy event loop: wall clock moves, timer callback does not.
    resolveToken('ghs_late')
    await published

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('final publish timed out'))
    expect(f.calls).toHaveLength(0)
  })

  it('aborts an in-flight fetch at the publish deadline and resolves the barrier', async () => {
    const clock = fakeScheduler()
    const f = hangingFetch()
    const poster = make(f.fetchImpl, clock.sched, { finalizeTimeoutMs: 50 })

    const published = poster.publish('final answer')
    await flush()
    expect(f.calls).toHaveLength(1)
    expect(f.signal?.aborted).toBe(false)

    clock.advance(50)
    await published

    expect(f.aborted).toBe(true)
    expect(f.signal?.aborted).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('final publish timed out'))
  })
})
