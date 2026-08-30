import { describe, it, expect } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { SHARED_CONFIG_ACTION_ID, SLACK_STATUS_ACTION, decodeSlackStatusOverflowValue } from '@agentconnect.md/protocol'
import {
  OutputConverger,
  renderStatusBar,
  buildStatusBlocks,
  buildStatusModal,
  buildPermissionCard,
  buildPermissionResolvedCard,
  buildPermissionUpdateCard,
  buildElicitationCard,
  buildElicitationResolvedCard,
  buildAttributionBlocks,
  elicitTarget,
  encodePermValue,
  decodePermValue,
  PERMISSION_ACTION_PREFIX,
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  type SlackAction,
  type SlackAttributionInfo
} from '../src/slack/render.js'

const setStatuses = (actions: SlackAction[]) => actions.filter((a) => a.kind === 'set-status')
const attribution = (): SlackAttributionInfo => ({
  botName: 'Deploy Bot',
  botUrl: 'https://app.example.test/acme/agents/deploy-bot',
  runtime: 'Claude Code',
  model: 'claude-sonnet-4-5',
  sessionUrl: 'https://app.example.test/acme/sessions/session-123'
})

describe('OutputConverger', () => {
  it('never splits a compound shared-bot address the daemon supplied', () => {
    // send-message-routing-rework.md §5.3/§8.5. `<@U09SHARED> reviewer` is ONE address:
    // the bot user id names the app, the slug selects the agent. The splitter finds
    // self-delimiting `<…>` tokens by itself but cannot know the trailing word belongs to
    // this one, so the daemon passes the addresses it rendered from its own directory.
    // Splitting between the halves addresses the APP, which under §2.1 drops the delivery
    // the mention was making rather than merely rendering oddly.
    const address = '<@U09SHARED> reviewer'
    // Place the 12000-char hard cut inside the SLUG, past the end of `<@U09SHARED>`. The
    // generic `<…>` protection cannot help there — only the caller-supplied compound
    // address can — so this offset is what makes the test exercise the plumbing rather
    // than the protection the splitter already had.
    const filler = 'x'.repeat(12_000 - 16)
    const c2 = new OutputConverger('medium', [address])
    c2.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${filler}${address} please verify` }
    } as any)
    const posts = c2.onFinal(undefined as never).filter((a) => a.kind === 'post') as { text: string }[]
    expect(posts.length).toBeGreaterThan(1)
    expect(posts.map((p) => p.text).join('')).toBe(`${filler}${address} please verify`)
    // The address opens the following section whole rather than straddling the cut.
    expect(posts.some((p) => p.text.startsWith(address))).toBe(true)
  })

  it('buffers agent text chunks and flushes them as a single post', () => {
    const c = new OutputConverger('medium')
    expect(
      c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } as any)
    ).toEqual([])
    expect(
      c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } as any)
    ).toEqual([])
    const actions = c.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      status: 'pending'
    } as any)
    expect(actions[0]).toEqual({ kind: 'post', text: 'Hello world' })
    expect(actions.some((a) => a.kind === 'progress')).toBe(true)
  })

  it('low mode: tool_call flushes buffered text then emits a working set-status', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } as any)
    const actions = c.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      status: 'pending'
    } as any)
    expect(actions).toEqual([
      { kind: 'post', text: 'partial' },
      { kind: 'set-status', text: 'Read file' }
    ])
  })

  // A runtime links the file it wrote by its absolute path, which is clickable in its own UI and
  // nowhere else. Slack turns the destination into a real `<target|label>` link, so the daemon's
  // filesystem layout becomes the link target of a message in a shared channel.
  it('flattens a host path a runtime linked, even when the link straddles chunk boundaries', () => {
    const c = new OutputConverger('low')
    // The split is the point: ACP delivers a reply as token deltas, so a per-chunk rewrite misses.
    for (const chunk of ['Created [today’s dig', 'est](/home/sentio/agents/x/workspace/o', 'ut.md).']) {
      c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } as any)
    }
    expect(c.onFinal()).toEqual([
      { kind: 'post', text: 'Created today’s digest (`out.md`).', terminal: true },
      { kind: 'set-status', text: '' }
    ])
  })

  it('leaves a web link a runtime wrote exactly as it wrote it', () => {
    const c = new OutputConverger('low')
    const text = 'see [the PR](https://github.com/acme/repo/pull/1)'
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as any)
    expect(c.onFinal().find((a) => a.kind === 'post')?.text).toBe(text)
  })

  // The shape this exists for: a run that speaks three times with NO tool call between, so none of
  // the boundaries the converger already flushes on (tool, thought, plan) is there to separate them.
  describe('a run that speaks more than once', () => {
    const posts = (c: OutputConverger, runs: Array<[string | undefined, string]>): string[] => {
      const out: string[] = []
      const take = (actions: SlackAction[]): void => {
        for (const a of actions) if (a.kind === 'post') out.push(a.text)
      }
      for (const [messageId, text] of runs) {
        take(
          c.onUpdate({
            sessionUpdate: 'agent_message_chunk',
            ...(messageId ? { messageId } : {}),
            content: { type: 'text', text }
          } as any)
        )
      }
      take(c.onFinal())
      return out
    }

    it('delivers each named message on its own instead of running them together', () => {
      expect(
        posts(new OutputConverger('low'), [
          ['m1', 'I’ll run the collector.'],
          ['m2', 'It returned 46 candidates.'],
          ['m3', 'Created the digest.']
        ])
      ).toEqual(['I’ll run the collector.', 'It returned 46 candidates.', 'Created the digest.'])
    })

    // The damage beyond the run-on sentence: a `#` swallowed into the previous paragraph stops
    // being a heading at all, which is how a digest lost its title.
    it('leaves a heading at the START of its own message, where it still parses as one', () => {
      const out = posts(new OutputConverger('low'), [
        ['m1', 'so the drafts stay non-promotional.'],
        ['m2', '# Reddit Engagement Digest\n\nThese are drafts.']
      ])
      expect(out[0]).toBe('so the drafts stay non-promotional.')
      expect(out[1]?.startsWith('# Reddit Engagement Digest')).toBe(true)
    })

    it('joins the chunks of ONE message, however many arrive', () => {
      expect(
        posts(new OutputConverger('low'), [
          ['m1', 'Hello '],
          ['m1', 'there '],
          ['m1', 'friend.']
        ])
      ).toEqual(['Hello there friend.'])
    })

    // §323: a reply that merely streams in pieces is one message. A runtime naming nothing keeps
    // exactly the old behavior — this pass must never be what splits a reply mid-sentence.
    it('still delivers an unnamed run as one message', () => {
      expect(
        posts(new OutputConverger('low'), [
          [undefined, 'Hello '],
          [undefined, 'there '],
          [undefined, 'friend.']
        ])
      ).toEqual(['Hello there friend.'])
    })
  })

  it('low mode: tool_call with no title falls back to the toolCallId', () => {
    const c = new OutputConverger('low')
    const actions = c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't9', status: 'pending' } as any)
    expect(actions).toEqual([{ kind: 'set-status', text: 't9' }])
  })

  it('low mode: agent_thought_chunk emits a thinking set-status', () => {
    const c = new OutputConverger('low')
    expect(c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as any)).toEqual(
      [{ kind: 'set-status', text: 'is thinking…' }]
    )
  })

  it('low mode: agent_thought_chunk flushes buffered text before the thinking status', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } as any)
    const actions = c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as any)
    expect(actions).toEqual([
      { kind: 'post', text: 'partial' },
      { kind: 'set-status', text: 'is thinking…' }
    ])
  })

  it('low mode: tool_call_update emits set-status with the title (shares the tool_call branch)', () => {
    const c = new OutputConverger('low')
    const actions = c.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      title: 'Edit file',
      status: 'in_progress'
    } as any)
    expect(actions).toEqual([{ kind: 'set-status', text: 'Edit file' }])
  })

  it('a changed activity label refires the working status (the connection dedupes the rest)', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reading the thread', status: 'pending' } as any)
    c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as any)
    const actions = c.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Querying metrics',
      status: 'pending'
    } as any)
    expect(actions).toEqual([{ kind: 'set-status', text: 'Querying metrics' }])
  })

  it('collapses consecutive thought chunks to a single status update', () => {
    const c = new OutputConverger('medium')
    const first = c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } } as any)
    const second = c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } } as any)
    expect(first).toEqual([{ kind: 'set-status', text: 'is thinking…' }])
    expect(second).toEqual([])
  })

  it('a title-less tool_call_update reuses the tool title and is collapsed (no raw id surfaced)', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run grep', status: 'pending' } as any)
    const upd = c.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } as any)
    expect(upd).toEqual([]) // same label → collapsed, raw 't1' never shown
  })

  it('none mode: buffered text flushes as recordOnly posts and no channel chrome is emitted', () => {
    const c = new OutputConverger('none')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'session only' } } as any)
    // a tool boundary records the reply so far but never surfaces status / a tool card
    expect(
      c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'pending' } as any)
    ).toEqual([{ kind: 'post', text: 'session only', recordOnly: true }])
    // reasoning and plans stay out of the channel entirely (no status, no plan)
    expect(c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as any)).toEqual(
      []
    )
    expect(c.onUpdate({ sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending' }] } as any)).toEqual([])
  })

  it('none mode: onFinal records the final reply (recordOnly) with no status clear or attribution', () => {
    const c = new OutputConverger('none')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final answer' } } as any)
    expect(
      c.onFinal({
        botName: 'bot',
        botUrl: 'https://example.com/bot',
        runtime: 'claude',
        model: 'opus',
        sessionUrl: 'https://example.com/s'
      })
    ).toEqual([{ kind: 'post', text: 'final answer', recordOnly: true }])
  })

  it('none mode: an AC_NO_RESPONSE turn records nothing', () => {
    const c = new OutputConverger('none')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AC_NO_RESPONSE' } } as any)
    expect(c.onFinal()).toEqual([{ kind: 'set-status', text: '' }])
  })

  it('clamps an over-long activity label (the text only ever signals working)', () => {
    const c = new OutputConverger('low')
    const long = 'x'.repeat(250)
    const actions = c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: long, status: 'pending' } as any)
    const status = setStatuses(actions)[0] as { text: string }
    expect(status.text.length).toBeLessThanOrEqual(50)
    expect(status.text.endsWith('…')).toBe(true)
  })

  it('medium mode wraps the progress tool label in a code span so it renders verbatim', () => {
    const med = new OutputConverger('medium')
    const actions = med.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'git commit -m "fix: *thing*"',
      status: 'pending'
    } as any)
    const progress = actions.find((a) => a.kind === 'progress') as { text: string }
    expect(progress.text).toBe(':hammer_and_wrench: `git commit -m "fix: *thing*"`')
  })

  it('grows the code-span delimiter past internal backticks so labels stay intact', () => {
    const med = new OutputConverger('medium')
    const actions = med.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'echo `date`',
      status: 'pending'
    } as any)
    const progress = actions.find((a) => a.kind === 'progress') as { text: string }
    // two-backtick delimiter (one longer than the internal run) wraps the whole label;
    // symmetric padding keeps the delimiters unambiguous next to the trailing backtick.
    expect(progress.text).toBe(':hammer_and_wrench: `` echo `date` ``')
  })

  it('medium mode surfaces a thinking status (ephemeral) but posts nothing to the channel', () => {
    const med = new OutputConverger('medium')
    const actions = med.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } } as any)
    expect(actions).toEqual([{ kind: 'set-status', text: 'is thinking…' }])
    // no durable/in-place channel message — a thought is status-only in medium.
    const channelKinds = ['post', 'progress', 'reasoning', 'plan', 'notice']
    expect(actions.some((a) => channelKinds.includes(a.kind))).toBe(false)
  })

  it('high mode: a thought chunk surfaces only the status; reasoning is deferred to the idle flush', () => {
    const hi = new OutputConverger('high')
    const actions = hi.onUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'weighing options' }
    } as any)
    // nothing hits the channel yet — just the ephemeral status; no per-chunk progress edit.
    expect(actions).toEqual([{ kind: 'set-status', text: 'is thinking…' }])
    expect(actions.some((a) => a.kind === 'progress' || a.kind === 'reasoning')).toBe(false)
    // the idle flush emits the in-place reasoning block carrying the accumulated thought.
    expect(hi.hasBuffered()).toBe(true)
    const flushed = hi.flushBuffered()
    const reasoning = flushed.find((a) => a.kind === 'reasoning') as { text: string } | undefined
    expect(reasoning).toBeDefined()
    expect(reasoning!.text).toContain('weighing options')
    // drained — a second flush with no new thinking emits nothing (no update storm).
    expect(hi.hasBuffered()).toBe(false)
    expect(hi.flushBuffered()).toEqual([])
  })

  it('high mode: consecutive thought chunks accumulate into one reasoning block', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'first ' } } as any)
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'second' } } as any)
    const [reasoning] = hi.flushBuffered()
    expect(reasoning!.kind).toBe('reasoning')
    expect((reasoning as { text: string }).text).toContain('first second')
  })

  it('high mode: reasoning and tool progress are distinct messages, never the same one', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } as any)
    const reasoning = hi.flushBuffered().find((a) => a.kind === 'reasoning')
    const toolActions = hi.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      status: 'pending'
    } as any)
    expect(reasoning).toBeDefined()
    // tools still drive the `progress` message; they never emit `reasoning`.
    expect(toolActions.some((a) => a.kind === 'progress')).toBe(true)
    expect(toolActions.some((a) => a.kind === 'reasoning')).toBe(false)
  })

  it('high mode: posts a finished tool output as a code block, exactly once at terminal status', () => {
    const hi = new OutputConverger('high')
    // pending: progress only, no output yet.
    const pending = hi.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run tests',
      status: 'pending'
    } as any)
    expect(pending.some((a) => a.kind === 'tool-output')).toBe(false)
    // completed: the content[] text block is surfaced as a fenced code block.
    const done = hi.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok: 5 passed' } }]
    } as any)
    const out = done.find((a) => a.kind === 'tool-output') as { text: string }
    expect(out).toBeDefined()
    expect(out.text).toBe(':page_facing_up:\n```\nok: 5 passed\n```')
    // a redundant repeat of the terminal update does not re-post the output.
    const again = hi.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok: 5 passed' } }]
    } as any)
    expect(again.some((a) => a.kind === 'tool-output')).toBe(false)
  })

  it('high mode: a failed tool marks its output with :x: and falls back to string rawOutput', () => {
    const hi = new OutputConverger('high')
    const done = hi.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'failed',
      rawOutput: 'boom: exit 1'
    } as any)
    const out = done.find((a) => a.kind === 'tool-output') as { text: string }
    expect(out.text).toBe(':x:\n```\nboom: exit 1\n```')
  })

  it('high mode: a later update that replaces content with an empty value clears stale output', () => {
    const hi = new OutputConverger('high')
    // in_progress carries some output…
    hi.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'stale partial' } }]
    } as any)
    // …then the terminal update replaces content with an empty collection — nothing to post.
    const done = hi.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: []
    } as any)
    expect(done.some((a) => a.kind === 'tool-output')).toBe(false)
  })

  it('medium mode: never posts tool output (progress label only)', () => {
    const med = new OutputConverger('medium')
    const done = med.onUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'result' } }]
    } as any)
    expect(done.some((a) => a.kind === 'tool-output')).toBe(false)
    expect(done.some((a) => a.kind === 'progress')).toBe(true)
  })

  it('high mode: onFinal drains reasoning buffered since the last flush (idle timer was cancelled)', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'last thought' } } as any)
    const actions = hi.onFinal()
    const reasoning = actions.find((a) => a.kind === 'reasoning') as { text: string } | undefined
    expect(reasoning).toBeDefined()
    expect(reasoning!.text).toContain('last thought')
    // status still cleared; the old "done — details" notice was removed.
    expect(actions.some((a) => a.kind === 'set-status' && a.text === '')).toBe(true)
    expect(actions.some((a) => a.kind === 'notice' && a.text.includes('details'))).toBe(false)
  })

  it('high mode: an idle flush emits reasoning before the body so Thinking posts above the reply', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing options' } } as any)
    hi.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is the answer.\n\n' }
    } as any)
    const actions = hi.flushBuffered()
    const rIdx = actions.findIndex((a) => a.kind === 'reasoning')
    const pIdx = actions.findIndex((a) => a.kind === 'post')
    expect(rIdx).toBeGreaterThanOrEqual(0)
    expect(pIdx).toBeGreaterThanOrEqual(0)
    expect(rIdx).toBeLessThan(pIdx)
  })

  it('high mode: onFinal emits reasoning before the flushed body so Thinking posts above the reply', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing options' } } as any)
    hi.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the answer.' } } as any)
    const actions = hi.onFinal(undefined)
    const rIdx = actions.findIndex((a) => a.kind === 'reasoning')
    const pIdx = actions.findIndex((a) => a.kind === 'post')
    expect(rIdx).toBeGreaterThanOrEqual(0)
    expect(pIdx).toBeGreaterThanOrEqual(0)
    expect(rIdx).toBeLessThan(pIdx)
  })

  it('high mode: onFinal emits no reasoning when the last thought was already flushed', () => {
    const hi = new OutputConverger('high')
    hi.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } } as any)
    hi.flushBuffered() // drains reasoning
    expect(hi.onFinal(undefined).some((a) => a.kind === 'reasoning')).toBe(false)
  })

  it('medium mode: thoughts never buffer or emit reasoning (reasoning is high-only)', () => {
    const med = new OutputConverger('medium')
    med.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden' } } as any)
    expect(med.hasBuffered()).toBe(false)
    expect(med.flushBuffered()).toEqual([])
    expect(med.onFinal(undefined).some((a) => a.kind === 'reasoning')).toBe(false)
  })

  it('drops usage_update entirely', () => {
    const c = new OutputConverger('high')
    expect(c.onUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100 } as any)).toEqual([])
  })

  it('drops session_info_update entirely (title goes to the store, not the channel)', () => {
    const c = new OutputConverger('high')
    expect(c.onUpdate({ sessionUpdate: 'session_info_update', title: 'Fix the deploy' } as any)).toEqual([])
  })

  it('low mode onFinal flushes the result then clears the status (no detail link)', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } as any)
    const actions = c.onFinal()
    expect(actions).toEqual([
      // Posted at finalization with the complete answer known ⇒ marked as the
      // response's terminal section so the applier can close it at post time (§5.5).
      { kind: 'post', text: 'done.', terminal: true },
      { kind: 'set-status', text: '' }
    ])
  })

  it('medium mode onFinal flushes remaining text and clears the status (no detail-link footer)', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } as any)
    const actions = c.onFinal()
    expect(actions.some((a) => a.kind === 'set-status' && a.text === '')).toBe(true)
    expect(actions.map((a) => (a as { text?: string }).text).join('\n')).toContain('done.')
    // The old "done — details" link footer was removed.
    expect(actions.map((a) => (a as { text?: string }).text).join('\n')).not.toContain('https://app/session/123')
  })

  it('medium mode onFinal omits the footer entirely when no link is configured', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } as any)
    const actions = c.onFinal(undefined)
    expect(actions).toEqual([
      { kind: 'post', text: 'done.', terminal: true },
      { kind: 'set-status', text: '' }
    ])
    expect(actions.some((a) => (a as { text: string }).text.includes('details'))).toBe(false)
  })

  it('onFinal appends bot, runtime, model, and session links in a compact context footer', () => {
    for (const mode of ['low', 'medium', 'high'] as const) {
      const c = new OutputConverger(mode)
      c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } as any)
      const actions = c.onFinal(attribution())
      const last = actions.at(-1)!
      expect(last.kind).toBe('attribution')
      expect((last as { text: string }).text).toBe(
        'sent by Deploy Bot (Claude Code · claude-sonnet-4-5) · open in session'
      )
      expect((last as any).blocks).toEqual([
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'sent by <https://app.example.test/acme/agents/deploy-bot|Deploy Bot> (Claude Code · claude-sonnet-4-5) · <https://app.example.test/acme/sessions/session-123|open in session>'
            }
          ]
        }
      ])
      expect(JSON.stringify((last as any).blocks)).not.toContain(SHARED_CONFIG_ACTION_ID)
    }
  })

  it('onFinal omits the attribution when no metadata is provided', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } as any)
    expect(c.onFinal().some((a) => a.kind === 'attribution')).toBe(false)
  })

  it('keeps Slack fallback text literal while escaping each rendered mrkdwn label', () => {
    const rendered = buildAttributionBlocks({
      ...attribution(),
      botName: 'Deploy & <Ops>|',
      runtime: 'Claude & <Code>',
      model: 'sonnet|5'
    })

    expect(rendered.text).toBe('sent by Deploy & <Ops>| (Claude & <Code> · sonnet|5) · open in session')
    expect(rendered.blocks).toEqual([
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              'sent by <https://app.example.test/acme/agents/deploy-bot|Deploy &amp; &lt;Ops&gt;¦> ' +
              '(Claude &amp; &lt;Code&gt; · sonnet¦5) · ' +
              '<https://app.example.test/acme/sessions/session-123|open in session>'
          }
        ]
      }
    ])
  })

  it.each([
    ['a non-HTTP scheme', 'javascript:alert(1)'],
    ['a pipe delimiter', 'https://app.example.test/acme/agents/deploy-bot|spoof'],
    ['a closing delimiter', 'https://app.example.test/acme/agents/deploy-bot>spoof']
  ])('renders the escaped bot name without a link for %s', (_case, botUrl) => {
    const rendered = buildAttributionBlocks({ ...attribution(), botName: 'Deploy & <Ops>|', botUrl })

    expect(rendered.text).toBe('sent by Deploy & <Ops>| (Claude Code · claude-sonnet-4-5) · open in session')
    expect(rendered.blocks).toEqual([
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              'sent by Deploy &amp; &lt;Ops&gt;¦ (Claude Code · claude-sonnet-4-5) · ' +
              '<https://app.example.test/acme/sessions/session-123|open in session>'
          }
        ]
      }
    ])
  })

  it.each([
    ['a non-HTTP scheme', 'javascript:alert(1)'],
    ['a pipe delimiter', 'https://app.example.test/acme/sessions/session-123|spoof'],
    ['a closing delimiter', 'https://app.example.test/acme/sessions/session-123>spoof']
  ])('omits the session link and separator for %s', (_case, sessionUrl) => {
    const rendered = buildAttributionBlocks({ ...attribution(), sessionUrl })

    expect(rendered.text).toBe('sent by Deploy Bot (Claude Code · claude-sonnet-4-5)')
    expect(rendered.blocks).toEqual([
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              'sent by <https://app.example.test/acme/agents/deploy-bot|Deploy Bot> ' +
              '(Claude Code · claude-sonnet-4-5)'
          }
        ]
      }
    ])
  })

  it('hasBuffered tracks the body buffer; flushBuffered drains it for the idle timer', () => {
    const c = new OutputConverger('medium')
    expect(c.hasBuffered()).toBe(false)
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'streaming…\n\n' } } as any)
    expect(c.hasBuffered()).toBe(true)
    expect(c.flushBuffered()).toEqual([{ kind: 'post', text: 'streaming…\n\n' }])
    expect(c.hasBuffered()).toBe(false)
    expect(c.flushBuffered()).toEqual([]) // nothing left
  })

  it('idle-flushes only through the last paragraph break so a reply is never cut mid-sentence', () => {
    const c = new OutputConverger('medium')
    const chunk = (text: string) =>
      c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as any)
    // ACP text deltas are token-sized, so a pause in the stream can leave the buffer mid-word.
    chunk('The pinned tag is nine commits stale.\n\nSo I am rebuilding the depend')
    expect(c.flushBuffered()).toEqual([{ kind: 'post', text: 'The pinned tag is nine commits stale.\n\n' }])
    // The held tail keeps streaming and settles as one message at turn end.
    chunk('ency graph before building.')
    expect(c.onFinal(undefined)).toContainEqual({
      kind: 'post',
      text: 'So I am rebuilding the dependency graph before building.',
      terminal: true
    })
  })

  it('idle-flushes nothing while the buffer holds no paragraph break yet', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one long line so f' } } as any)
    expect(c.flushBuffered()).toEqual([])
    expect(c.hasBuffered()).toBe(true) // still buffered, not dropped
  })

  it('flushTerminal drains a body with no paragraph break — the turn never reaches onFinal', () => {
    const c = new OutputConverger('medium')
    // A runtime that narrates its terminal error then rejects the prompt: one line, no break.
    c.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: "You've hit your usage limit." }
    } as any)
    expect(c.flushTerminal()).toEqual([{ kind: 'post', text: "You've hit your usage limit." }])
    expect(c.hasBuffered()).toBe(false)
  })

  it('flushTerminal drains the held tail too, not just the completed paragraph', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Quota exceeded.\n\nRetry after the reset at' }
    } as any)
    expect(c.flushTerminal()).toEqual([{ kind: 'post', text: 'Quota exceeded.\n\nRetry after the reset at' }])
    expect(c.hasBuffered()).toBe(false)
  })

  it('a tool boundary still drains the whole buffer — the model finished that text block', () => {
    const c = new OutputConverger('low')
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me check.' } } as any)
    const actions = c.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read',
      status: 'pending'
    } as any)
    expect(actions[0]).toEqual({ kind: 'post', text: 'Let me check.' })
  })

  it('posts the agent markdown verbatim when flushing body text (no mrkdwn conversion)', () => {
    const c = new OutputConverger('medium')
    c.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'see **bold** and [docs](https://x.io)\n\n' }
    } as any)
    const [post] = c.flushBuffered()
    expect(post).toEqual({ kind: 'post', text: 'see **bold** and [docs](https://x.io)\n\n' })
  })

  it('splits an over-long body into multiple ≤block-limit post sections', () => {
    const c = new OutputConverger('medium')
    const big = `${'a'.repeat(9000)}\n${'b'.repeat(9000)}\n\n`
    c.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: big } } as any)
    const posts = c.flushBuffered()
    expect(posts.length).toBe(2)
    expect(posts.every((p) => p.kind === 'post' && p.text.length <= 12000)).toBe(true)
  })

  /** The list items inside a plan action's rich_text block. */
  type PlanItem = { type: string; text: string; style?: { strike?: boolean; bold?: boolean } }
  const planItems = (plan: { blocks: unknown[] }): PlanItem[] => {
    const rich = plan.blocks.find((b) => (b as { type: string }).type === 'rich_text') as {
      elements: [{ elements: { elements: PlanItem[] }[] }]
    }
    return rich.elements[0].elements.map((section) => section.elements[0]!)
  }

  it('renders a plan as a bulleted list — done struck through, the entry in flight bolded', () => {
    const c = new OutputConverger('medium')
    const actions = c.onUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'gather context', status: 'completed' },
        { content: 'write code', status: 'in_progress' },
        { content: 'run tests', status: 'pending' }
      ]
    } as any)
    const plan = actions.find((a) => a.kind === 'plan') as { text: string; blocks: unknown[] } | undefined
    expect(plan).toBeDefined()
    // `text` is the notification/fallback only — the blocks carry the display.
    expect(plan!.text).toBe('Plan · 1/3')
    // Ruled off top and bottom so the plan reads as its own artifact, not as thread chrome.
    expect(plan!.blocks[0]).toEqual({ type: 'divider' })
    expect(plan!.blocks.at(-1)).toEqual({ type: 'divider' })
    expect(plan!.blocks[1]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '*Plan* · 1/3' }]
    })
    expect(planItems(plan!)).toEqual([
      { type: 'text', text: 'gather context', style: { strike: true } },
      { type: 'text', text: 'write code', style: { bold: true } },
      { type: 'text', text: 'run tests' }
    ])
  })

  // A rich-text list has no option cap — the reason this is a list rather than Block Kit
  // `checkboxes`, which rejects (not truncates) anything past ten.
  it('carries a plan past ten entries in one list', () => {
    const c = new OutputConverger('medium')
    const entries = Array.from({ length: 24 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: i < 5 ? 'completed' : 'pending'
    }))
    const actions = c.onUpdate({ sessionUpdate: 'plan', entries } as any)
    const plan = actions.find((a) => a.kind === 'plan') as { text: string; blocks: unknown[] }
    expect(plan.text).toBe('Plan · 5/24')
    expect(planItems(plan)).toHaveLength(24)
  })

  // Editorial, not a platform limit: one runaway entry must not swallow the message.
  it('clamps an over-long entry', () => {
    const c = new OutputConverger('medium')
    const actions = c.onUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'x'.repeat(400), status: 'pending' }]
    } as any)
    const plan = actions.find((a) => a.kind === 'plan') as { blocks: unknown[] }
    expect(planItems(plan)[0]!.text.length).toBeLessThanOrEqual(150)
  })

  it('low mode surfaces plan progress on the status bar (no channel post)', () => {
    const c = new OutputConverger('low')
    const actions = c.onUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'do thing', status: 'pending' }]
    } as any)
    expect(actions.some((a) => a.kind === 'plan' || a.kind === 'post')).toBe(false)
    expect(actions.some((a) => a.kind === 'set-status')).toBe(true)
  })

  it('drops unknown update kinds (no throw, no actions)', () => {
    const c = new OutputConverger('high')
    expect(c.onUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'x' } as any)).toEqual([])
  })

  describe('AC_NO_RESPONSE suppression', () => {
    const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as any

    it('suppresses a bare AC_NO_RESPONSE reply: no post, just the status clear', () => {
      const c = new OutputConverger('medium')
      expect(c.onUpdate(chunk('AC_NO_RESPONSE'))).toEqual([])
      const finals = c.onFinal(attribution())
      expect(finals.some((a) => a.kind === 'post')).toBe(false)
      expect(finals.some((a) => a.kind === 'attribution')).toBe(false)
      expect(finals).toEqual([{ kind: 'set-status', text: '' }])
    })

    it('holds the sentinel while it streams token-by-token (no partial leak on flush)', () => {
      const c = new OutputConverger('medium')
      c.onUpdate(chunk('AC_NO_'))
      c.onUpdate(chunk('RESP'))
      // a tool_call would normally flush buffered body — but the buffer is still a viable
      // sentinel prefix, so nothing is posted.
      const mid = c.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' } as any)
      expect(mid.some((a) => a.kind === 'post')).toBe(false)
      c.onUpdate(chunk('ONSE'))
      expect(c.onFinal(attribution()).some((a) => a.kind === 'post')).toBe(false)
    })

    it('suppresses a sentinel wrapped in surrounding whitespace/newlines', () => {
      const c = new OutputConverger('low')
      c.onUpdate(chunk('  AC_NO_RESPONSE\n'))
      expect(c.onFinal().some((a) => a.kind === 'post')).toBe(false)
    })

    it('posts a normal reply that merely starts with "NO" and then diverges', () => {
      const c = new OutputConverger('medium')
      c.onUpdate(chunk('NO'))
      c.onUpdate(chunk(' problem, on it!'))
      const finals = c.onFinal(attribution())
      const posts = finals.filter((a) => a.kind === 'post') as Array<{ text: string }>
      expect(posts.map((p) => p.text).join('')).toBe('NO problem, on it!')
    })

    it('suppresses a model explanation followed by a terminal bare sentinel', () => {
      const c = new OutputConverger('medium')
      c.onUpdate(chunk('This message is addressed to another user (<@U0987654321>), not me.\n\nAC_NO_RESPONSE'))
      const finals = c.onFinal(attribution())
      expect(finals).toEqual([{ kind: 'set-status', text: '' }])
    })

    it('does NOT suppress when the sentinel is followed by more content', () => {
      const c = new OutputConverger('low')
      c.onUpdate(chunk('AC_NO_RESPONSE is the keyword you asked about'))
      const posts = c.onFinal().filter((a) => a.kind === 'post') as Array<{ text: string }>
      expect(posts.map((p) => p.text).join('')).toContain('AC_NO_RESPONSE is the keyword')
    })

    it('delivers the old generic NO_RESPONSE phrase as ordinary content', () => {
      const c = new OutputConverger('medium')
      c.onUpdate(chunk('NO_RESPONSE'))
      const posts = c.onFinal().filter((a) => a.kind === 'post') as Array<{ text: string }>
      expect(posts.map((p) => p.text).join('')).toBe('NO_RESPONSE')
    })
  })
})

describe('OutputConverger minimal mode', () => {
  const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as any
  const tool = (id: string, title: string) =>
    ({ sessionUpdate: 'tool_call', toolCallId: id, title, status: 'pending' }) as any
  const think = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }) as any

  it('collapses interstitial narration into one live-reply and records every segment', () => {
    const c = new OutputConverger('minimal')
    // A chunk on its own buffers silently — no per-token channel post.
    expect(c.onUpdate(chunk('step one '))).toEqual([])
    // A tool boundary closes the segment: generic status + the single live message + a
    // record-only transcript row (NOT a visible channel post). The concrete tool title stays
    // out of minimal-mode channel chrome.
    expect(c.onUpdate(tool('t1', 'sleep 20; gh run list'))).toEqual([
      { kind: 'set-status', text: 'is working…' },
      { kind: 'live-reply', text: 'step one ' },
      { kind: 'post', text: 'step one ', recordOnly: true }
    ])
    // The next chunk starts a fresh segment that REPLACES the previous one in the live message.
    expect(c.onUpdate(chunk('final answer'))).toEqual([])
    // The turn settles the live message, clears the status, then emits the attribution footer
    // as a STANDALONE action — the daemon attaches it to the final live-reply section since that
    // message carries no born-in footer.
    expect(c.onFinal(attribution())).toEqual([
      { kind: 'final-live-reply', text: 'final answer' },
      { kind: 'post', text: 'final answer', recordOnly: true },
      { kind: 'set-status', text: '' },
      { kind: 'attribution', standalone: true, ...buildAttributionBlocks(attribution()) }
    ])
  })

  it('omits the standalone footer when no attribution info is provided', () => {
    const c = new OutputConverger('minimal')
    c.onUpdate(chunk('answer'))
    expect(c.onFinal().some((a) => a.kind === 'attribution')).toBe(false)
  })

  it('never emits a visible (non-recordOnly) post — every reply post is transcript-only', () => {
    const c = new OutputConverger('minimal')
    const all: SlackAction[] = []
    c.onUpdate(chunk('a ')).forEach((x) => all.push(x))
    c.onUpdate(tool('t1', 'Read')).forEach((x) => all.push(x))
    c.onUpdate(chunk('b')).forEach((x) => all.push(x))
    c.onFinal().forEach((x) => all.push(x))
    const posts = all.filter((a) => a.kind === 'post') as Extract<SlackAction, { kind: 'post' }>[]
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every((p) => p.recordOnly === true)).toBe(true)
  })

  it('idle flush streams the current segment as a live-reply (no record, no clear)', () => {
    const c = new OutputConverger('minimal')
    c.onUpdate(chunk('partial repl'))
    expect(c.hasBuffered()).toBe(true)
    expect(c.flushBuffered()).toEqual([{ kind: 'live-reply', text: 'partial repl' }])
    // Still dirty — the segment isn't recorded until a boundary / onFinal.
    expect(c.hasBuffered()).toBe(true)
  })

  it('does not re-record a segment already closed by a tool boundary', () => {
    const c = new OutputConverger('minimal')
    c.onUpdate(chunk('only segment'))
    expect(c.onUpdate(tool('t1', 'Read')).filter((a) => a.kind === 'post')).toEqual([
      { kind: 'post', text: 'only segment', recordOnly: true }
    ])
    // Nothing streamed after the tool → onFinal just clears the status (no duplicate record).
    expect(c.onFinal()).toEqual([{ kind: 'set-status', text: '' }])
  })

  it('keeps the reply intact across thinking/plan — status only, no post/flush', () => {
    const c = new OutputConverger('minimal')
    c.onUpdate(chunk('working'))
    expect(c.onUpdate(think('hmm'))).toEqual([{ kind: 'set-status', text: 'is thinking…' }])
    expect(c.onUpdate({ sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending' }] } as any)).toEqual([
      { kind: 'set-status', text: 'planning…' }
    ])
    // The whole reply is still one segment, emitted once at the end.
    expect(c.onFinal()).toEqual([
      { kind: 'final-live-reply', text: 'working' },
      { kind: 'post', text: 'working', recordOnly: true },
      { kind: 'set-status', text: '' }
    ])
  })

  it('head-clamps a long segment in the live message but records it in full', () => {
    const c = new OutputConverger('minimal')
    const long = 'x'.repeat(13000) // exceeds the 12000-char Slack markdown block cap
    c.onUpdate(chunk(long))
    const fin = c.onFinal()
    const live = fin.find((a) => a.kind === 'final-live-reply') as Extract<SlackAction, { kind: 'final-live-reply' }>
    const recorded = fin.filter((a) => a.kind === 'post') as Extract<SlackAction, { kind: 'post' }>[]
    expect(live.text).toBe(long)
    // The untruncated text still reaches the transcript across the record-only posts.
    expect(recorded.map((p) => p.text).join('')).toBe(long)
    expect(recorded.every((p) => p.recordOnly === true)).toBe(true)
  })
})

describe('renderStatusBar', () => {
  it('renders model, fast, context %, tokens — effort and cost are omitted from the compact line', () => {
    expect(
      renderStatusBar({
        model: 'opus-4.8',
        effort: 'xhigh',
        fastMode: true,
        contextUsed: 120_000,
        contextSize: 200_000,
        totalTokens: 45_200,
        costAmount: 0.18,
        costCurrency: 'USD'
      })
    ).toBe(':bar_chart: *opus-4.8* · fast · ctx 120k/200k (60%) · 45k tok')
  })

  it('drops unknown fields — a model-only snapshot stays clean', () => {
    expect(renderStatusBar({ model: 'sonnet-5' })).toBe(':bar_chart: *sonnet-5*')
  })

  it('omits fast when off and shows context without size as a bare used count', () => {
    expect(renderStatusBar({ model: 'x', fastMode: false, contextUsed: 5_000 })).toBe(':bar_chart: *x* · ctx 5.0k')
  })

  it('degrades an empty snapshot to a placeholder', () => {
    expect(renderStatusBar({})).toBe(':bar_chart: —')
  })

  it('keeps effort and cost OFF the compact line (they live in the Configure modal)', () => {
    expect(renderStatusBar({ effort: 'xhigh', costAmount: 2.5, costCurrency: 'EUR' })).toBe(':bar_chart: —')
  })
})

describe('buildStatusBlocks (compact in-thread line)', () => {
  const KEY = 'slack:C1:T1:bot-a'

  it('keeps the dedicated status and View Session on one row with a compact overflow', () => {
    const [section, ...rest] = buildStatusBlocks(
      { model: 'opus-4.8', models: ['opus-4.8', 'sonnet-5'], contextUsed: 120_000, contextSize: 200_000 },
      KEY,
      'https://app/sessions/acp-1'
    ) as any[]
    expect(rest).toHaveLength(0)
    expect(section.type).toBe('section')
    expect(section.text.text).toContain('opus-4.8') // model shown inline on the line
    expect(section.text.text).toContain('<https://app/sessions/acp-1|View Session>')
    expect(section).toMatchObject({
      block_id: KEY,
      accessory: { type: 'overflow', action_id: SLACK_STATUS_ACTION.more }
    })
    expect(section.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)).toEqual([
      'manage'
    ])
  })

  it('omits the View Session link when no link is provided', () => {
    const [section] = buildStatusBlocks({ model: 'x' }, KEY) as any[]
    expect(section.text.text).not.toContain('View Session')
    expect(section.accessory.action_id).toBe(SLACK_STATUS_ACTION.more)
    expect(section.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)).toEqual([
      'manage'
    ])
  })

  it('keeps shareable and dedicated status text identical while adding Switch agent', () => {
    const agentId = '11111111-1111-4111-8111-111111111111'
    const sessionTarget = JSON.stringify({
      v: 1,
      agentId,
      integrationId: '22222222-2222-4222-8222-222222222222',
      sessionKey: `slack:C1234567890:1720000000.000100:${agentId}`
    })
    const [section, ...rest] = buildStatusBlocks({ model: 'x' }, KEY, 'https://app/sessions/acp-1', {
      sessionTarget,
      shareable: true
    }) as any[]
    const [dedicatedSection] = buildStatusBlocks({ model: 'x' }, KEY, 'https://app/sessions/acp-1') as any[]

    expect(rest).toHaveLength(0)
    expect(section).toMatchObject({
      type: 'section',
      block_id: sessionTarget,
      accessory: {
        type: 'overflow',
        action_id: SLACK_STATUS_ACTION.more
      }
    })
    expect(section.text).toEqual(dedicatedSection.text)
    expect(section.text.text).not.toContain('Agent:')
    expect(section.text.text).toContain('<https://app/sessions/acp-1|View Session>')
    expect(section.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)).toEqual([
      'switch-agent',
      'manage'
    ])
    expect(section.accessory.options.map((o: any) => o.text.text)).toEqual(['Switch agent', 'Session options'])
    expect(section.block_id.length).toBeLessThanOrEqual(255)
    for (const option of section.accessory.options) expect(option.value.length).toBeLessThanOrEqual(150)
  })

  it('omits Switch agent for a non-shareable shared bot but still routes via sessionTarget', () => {
    const agentId = '11111111-1111-4111-8111-111111111111'
    const sessionTarget = JSON.stringify({
      v: 1,
      agentId,
      integrationId: '22222222-2222-4222-8222-222222222222',
      sessionKey: `slack:C1234567890:1720000000.000100:${agentId}`
    })
    const [section] = buildStatusBlocks({ model: 'x' }, KEY, 'https://app/sessions/acp-1', {
      sessionTarget,
      shareable: false
    }) as any[]

    // Overflow still targets the relay (block_id == sessionTarget), so Session options keeps
    // working — only the multi-agent "Switch agent" option is dropped.
    expect(section.block_id).toBe(sessionTarget)
    expect(section.accessory.options.map((o: any) => decodeSlackStatusOverflowValue(o.value)?.action)).toEqual([
      'manage'
    ])
    expect(section.accessory.options.map((o: any) => o.text.text)).toEqual(['Session options'])
  })
})

describe('buildStatusModal (Configure controls modal)', () => {
  const KEY = 'slack:C1:T1:bot-a'
  type Block = { type: string; text?: { text: string }; accessory?: any; elements?: any[] }
  const at = (view: Record<string, unknown>, type: string) => (view.blocks as Block[]).find((b) => b.type === type)
  const accessoryById = (view: Record<string, unknown>, actionId: string) =>
    (view.blocks as Block[])
      .flatMap((b) => [b.accessory, ...(b.elements ?? [])])
      .find((element) => element?.action_id === actionId)

  it('renders a compact titled modal with grouped controls and field usage', () => {
    const view = buildStatusModal(
      {
        model: 'opus-4.8',
        models: ['opus-4.8', 'sonnet-5'],
        effort: 'high',
        efforts: ['default', 'high'],
        fastMode: false,
        fastModeAvailable: true,
        permissionMode: 'auto',
        permissionModes: ['auto', 'plan'],
        outputMode: 'minimal',
        contextUsed: 120_000,
        contextSize: 1_000_000,
        totalTokens: 45_200,
        costAmount: 0.334,
        costCurrency: 'USD',
        inputTokens: 40_000,
        outputTokens: 5_200,
        cachedReadTokens: 1_200_000,
        cachedWriteTokens: 800
      },
      KEY,
      'https://app/sessions/acp-1',
      KEY,
      {
        name: 'Review Bot',
        agentUrl: 'https://app/agents/review-bot',
        iconUrl: 'https://app/icons/review-bot.png',
        sessionTitle: 'Fix login flow'
      }
    )
    expect(view.type).toBe('modal')
    expect(view.private_metadata).toBe(KEY)
    expect(view.title).toEqual({ type: 'plain_text', text: 'Session · Fix login flow' })
    expect(view.close).toEqual({ type: 'plain_text', text: 'Close' })

    expect((view.blocks as any[])[0]).toEqual({
      type: 'context',
      elements: [
        {
          type: 'image',
          image_url: 'https://app/icons/review-bot.png',
          alt_text: 'Review Bot'
        },
        { type: 'mrkdwn', text: '<https://app/agents/review-bot|Review Bot> ·' },
        { type: 'mrkdwn', text: '<https://app/sessions/acp-1|View session>' }
      ]
    })
    expect((view.blocks as any[]).some((b) => b.type === 'header')).toBe(false)

    const select = accessoryById(view, 'ac_set_model')
    expect(select).toMatchObject({ type: 'static_select', action_id: 'ac_set_model' })
    expect(select.initial_option.value).toBe('opus-4.8')
    expect(
      (view.blocks as any[])
        .flatMap((b) => [b.accessory, ...(b.elements ?? [])])
        .filter((element) => element?.type === 'static_select')
        .map((element) => element.action_id)
    ).toEqual(['ac_set_model', 'ac_set_fast', 'ac_set_effort', 'ac_set_permission_mode', 'ac_set_output'])
    const controlRows = (view.blocks as any[]).filter(
      (b) => b.type === 'actions' && b.elements.some((element: any) => element.type === 'static_select')
    )
    expect(controlRows.map((row) => row.elements.map((element: any) => element.action_id))).toEqual([
      ['ac_set_model', 'ac_set_fast'],
      ['ac_set_effort', 'ac_set_permission_mode'],
      ['ac_set_output']
    ])

    const [summary, breakdown] = (view.blocks as any[]).filter((b) => Array.isArray(b.fields))
    expect(summary.fields.map((field: any) => field.text)).toEqual([
      '*Current context*\n120K / 1M (12%)',
      '*Total tokens · Cost*\n45K · $0.334'
    ])
    expect(breakdown.fields.map((field: any) => field.text)).toEqual([
      '*Input* · *Output*\n40K · 5.2K',
      '*Cache read* · *Cache write*\n1.2M · 800'
    ])

    // Interrupting a turn is Slack's own Stop control — the modal offers no cancel button.
    expect(
      (view.blocks as any[])
        .filter((b) => b.type === 'actions')
        .flatMap((b) => b.elements)
        .map((element: any) => element.action_id)
    ).not.toContain('ac_cancel')
  })

  it('keeps both cache columns when the runtime omits cache-write usage', () => {
    const view = buildStatusModal({ cachedReadTokens: 15_000 }, KEY)
    const cache = (view.blocks as any[])
      .flatMap((block) => block.fields ?? [])
      .find((field) => field.text.includes('*Cache read*'))

    expect(cache.text).toBe('*Cache read* · *Cache write*\n15K · —')
  })

  it('omits the selects when the session is idle with no link', () => {
    const view = buildStatusModal({ model: 'sonnet-5', totalTokens: 10 }, KEY)
    expect(
      (view.blocks as Block[]).some(
        (b) => b.accessory?.type === 'static_select' || b.elements?.some((element) => element.type === 'static_select')
      )
    ).toBe(false)
    expect(
      (view.blocks as Block[]).flatMap((b) => b.elements ?? []).some((element) => element.text?.includes('sonnet-5'))
    ).toBe(true) // current model stays visible in the compact identity row
    expect((view.blocks as Block[]).some((b) => b.type === 'actions')).toBe(false)
  })

  it('prepends the current model to the options when the runtime list omits it', () => {
    const select = accessoryById(buildStatusModal({ model: 'custom', models: ['a', 'b'] }, KEY), 'ac_set_model')
    expect(select.options.map((o: any) => o.value)).toEqual(['custom', 'a', 'b'])
    expect(select.initial_option.value).toBe('custom')
  })

  it('renders the effort select from the advertised levels', () => {
    const view = buildStatusModal({ effort: 'high', efforts: ['low', 'high', 'xhigh', 'ultracode'] }, KEY)
    const select = accessoryById(view, 'ac_set_effort')
    expect(select).toMatchObject({ type: 'static_select', action_id: 'ac_set_effort' })
    expect(select.initial_option.value).toBe('high')
    expect(select.options.map((o: any) => o.value)).toEqual(['low', 'high', 'xhigh', 'ultracode'])
  })

  it('renders the permission-mode select from the advertised modes (unknown values verbatim)', () => {
    const view = buildStatusModal({ permissionMode: 'plan', permissionModes: ['default', 'plan'] }, KEY)
    const select = accessoryById(view, 'ac_set_permission_mode')
    expect(select).toMatchObject({ type: 'static_select', action_id: 'ac_set_permission_mode' })
    expect(select.initial_option.value).toBe('plan')
    expect(select.options.map((o: any) => o.value)).toEqual(['default', 'plan'])
    // Claude modes aren't in the Codex label map — the value portion stays verbatim.
    expect(select.options.map((o: any) => o.text.text)).toEqual(['Permission · default', 'Permission · plan'])
  })

  it('labels Codex permission-mode ids with their desktop-app names (value stays the wire id)', () => {
    const view = buildStatusModal(
      { permissionMode: 'agent-full-access', permissionModes: ['read-only', 'agent', 'agent-full-access'] },
      KEY
    )
    const select = accessoryById(view, 'ac_set_permission_mode')
    // Underlying values are the runtime-owned ids sent over the wire, unchanged.
    expect(select.options.map((o: any) => o.value)).toEqual(['read-only', 'agent', 'agent-full-access'])
    expect(select.initial_option.value).toBe('agent-full-access')
    // Display text is Codex's own name for each mode (agent = "Approve for me").
    expect(select.options.map((o: any) => o.text.text)).toEqual([
      'Permission · Ask for approval',
      'Permission · Approve for me',
      'Permission · Full access'
    ])
    expect(select.initial_option.text.text).toBe('Permission · Full access')
  })

  it('prepends a current effort the advertised list omits (e.g. a pending ultracode override)', () => {
    const select = accessoryById(
      buildStatusModal({ effort: 'ultracode', efforts: ['low', 'high'] }, KEY),
      'ac_set_effort'
    )
    expect(select.options.map((o: any) => o.value)).toEqual(['ultracode', 'low', 'high'])
    expect(select.initial_option.value).toBe('ultracode')
  })

  it('omits the effort select when no levels are advertised', () => {
    const view = buildStatusModal({ model: 'opus-4.8', models: ['opus-4.8'] }, KEY)
    expect(accessoryById(view, 'ac_set_effort')).toBeUndefined()
  })

  it('renders the fast-mode On/Off select only when a fast toggle is available', () => {
    const on = accessoryById(buildStatusModal({ fastMode: true, fastModeAvailable: true }, KEY), 'ac_set_fast')
    expect(on).toMatchObject({ type: 'static_select', action_id: 'ac_set_fast' })
    expect(on.initial_option.value).toBe('on')
    expect(on.options.map((o: any) => o.value)).toEqual(['on', 'off'])
    const off = accessoryById(buildStatusModal({ fastMode: false, fastModeAvailable: true }, KEY), 'ac_set_fast')
    expect(off.initial_option.value).toBe('off')
    // absent when the model offers no fast toggle
    expect(accessoryById(buildStatusModal({ fastMode: true }, KEY), 'ac_set_fast')).toBeUndefined()
  })

  it('renders the output-verbosity select (fixed none/minimal/low/medium/high) when the current mode is known', () => {
    const sel = accessoryById(buildStatusModal({ outputMode: 'medium' }, KEY), 'ac_set_output')
    expect(sel).toMatchObject({ type: 'static_select', action_id: 'ac_set_output' })
    expect(sel.initial_option.value).toBe('medium')
    expect(sel.options.map((o: any) => o.value)).toEqual(['none', 'minimal', 'low', 'medium', 'high'])
    // absent when the output mode is unknown (e.g. webchat snapshot without it)
    expect(accessoryById(buildStatusModal({ model: 'opus-4.8' }, KEY), 'ac_set_output')).toBeUndefined()
  })
})

describe('permission card', () => {
  const req = (over: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest =>
    ({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc1', title: 'Write perm-test.txt' },
      options: [
        { optionId: 'a', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'b', name: 'Allow for Session', kind: 'allow_always' },
        { optionId: 'r', name: 'Reject', kind: 'reject_once' }
      ],
      ...over
    }) as RequestPermissionRequest

  it('renders a header + one styled button per option, carrying requestId|optionId', () => {
    const [header, actions] = buildPermissionCard('perm-7', req(), 'shared-session-target') as any[]
    expect(header.text.text).toContain('Write perm-test.txt')
    expect(actions.block_id).toBe('shared-session-target')
    const btns = actions.elements
    expect(btns.map((b: any) => b.action_id)).toEqual([
      `${PERMISSION_ACTION_PREFIX}:0`,
      `${PERMISSION_ACTION_PREFIX}:1`,
      `${PERMISSION_ACTION_PREFIX}:2`
    ])
    expect(btns.map((b: any) => b.value)).toEqual(['perm-7|a', 'perm-7|b', 'perm-7|r'])
    expect(btns.map((b: any) => b.style)).toEqual(['primary', 'primary', 'danger'])
  })

  it('caps at 5 buttons', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ optionId: `o${i}`, name: `Opt ${i}`, kind: 'allow_once' }))
    const [, actions] = buildPermissionCard('p', req({ options: many as any })) as any[]
    expect(actions.elements).toHaveLength(5)
  })

  it('falls back to kind then toolCallId then a generic label when title is absent', () => {
    const byKind = buildPermissionCard('p', req({ toolCall: { toolCallId: 'tc1', kind: 'execute' } as any }))
    expect((byKind[0] as any).text.text).toContain('execute')
    const byId = buildPermissionCard('p', req({ toolCall: { toolCallId: 'tc9' } as any }))
    expect((byId[0] as any).text.text).toContain('tc9')
    const generic = buildPermissionCard('p', req({ toolCall: undefined as any }))
    expect((generic[0] as any).text.text).toContain('a tool call')
  })

  it('resolved card drops the buttons and shows the decision icon', () => {
    const allow = buildPermissionResolvedCard(req(), 'Allow Once', true)
    expect(allow).toHaveLength(1)
    expect((allow[0] as any).text.text).toContain(':white_check_mark:')
    expect((buildPermissionResolvedCard(req(), 'Reject', false)[0] as any).text.text).toContain(':no_entry_sign:')
    expect((buildPermissionResolvedCard(req(), 'Cancelled')[0] as any).text.text).toContain(':hourglass:')
  })

  it('renders a primary URL button for updating Slack permissions', () => {
    const updateUrl = 'https://app.slack.com/app-settings/T123/A123/oauth'
    const [message, actions] = buildPermissionUpdateCard(updateUrl) as any[]
    expect(message.text.text).toContain('Permissions update required')
    expect(actions.elements).toEqual([
      expect.objectContaining({
        type: 'button',
        style: 'primary',
        url: updateUrl,
        action_id: 'ac_update_permissions',
        text: expect.objectContaining({ text: 'Update permissions' })
      })
    ])
  })

  it('encode/decode round-trips and splits on the first | (optionId may contain |)', () => {
    expect(decodePermValue(encodePermValue('perm-3', 'opt'))).toEqual({ requestId: 'perm-3', optionId: 'opt' })
    expect(decodePermValue('perm-3|a|b|c')).toEqual({ requestId: 'perm-3', optionId: 'a|b|c' })
    expect(decodePermValue('no-separator')).toBeNull()
  })
})

describe('elicitation card', () => {
  const form = (properties: Record<string, unknown>, message = 'Pick a language'): CreateElicitationRequest =>
    ({ mode: 'form', sessionId: 's1', message, requestedSchema: { type: 'object', properties } }) as any

  it('renders titled enum (oneOf) as buttons carrying requestId|const, plus Dismiss', () => {
    const req = form({
      lang: {
        type: 'string',
        oneOf: [
          { const: 'py', title: 'Python' },
          { const: 'ts', title: 'TypeScript' }
        ]
      }
    })
    const blocks = buildElicitationCard('elicit-1', req, 'shared-session-target') as any[]
    expect(blocks[0].text.text).toContain('Pick a language')
    expect(blocks[1].block_id).toBe('shared-session-target')
    const btns = blocks[1].elements
    expect(btns.map((b: any) => b.text.text)).toEqual(['Python', 'TypeScript', 'Dismiss'])
    expect(btns[0].action_id).toBe(`${ELICIT_ACTION_PREFIX}:0`)
    expect(btns.slice(0, 2).map((b: any) => b.value)).toEqual(['elicit-1|py', 'elicit-1|ts'])
    expect(btns[2].action_id).toBe(ELICIT_DISMISS_ACTION)
    expect(btns[2].value).toBe('elicit-1')
  })

  it('renders bare string enum with value == label', () => {
    const t = elicitTarget(form({ color: { type: 'string', enum: ['red', 'green'] } }))
    expect(t).toEqual({
      propName: 'color',
      kind: 'enum',
      options: [
        { value: 'red', label: 'red' },
        { value: 'green', label: 'green' }
      ]
    })
  })

  it('renders boolean as Yes/No', () => {
    const t = elicitTarget(form({ ok: { type: 'boolean' } }))
    expect(t).toEqual({
      propName: 'ok',
      kind: 'boolean',
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' }
      ]
    })
  })

  it('returns null (→ caller declines) for free-text-only forms and url mode', () => {
    expect(elicitTarget(form({ name: { type: 'string' } }))).toBeNull()
    expect(buildElicitationCard('e', form({ name: { type: 'string' } }))).toBeNull()
    expect(elicitTarget({ mode: 'url', sessionId: 's1', message: 'go', url: 'https://x' } as any)).toBeNull()
  })

  it('resolved card is a single section with the decision', () => {
    const blocks = buildElicitationResolvedCard(form({ ok: { type: 'boolean' } }), ':white_check_mark: Yes')
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).text.text).toContain(':white_check_mark: Yes')
  })
})
