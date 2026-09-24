import { describe, expect, it } from 'vitest'
import { type DecisionVerdictReservation, type LocalStore } from '../src/store/local-store.js'
import { STORE_RETENTION_RULES, StoreRetentionSweeper } from '../src/store/retention.js'
import { openTestStore } from './store-support.js'
import { threadRootResolver } from '../src/platforms/thread-keys.js'

// message-intake.md §4.3 / §5.1 / §8 and decisions.md §8.1 / §8.3 — the verdict and release tables, both dialects.

const CH = 'C1'
const AGENT = 'bot-a'
const FENCE = 'daemon-1:boot-1'
const DAY = 24 * 3_600_000
const AT = 1_800_000_000_000

async function record(s: LocalStore, ts: number, over: Record<string, unknown> = {}): Promise<number> {
  await s.appendTranscript({
    channel: CH,
    thread: String(ts),
    ts: String(ts),
    sender: 'U1',
    kind: 'text',
    text: `m${ts}`,
    orgAgentId: AGENT,
    ...over
  })
  return (await s.channelRecordRef((over.channel as string | undefined) ?? CH, String(ts), AGENT))!.seq
}

const reservation = (seq: number, over: Partial<DecisionVerdictReservation> = {}): DecisionVerdictReservation => ({
  seq,
  subject: AGENT,
  orgId: '',
  channel: CH,
  agentId: AGENT,
  integrationId: 'int-a',
  decisionId: 'd-1',
  configJson: '{"decisionId":"d-1"}',
  deliveryJson: '{"origin":"direct"}',
  requestedModel: 'jev-1.13.0',
  deadlineAt: AT + 5_000,
  ownerFence: FENCE,
  createdAt: AT,
  ...over
})

const settled = { disposition: 'match' as const, answerJson: '{"answer":1}', settledAt: AT + 10 }

describe('decision verdict store', () => {
  it('resolves a channel record by its dedup key and reserves idempotently', async () => {
    const s = await openTestStore()
    const seq = await record(s, 1)
    expect(await s.channelRecordRef(CH, '1', AGENT)).toEqual({ seq, orgId: '', transcriptChannel: CH, thread: '1' })
    expect(await s.channelRecordRef(CH, '404', AGENT)).toBeUndefined()
    const first = await s.reserveDecisionVerdict(reservation(seq))
    expect(first.created).toBe(true)
    expect(first.verdict).toMatchObject({
      seq,
      subject: AGENT,
      state: 'reserved',
      ownerFence: FENCE,
      deadlineAt: AT + 5_000
    })
    const second = await s.reserveDecisionVerdict(reservation(seq, { ownerFence: 'other' }))
    expect(second).toMatchObject({ created: false, verdict: { ownerFence: FENCE } })
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBe(0)
    // A swept (or never-recorded) row cannot be reserved.
    expect(await s.reserveDecisionVerdict(reservation(seq + 999))).toEqual({ created: false, verdict: undefined })
    await s.close()
  })

  it('moves only through fenced CAS transitions, and a late settle after cancel is dropped', async () => {
    const s = await openTestStore()
    const seq = await record(s, 1)
    await s.reserveDecisionVerdict(reservation(seq))
    expect(await s.beginDecisionEvaluation(seq, AGENT, 'stranger', '{}')).toBe(false)
    expect(await s.beginDecisionEvaluation(seq, AGENT, FENCE, '{"state":1}')).toBe(true)
    expect(await s.beginDecisionEvaluation(seq, AGENT, FENCE, '{}')).toBe(false)
    expect(await s.settleDecisionVerdict(seq, AGENT, 'stranger', settled)).toBe(false)
    expect(
      await s.settleDecisionVerdict(seq, AGENT, FENCE, {
        ...settled,
        actualModel: 'jev',
        inputTokens: 3,
        outputTokens: 1,
        latencyMs: 7
      })
    ).toBe(true)
    expect(await s.getDecisionVerdict(seq, AGENT)).toMatchObject({
      state: 'settled',
      disposition: 'match',
      inputJson: '{"state":1}',
      actualModel: 'jev',
      inputTokens: 3,
      outputTokens: 1,
      latencyMs: 7,
      settledAt: AT + 10
    })
    expect(await s.settleDecisionVerdict(seq, AGENT, FENCE, settled)).toBe(false)
    expect(await s.adoptDecisionVerdict(seq, AGENT, 'stranger', 'daemon-2:boot')).toBe(false)
    expect(await s.adoptDecisionVerdict(seq, AGENT, FENCE, 'daemon-2:boot')).toBe(true)
    expect(await s.finishDecisionVerdict(seq, AGENT, FENCE, 'admitted', null, AT + 20)).toBe(false)
    expect(await s.finishDecisionVerdict(seq, AGENT, 'daemon-2:boot', 'admitted', null, AT + 20)).toBe(true)
    expect(await s.getDecisionVerdict(seq, AGENT)).toMatchObject({
      state: 'admitted',
      deliveryJson: null,
      finishedAt: AT + 20
    })

    const late = await record(s, 2)
    await s.reserveDecisionVerdict(reservation(late))
    await s.beginDecisionEvaluation(late, AGENT, FENCE, '{}')
    expect(await s.finishDecisionVerdict(late, AGENT, null, 'canceled', 'stop', AT + 30)).toBe(true)
    expect(await s.settleDecisionVerdict(late, AGENT, FENCE, settled)).toBe(false)
    expect(await s.getDecisionVerdict(late, AGENT)).toMatchObject({ state: 'canceled', cancelReason: 'stop' })
    await s.close()
  })

  it('never advances the release cursor past a pending verdict, and jumps once the head finishes', async () => {
    const s = await openTestStore()
    const [a, b, c] = [await record(s, 1), await record(s, 2), await record(s, 3)]
    for (const seq of [a, b, c]) await s.reserveDecisionVerdict(reservation(seq))
    expect((await s.decisionLaneHead('', CH, AGENT))?.seq).toBe(a)
    await s.settleDecisionVerdict(b, AGENT, FENCE, { disposition: 'skip', settledAt: AT })
    expect(await s.getDecisionVerdict(b, AGENT)).toMatchObject({ state: 'skipped', finishedAt: AT, deliveryJson: null })
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBe(0)
    await s.finishDecisionVerdict(a, AGENT, FENCE, 'canceled', 'stop', AT)
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBe(b)
    expect((await s.decisionLaneHead('', CH, AGENT))?.seq).toBe(c)
    await s.settleDecisionVerdict(c, AGENT, FENCE, settled)
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBe(b)
    await s.finishDecisionVerdict(c, AGENT, FENCE, 'admitted', null, AT)
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBe(c)
    expect(await s.decisionLaneHead('', CH, AGENT)).toBeUndefined()
    await s.close()
  })

  it('cancels by subject and conversation only, lists pending, and writes background once', async () => {
    const s = await openTestStore()
    const a = await record(s, 1)
    const other = await record(s, 2, { channel: 'C2' })
    await s.reserveDecisionVerdict(reservation(a))
    await s.reserveDecisionVerdict(reservation(a, { subject: 'bot-b', agentId: 'bot-b' }))
    await s.reserveDecisionVerdict(reservation(other, { channel: 'C2' }))
    expect((await s.listPendingDecisionVerdicts({ agentIds: [AGENT] })).map((r) => r.channel)).toEqual([CH, 'C2'])
    expect(await s.cancelPendingDecisionVerdicts({ subject: AGENT, channel: CH }, 'stop', AT)).toEqual([
      { seq: a, subject: AGENT }
    ])
    expect((await s.listPendingDecisionVerdicts()).map((r) => `${r.subject}@${r.channel}`)).toEqual([
      'bot-b@C1',
      `${AGENT}@C2`
    ])
    expect(await s.claimVerdictBackground(a, 'bot-b', [3, 1])).toEqual([3, 1])
    expect(await s.claimVerdictBackground(a, 'bot-b', [9])).toEqual([3, 1])
    await s.close()
  })

  it('purges an integration and the release rows it leaves with no verdict', async () => {
    const s = await openTestStore()
    const a = await record(s, 1)
    await s.reserveDecisionVerdict(reservation(a))
    await s.reserveDecisionVerdict(reservation(a, { subject: 'bot-b', agentId: 'bot-b', integrationId: 'int-b' }))
    expect(await s.purgeDecisionVerdicts({ integrationId: 'int-a' })).toBe(1)
    expect(await s.getDecisionVerdict(a, AGENT)).toBeUndefined()
    expect(await s.decisionReleasedSeq('', CH, AGENT)).toBeUndefined()
    expect(await s.getDecisionVerdict(a, 'bot-b')).toBeDefined()
    await s.close()
  })

  it('strips terminal bodies past the newest 20 of a lane or after 24 hours, keeping minimal metadata', async () => {
    const s = await openTestStore()
    const seqs: number[] = []
    for (let i = 1; i <= 21; i++) seqs.push(await record(s, i))
    for (const seq of seqs) {
      await s.reserveDecisionVerdict(reservation(seq))
      await s.beginDecisionEvaluation(seq, AGENT, FENCE, '{"input":1}')
      await s.settleDecisionVerdict(seq, AGENT, FENCE, { disposition: 'skip', answerJson: '{"a":1}', settledAt: AT })
    }
    const fresh = await record(s, 50)
    await s.reserveDecisionVerdict(reservation(fresh, { subject: 'bot-b', agentId: 'bot-b' }))
    await s.settleDecisionVerdict(fresh, 'bot-b', FENCE, {
      disposition: 'skip',
      answerJson: '{"a":1}',
      settledAt: AT - 2 * DAY
    })
    expect(await s.stripDecisionVerdictBodies(AT + 1)).toBe(2)
    expect(await s.getDecisionVerdict(seqs[0]!, AGENT)).toMatchObject({
      state: 'skipped',
      disposition: 'skip',
      inputJson: null,
      answerJson: null,
      bodiesStrippedAt: AT + 1
    })
    expect(await s.getDecisionVerdict(seqs[1]!, AGENT)).toMatchObject({
      inputJson: '{"input":1}',
      answerJson: '{"a":1}'
    })
    expect(await s.getDecisionVerdict(fresh, 'bot-b')).toMatchObject({ answerJson: null })
    await s.close()
  })

  it('ages terminal metadata out after 7 days and stale pending work after a day', async () => {
    const s = await openTestStore()
    const [old, recent, stale] = [await record(s, 1), await record(s, 2), await record(s, 3)]
    const now = AT + 8 * DAY
    await s.reserveDecisionVerdict(reservation(old))
    await s.finishDecisionVerdict(old, AGENT, FENCE, 'canceled', 'stop', AT)
    await s.reserveDecisionVerdict(reservation(recent, { createdAt: now - DAY }))
    await s.finishDecisionVerdict(recent, AGENT, FENCE, 'admitted', null, now - DAY)
    await s.reserveDecisionVerdict(reservation(stale, { createdAt: now - 2 * DAY }))
    const summary = await new StoreRetentionSweeper({
      store: s,
      settings: { scale: 1, deleteOrphans: false },
      rules: STORE_RETENTION_RULES.filter((r) => r.table === 'decision_verdict'),
      clock: { now: () => now } as never,
      log: { info: () => undefined, warn: () => undefined }
    }).sweepAgeOnly()
    expect(summary!.byRule).toMatchObject({ 'decision-verdict': 1, 'decision-verdict-stale': 1 })
    expect(await s.getDecisionVerdict(old, AGENT)).toBeUndefined()
    expect(await s.getDecisionVerdict(stale, AGENT)).toBeUndefined()
    expect(await s.getDecisionVerdict(recent, AGENT)).toBeDefined()
    await s.close()
  })

  it('strips an admitted verdict body when its session is deleted', async () => {
    const s = await openTestStore()
    const key = `slack:${CH}:1:${AGENT}`
    await s.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: CH,
      thread: '1',
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    } as never)
    const seq = await record(s, 1, { admission: { agentId: AGENT, sessionKey: key } })
    await s.reserveDecisionVerdict(reservation(seq))
    await s.beginDecisionEvaluation(seq, AGENT, FENCE, '{"input":1}')
    await s.settleDecisionVerdict(seq, AGENT, FENCE, settled)
    await s.claimVerdictBackground(seq, AGENT, [1])
    await s.finishDecisionVerdict(seq, AGENT, FENCE, 'admitted', null, AT)
    expect(await s.deleteSession(key)).toBe(true)
    const row = await s.getDecisionVerdict(seq, AGENT)
    expect(row).toMatchObject({ state: 'admitted', inputJson: null, answerJson: null, suppliedSeqsJson: null })
    expect(row?.bodiesStrippedAt).toBeTypeOf('number')
    await s.close()
  })

  // Case (h): the §8 rule 2 clause a pending verdict adds.
  it('keeps rows a pending verdict references through the observation sweep, and drops a terminal one', async () => {
    const s = await openTestStore()
    const evaluating = await record(s, 1)
    const earlier = await record(s, 2)
    const behind = await record(s, 3)
    const done = await record(s, 4)
    await s.reserveDecisionVerdict(reservation(evaluating))
    await s.beginDecisionEvaluation(evaluating, AGENT, FENCE, '{}')
    await s.reserveDecisionVerdict(reservation(earlier, { subject: 'bot-b', agentId: 'bot-b' }))
    await s.reserveDecisionVerdict(reservation(behind, { subject: 'bot-b', agentId: 'bot-b' }))
    await s.settleDecisionVerdict(behind, 'bot-b', FENCE, settled)
    await s.reserveDecisionVerdict(reservation(done))
    await s.finishDecisionVerdict(done, AGENT, FENCE, 'canceled', 'stop', AT)
    for (let i = 100; i < 205; i++) await record(s, i)
    await s.sweepObservations('', CH)
    const texts = (await s.decisionWindow('', CH, 1_000_000, 200)).history.map((r) => r.text)
    expect(texts).toContain('m1')
    expect(texts).toContain('m2')
    expect(texts).toContain('m3')
    expect(texts).not.toContain('m4')
    await s.close()
  })

  it('selects background: own, admitted, same-thread and control rows out, bounded below, oldest-first', async () => {
    const s = await openTestStore()
    const key = `slack:${CH}:T9:${AGENT}`
    const early = await record(s, 1)
    await record(s, 2, { admission: { agentId: AGENT, sessionKey: key }, thread: 'T9' })
    const a = await record(s, 3)
    await record(s, 4, { sender: AGENT })
    await record(s, 5, { thread: 'T9' })
    await record(s, 6, { text: '!stop' })
    const b = await record(s, 7, { thread: '3' })
    const current = await record(s, 8, { thread: 'T9' })
    await record(s, 9)
    const seqs = await s.backgroundSeqsForAdmission({
      agentId: AGENT,
      transcriptChannel: CH,
      coordinate: 'T9',
      sessionKey: key,
      currentSeq: current,
      limit: 50
    })
    expect(seqs).toEqual([a, b])
    expect(seqs).not.toContain(early)
    const rows = await s.transcriptRowsBySeq({ agentId: AGENT, transcriptChannel: CH }, [b, a, current])
    expect(rows.map((r) => r.seq)).toEqual([a, b, current])
    expect(await s.transcriptRowsBySeq({ agentId: AGENT, transcriptChannel: 'C2' }, [a])).toEqual([])
    const capped = await s.backgroundSeqsForAdmission({
      agentId: AGENT,
      transcriptChannel: CH,
      coordinate: 'T9',
      sessionKey: 'fresh',
      currentSeq: current,
      limit: 2
    })
    expect(capped).toEqual([a, b])
    await s.close()
  })

  it('reports the window gap evidence the state builder reads', async () => {
    const s = await openTestStore()
    // The oldest recorded row is a reply whose root was never recorded here.
    await record(s, 5, { thread: '1' })
    for (let i = 6; i <= 9; i++) await record(s, i)
    const current = await record(s, 10)
    const window = await s.decisionWindow('', CH, current, 3)
    expect(window.current?.text).toBe('m10')
    expect(window.history.map((r) => r.text)).toEqual(['m9', 'm8', 'm7'])
    expect(window.full).toBe(true)
    expect(window.rootMissing).toBe(true)
    await s.close()
  })

  it('reports a missing Slack root when only its replies survive, from the platform rather than retained rows', async () => {
    const s = await openTestStore()
    // One passively observed thread whose root was swept: every row replies to ts 1, none has thread = ts.
    for (let i = 2; i <= 5; i++) await record(s, i, { thread: '1' })
    const current = await record(s, 6, { thread: '1' })
    expect((await s.decisionWindow('', CH, current)).rootMissing).toBe(false)
    expect((await s.decisionWindow('', CH, current, 100, threadRootResolver('slack'))).rootMissing).toBe(true)
    expect((await s.decisionWindow('', CH, current, 100, threadRootResolver('qq'))).rootMissing).toBe(false)
    await record(s, 1)
    expect((await s.decisionWindow('', CH, current, 100, threadRootResolver('slack'))).rootMissing).toBe(false)
    await s.close()
  })

  it('names each registered platform root the way its threads carry it', () => {
    expect(threadRootResolver('slack')?.('1.5')).toBe('1.5')
    expect(threadRootResolver('feishu')?.('om_1')).toBe('om_1')
    expect(threadRootResolver('feishu', true)?.('oc_chat')).toBeUndefined()
    expect(threadRootResolver('telegram')?.('tg:42')).toBe('42')
    expect(threadRootResolver('telegram')?.('7')).toBeUndefined()
    expect(threadRootResolver('discord')).toBeUndefined()
  })

  it('does not report a missing root for a conversation that never threads by root ts', async () => {
    const s = await openTestStore()
    // Telegram/Discord fall back to the msgId and QQ to a literal, so no row has thread = ts.
    await record(s, 1, { thread: 'telegram:C1:1' })
    await record(s, 2, { thread: 'group' })
    const current = await record(s, 3, { thread: 'group' })
    expect((await s.decisionWindow('', CH, current)).rootMissing).toBe(false)
    await s.close()
  })

  describe('router verdicts (message-intake.md §4.3)', () => {
    const ROUTER = 'router:bot-1'
    const targets = [
      {
        agentId: 'a',
        daemonId: 'd-1',
        participant: false,
        effect: 'selected',
        via: 'implicit',
        disposition: 'pending'
      },
      { agentId: 'b', daemonId: 'd-2', participant: false, effect: 'selected', via: 'implicit', disposition: 'pending' }
    ]
    const routerRow = (seq: number) => reservation(seq, { subject: ROUTER, configJson: '{"botId":"bot-1"}' })

    it('writes targetsJson with the settlement and moves targets only pending → terminal under the fence', async () => {
      const s = await openTestStore()
      const seq = await record(s, 1)
      await s.reserveDecisionVerdict(routerRow(seq))
      expect(
        await s.settleDecisionVerdict(seq, ROUTER, FENCE, {
          ...settled,
          inputTokens: 7,
          outputTokens: 1,
          targetsJson: JSON.stringify(targets)
        })
      ).toBe(true)
      const row = (await s.getDecisionVerdict(seq, ROUTER))!
      expect(JSON.parse(row.targetsJson!)).toEqual(targets)
      expect([row.inputTokens, row.outputTokens].map(Number)).toEqual([7, 1])
      expect(await s.updateRouterTargets(seq, ROUTER, 'stranger', [{ agentId: 'a', disposition: 'admitted' }])).toBe(
        undefined
      )
      const moved = await s.updateRouterTargets(seq, ROUTER, FENCE, [
        { agentId: 'a', disposition: 'admitted' },
        { agentId: 'b', disposition: 'pending', retryUntil: AT + 60_000, attempts: 1 }
      ])
      expect(moved?.map((t) => [t.agentId, t.disposition, t.retryUntil])).toEqual([
        ['a', 'admitted', undefined],
        ['b', 'pending', AT + 60_000]
      ])
      // A terminal target is never rewritten.
      const again = await s.updateRouterTargets(seq, ROUTER, FENCE, [
        { agentId: 'a', disposition: 'rejected', reason: 'x' }
      ])
      expect(again?.[0]).toMatchObject({ agentId: 'a', disposition: 'admitted' })
      // A gate settlement leaves targetsJson null; a finished verdict takes no more target moves.
      const gateSeq = await record(s, 2)
      await s.reserveDecisionVerdict(reservation(gateSeq))
      await s.settleDecisionVerdict(gateSeq, AGENT, FENCE, settled)
      expect((await s.getDecisionVerdict(gateSeq, AGENT))!.targetsJson).toBeNull()
      await s.finishDecisionVerdict(seq, ROUTER, FENCE, 'admitted', null, AT + 20)
      expect(await s.updateRouterTargets(seq, ROUTER, FENCE, [{ agentId: 'b', disposition: 'admitted' }])).toBe(
        undefined
      )
      await s.close()
    })

    it('filters pending verdicts by consumer, and cancels only the consumer asked for', async () => {
      const s = await openTestStore()
      const one = await record(s, 1)
      const two = await record(s, 2)
      const three = await record(s, 3)
      await s.reserveDecisionVerdict(routerRow(one))
      await s.reserveDecisionVerdict(reservation(two))
      // A code-host routing verdict belongs to neither consumer's recovery.
      await s.reserveDecisionVerdict(reservation(three, { subject: 'hook-router:r-1', integrationId: 'r-1' }))
      expect((await s.listPendingDecisionVerdicts({ consumer: 'router' })).map((r) => r.subject)).toEqual([ROUTER])
      expect((await s.listPendingDecisionVerdicts({ consumer: 'gate' })).map((r) => r.subject)).toEqual([AGENT])
      expect(await s.listPendingDecisionVerdicts()).toHaveLength(3)
      const canceled = await s.cancelPendingDecisionVerdicts({ integrationId: 'int-a', consumer: 'gate' }, 'x', AT)
      expect(canceled).toEqual([{ seq: two, subject: AGENT }])
      await s.close()
    })

    it('lists one integration lane across channels when no channel is named', async () => {
      const s = await openTestStore()
      const a = await record(s, 1)
      const b = await record(s, 2, { channel: 'C2' })
      for (const seq of [a, b]) await s.reserveDecisionVerdict(reservation(seq, { channel: seq === a ? CH : 'C2' }))
      const all = await s.listDecisionVerdicts({ orgId: '', integrationId: 'int-a', subject: AGENT, limit: 10 })
      expect(all.map((r) => r.seq)).toEqual([b, a])
      const one = await s.listDecisionVerdicts({
        orgId: '',
        integrationId: 'int-a',
        channel: CH,
        subject: AGENT,
        limit: 10
      })
      expect(one.map((r) => r.seq)).toEqual([a])
      await s.close()
    })

    it('cuts a thread-scoped window: that thread only, and nothing for a null thread', async () => {
      const s = await openTestStore()
      await record(s, 1, { thread: '42' })
      await record(s, 2, { thread: '7' })
      const current = await record(s, 3, { thread: '42' })
      const scoped = await s.decisionWindow('', CH, current, undefined, undefined, { thread: '42' })
      expect(scoped.current?.text).toBe('m3')
      expect(scoped.history.map((r) => r.text)).toEqual(['m1'])
      expect((await s.decisionWindow('', CH, current, undefined, undefined, { thread: null })).history).toEqual([])
      await s.close()
    })

    it('reads earlier verdicts of one thread, root included, newest first', async () => {
      const s = await openTestStore()
      const root = await record(s, 10, { thread: '10' })
      const reply = await record(s, 11, { thread: '10' })
      const other = await record(s, 12, { thread: '12' })
      const late = await record(s, 13, { thread: '10' })
      for (const seq of [root, reply, other]) await s.reserveDecisionVerdict(routerRow(seq))
      const rows = await s.routerVerdictsInThread({
        orgId: '',
        channel: CH,
        subject: ROUTER,
        thread: '10',
        beforeSeq: late
      })
      expect(rows.map((r) => [r.seq, r.state])).toEqual([
        [reply, 'reserved'],
        [root, 'reserved']
      ])
      await s.close()
    })

    it('a background claim and a concurrent target move both survive (no lost targetsJson write)', async () => {
      const s = await openTestStore()
      const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((agentId) => ({ ...targets[0]!, agentId }))
      for (let round = 0; round < 6; round++) {
        const seq = await record(s, 100 + round)
        await s.reserveDecisionVerdict(routerRow(seq))
        await s.settleDecisionVerdict(seq, ROUTER, FENCE, { ...settled, targetsJson: JSON.stringify(many) })
        await Promise.all(
          many.map((t, i) =>
            i % 2 === 0
              ? s.claimVerdictBackground(seq, ROUTER, [i], t.agentId)
              : s.updateRouterTargets(seq, ROUTER, FENCE, [{ agentId: t.agentId, disposition: 'admitted' }])
          )
        )
        const final = JSON.parse((await s.getDecisionVerdict(seq, ROUTER))!.targetsJson!) as Array<{
          agentId: string
          disposition: string
          backgroundSeqs?: number[]
        }>
        expect(final.map((t, i) => (i % 2 === 0 ? t.backgroundSeqs : t.disposition))).toEqual(
          many.map((_, i) => (i % 2 === 0 ? [i] : 'admitted'))
        )
      }
      await s.close()
    })

    it('claims background per router target, first writer wins, and body stripping keeps targetsJson', async () => {
      const s = await openTestStore()
      const seq = await record(s, 1)
      await s.reserveDecisionVerdict(routerRow(seq))
      await s.settleDecisionVerdict(seq, ROUTER, FENCE, { ...settled, targetsJson: JSON.stringify(targets) })
      expect(await s.claimVerdictBackground(seq, ROUTER, [1, 2], 'a')).toEqual([1, 2])
      expect(await s.claimVerdictBackground(seq, ROUTER, [3], 'a')).toEqual([1, 2])
      expect(await s.claimVerdictBackground(seq, ROUTER, [4], 'b')).toEqual([4])
      expect((await s.getDecisionVerdict(seq, ROUTER))!.suppliedSeqsJson).toBeNull()
      await s.finishDecisionVerdict(seq, ROUTER, FENCE, 'admitted', null, AT)
      await s.stripDecisionVerdictBodies(AT + 2 * DAY)
      const row = (await s.getDecisionVerdict(seq, ROUTER))!
      expect(row.answerJson).toBeNull()
      expect(JSON.parse(row.targetsJson!).map((t: { backgroundSeqs?: number[] }) => t.backgroundSeqs)).toEqual([
        [1, 2],
        [4]
      ])
      await s.close()
    })

    it('records backfill observations once, before a routed message', async () => {
      const s = await openTestStore()
      const rows = [
        { ts: '5', thread: '5', sender: 'U2', text: 'earlier' },
        { ts: '6', thread: null, sender: 'U3', text: 'quoted', quoted: { text: 'q' } }
      ]
      await s.recordObservations(AGENT, CH, rows)
      await s.recordObservations(AGENT, CH, rows)
      const window = await s.decisionWindow('', CH, Number.MAX_SAFE_INTEGER)
      if (s.isShared) expect(window.history).toEqual([])
      else expect(window.history.map((r) => r.text)).toEqual(['quoted', 'earlier'])
      await s.close()
    })
  })
})
