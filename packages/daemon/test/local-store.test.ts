import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey } from '../src/store/local-store.js'

function store(): LocalStore {
  return new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-db-')), 'local.sqlite'))
}

describe('LocalStore', () => {
  it('keeps every agent reply in a thread, and lets a finalization refresh its own text', () => {
    // The production failure this pins: a response finalization used to reach the
    // transcript with the literal ts `'final'` (a `:final` msgId suffix that
    // `transcriptCoords` read as the ts). The UNIQUE index is (channel, thread, ts) and
    // does NOT include the recipient, so only the FIRST agent reply in a thread survived
    // — every later one was silently dropped by INSERT OR IGNORE. In a multi-agent Slack
    // thread that means an agent sees exactly one peer message, ever.
    const s = store()
    const row = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
      channel: 'slack:C1',
      thread: '100.1',
      ts,
      sender: 'bot-a',
      recipient: 'bot-b',
      kind: 'text' as const,
      text,
      ...extra
    })
    s.appendTranscript(row('100.2', '1'))
    s.appendTranscript(row('100.3', '3'))
    s.appendTranscript(row('100.4', '7'))

    const texts = () => s.threadTranscript('slack:C1', '100.1').map((r) => r.text)
    expect(texts()).toEqual(['1', '3', '7'])

    // A finalization lands on its OWN post's coordinates and upgrades the text in place —
    // the post can hold a streamed prefix, and a text row has no other update path.
    s.appendTranscript(row('100.4', '7 (complete)', { authoritative: true }))
    expect(texts()).toEqual(['1', '3', '7 (complete)'])

    // Without that marker a re-observation must never rewrite an existing row.
    s.appendTranscript(row('100.4', 'stale replay'))
    expect(texts()).toEqual(['1', '3', '7 (complete)'])
  })

  it('upserts and reads back a session record', () => {
    const s = store()
    const key = sessionKey('slack', 'C1', '100.1', 'bot-a')
    s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const got = s.getSession(key)
    expect(got?.agentId).toBe('bot-a')
    expect(got?.state).toBe('idle')
    s.close()
  })

  it('migrates legacy Discord thread-as-channel sessions onto parent/thread coordinates', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-discord-coords-')), 'local.sqlite')
    const first = new LocalStore(path)
    const legacyKey = sessionKey('discord', 'T1', 'T1', 'bot-a')
    const nextKey = sessionKey('discord', 'C1', 'T1', 'bot-a')
    first.setChannelScope('T1', { parentId: 'C1' }, 1)
    first.upsertSession({
      key: legacyKey,
      agentId: 'bot-a',
      platform: 'discord',
      channel: 'T1',
      thread: 'T1',
      acpSessionId: 'acp-discord',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    first.setSessionMuted(legacyKey, true)
    first.appendTranscript({ channel: 'T1', thread: 'T1', ts: '1', sender: 'U1', kind: 'text', text: 'hello' })
    first.appendInbox({
      id: 'discord-delivery',
      sessionKey: legacyKey,
      agentId: 'bot-a',
      msg: JSON.stringify({ platform: 'discord', channel: 'T1', thread: 'T1', parentChannel: 'C1' }),
      enqueuedAt: '1'
    })
    first.close()

    const restored = new LocalStore(path)
    expect(restored.getSession(legacyKey)).toBeUndefined()
    expect(restored.getSession(nextKey)).toMatchObject({
      key: nextKey,
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-discord'
    })
    expect(restored.isSessionMuted(nextKey)).toBe(true)
    expect(restored.threadTranscript('C1', 'T1').map((row) => row.text)).toEqual(['hello'])
    expect(restored.threadTranscript('T1', 'T1')).toEqual([])
    const inbox = restored.listInboxBySessionKeyFifo()[0]!
    expect(inbox.sessionKey).toBe(nextKey)
    expect(JSON.parse(inbox.msg)).toEqual({ platform: 'discord', channel: 'C1', thread: 'T1' })
    restored.close()
  })

  it('persists only explicitly pending session snapshots and fences stale ACKs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-session-outbox-')), 'local.sqlite')
    const first = new LocalStore(path)
    first.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    // Enrichment alone never turns an existing historical row into replay work.
    expect(first.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"plan"}', false, 1)).toBeUndefined()
    expect(first.hasPendingSessionMetadata()).toBe(false)

    expect(first.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"start"}', true, 2)).toBe(1)
    first.close()

    const restored = new LocalStore(path)
    expect(restored.nextSessionMetadataSnapshot()).toMatchObject({
      agentId: 'bot-a',
      sessionId: 'acp-1',
      revision: 1,
      snapshot: '{"phase":"start"}'
    })

    // A newer projection replaces the payload and revision. Its predecessor's
    // delayed ACK cannot delete it.
    expect(restored.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"end"}', false, 3)).toBe(2)
    expect(restored.acknowledgeSessionMetadataSnapshot('bot-a', 'acp-1', 1)).toBe(false)
    expect(restored.nextSessionMetadataSnapshot()).toMatchObject({ revision: 2, snapshot: '{"phase":"end"}' })
    expect(restored.acknowledgeSessionMetadataSnapshot('bot-a', 'acp-1', 2)).toBe(true)
    expect(restored.hasPendingSessionMetadata()).toBe(false)
    restored.close()
  })

  it('does not recursively mine dream execution sessions as dream sources', () => {
    const s = store()
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'source-session',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    s.upsertSession({
      key: sessionKey('dream', 'memory', 'drm-1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'dream',
      channel: 'memory',
      thread: 'drm-1',
      acpSessionId: 'dream-session',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })

    expect(s.dreamSessionSources('bot-a', 20)).toEqual([
      { sessionId: 'source-session', channel: 'C1', thread: 'T1', updatedAt: 1 }
    ])
    s.close()
  })

  it('returns transcript entries strictly after a marker, ordered by ts', () => {
    const s = store()
    s.appendTranscript({ channel: 'C1', thread: '100.1', ts: '100.2', sender: 'U1', kind: 'text', text: 'first' })
    s.appendTranscript({ channel: 'C1', thread: '100.1', ts: '100.3', sender: 'U2', kind: 'text', text: 'second' })
    s.appendTranscript({ channel: 'C1', thread: '100.1', ts: '100.4', sender: 'U1', kind: 'text', text: 'third' })
    const gap = s.transcriptSince('C1', '100.1', '100.2')
    expect(gap.map((e) => e.text)).toEqual(['second', 'third'])
    const all = s.transcriptSince('C1', '100.1', null)
    expect(all).toHaveLength(3)
    s.close()
  })

  it('replay returns only text rows; the full activity log returns all kinds in order', () => {
    const s = store()
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '1', sender: 'U1', kind: 'text', text: 'ask' })
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '2', sender: 'bot', kind: 'reasoning', text: 'hmm' })
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '3', sender: 'bot', kind: 'tool', text: 'Read x' })
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4', sender: 'bot', kind: 'text', text: 'answer' })

    // §8.5 replay: conversational text only
    expect(s.transcriptSince('C1', 'T', null).map((e) => e.text)).toEqual(['ask', 'answer'])
    // Web UI: every kind, insertion order
    expect(s.threadTranscript('C1', 'T').map((r) => [r.kind, r.text])).toEqual([
      ['text', 'ask'],
      ['reasoning', 'hmm'],
      ['tool', 'Read x'],
      ['text', 'answer']
    ])
    s.close()
  })

  it('migrates a legacy (pre-kind) transcript table, tagging old rows as text', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mig-')), 'local.sqlite')
    // Hand-build the old schema: PRIMARY KEY (channel, thread, ts), no kind/seq.
    const legacy = new DatabaseSync(path)
    legacy.exec(
      'CREATE TABLE transcript (channel TEXT, thread TEXT, ts TEXT, sender TEXT, text TEXT, PRIMARY KEY (channel, thread, ts))'
    )
    legacy.prepare('INSERT INTO transcript VALUES (?,?,?,?,?)').run('C1', 'T', '100.1', 'U1', 'old one')
    legacy.prepare('INSERT INTO transcript VALUES (?,?,?,?,?)').run('C1', 'T', '100.2', 'bot', 'old two')
    legacy.close()

    // Opening the store migrates in place; legacy rows survive as kind='text'…
    const s = new LocalStore(path)
    expect(s.threadTranscript('C1', 'T').map((r) => [r.kind, r.text])).toEqual([
      ['text', 'old one'],
      ['text', 'old two']
    ])
    // A later authoritative Slack snapshot can safely upgrade a pre-column row in
    // place; absent provenance remains fail-closed until it is re-observed.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '100.1',
      sender: 'U1',
      trustedAgentBot: true,
      kind: 'text',
      text: 'old one'
    })
    expect(s.threadTranscript('C1', 'T').find((row) => row.ts === '100.1')?.trustedAgentBot).toBeTruthy()
    // …and the new kind column is usable afterward.
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '100.3', sender: 'bot', kind: 'tool', text: 'Edit y' })
    expect(s.transcriptSince('C1', 'T', null).map((e) => e.text)).toEqual(['old one', 'old two'])
    expect(s.threadTranscript('C1', 'T')).toHaveLength(3)
    s.close()
  })

  it('adds the superseded dream state and reconciles proposals stranded by an adoption', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-dream-status-mig-')), 'local.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE dreams (
        dreamId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('pending', 'running', 'completed', 'failed', 'canceled', 'adopted', 'discarded')),
        triggerKind TEXT NOT NULL,
        sessionIds TEXT NOT NULL,
        snapshotDigest TEXT NOT NULL,
        snapshotWrites TEXT,
        instructions TEXT,
        skills TEXT,
        usage TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        endedAt TEXT
      )
    `)
    const insert = legacy.prepare(`
      INSERT INTO dreams (
        dreamId, agentId, status, triggerKind, sessionIds, snapshotDigest,
        snapshotWrites, instructions, skills, usage, error, createdAt, endedAt
      ) VALUES (?, 'a1', ?, 'manual', '[]', 'sha256:x', NULL, NULL, NULL, NULL, NULL, ?, ?)
    `)
    insert.run('older-ready', 'completed', '2026-07-24T00:00:00.000Z', '2026-07-24T00:05:00.000Z')
    insert.run('chosen', 'adopted', '2026-07-24T00:01:00.000Z', '2026-07-24T00:06:00.000Z')
    insert.run('new-ready', 'completed', '2026-07-24T00:07:00.000Z', '2026-07-24T00:08:00.000Z')
    legacy.close()

    const migrated = new LocalStore(path)
    expect(migrated.getDream('a1', 'older-ready')).toMatchObject({
      status: 'superseded',
      endedAt: '2026-07-24T00:06:00.000Z'
    })
    expect(migrated.getDream('a1', 'new-ready')?.status).toBe('completed')
    expect(migrated.supersededDreams().map((dream) => dream.dreamId)).toEqual(['older-ready'])
    migrated.close()
  })

  it('round-trips per-cron last-run stamps (latest-wins)', () => {
    const s = store()
    expect(s.getCronLastRun('bot-a:daily')).toBeUndefined()
    s.setCronLastRun('bot-a:daily', 1000)
    s.setCronLastRun('bot-a:daily', 2000)
    s.setCronLastRun('bot-b:weekly', 1500)
    expect(s.getCronLastRun('bot-a:daily')).toBe(2000)
    expect(s.getCronLastRun('bot-b:weekly')).toBe(1500)
    s.close()
  })

  it('stores a bounded editor approval history and expires live requests after restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-permission-')), 'local.sqlite')
    const s = new LocalStore(path)
    s.createPermissionRequest({
      id: 'request-1',
      agentId: 'bot-a',
      sessionId: 'session-1',
      createdAt: 100,
      requesterId: 'user-1',
      requesterName: 'Ada',
      command: 'Bash: pnpm test',
      status: 'pending',
      resolvedAt: null
    })
    s.createPermissionRequest({
      id: 'request-2',
      agentId: 'bot-a',
      sessionId: 'session-1',
      createdAt: 200,
      requesterId: 'user-2',
      requesterName: 'Lin',
      command: 'Edit: app.ts',
      status: 'pending',
      resolvedAt: null
    })

    expect(s.resolvePermissionRequest('bot-a', 'request-2', 'allowed', 250)).toBe(true)
    expect(s.resolvePermissionRequest('bot-a', 'request-2', 'denied', 300)).toBe(false)
    expect(s.listPermissionRequests('bot-a')).toMatchObject([
      { id: 'request-1', status: 'pending', resolvedAt: null },
      { id: 'request-2', status: 'allowed', resolvedAt: 250 }
    ])
    s.close()

    const reopened = new LocalStore(path)
    expect(reopened.listPermissionRequests('bot-a')).toMatchObject([
      { id: 'request-2', status: 'allowed', resolvedAt: 250 },
      { id: 'request-1', status: 'expired' }
    ])
    reopened.close()
  })

  it('tracks channel-intro state per (agent, platform, channel) and integration seeding', () => {
    const s = store()
    expect(s.channelIntroSet('bot-a', 'slack')).toEqual(new Set())
    expect(s.isChannelIntroSeeded('int-1')).toBe(false)

    s.markChannelIntro('bot-a', 'slack', 'C1', null) // adopted as silent baseline
    s.markChannelIntro('bot-a', 'slack', 'C2', 123) // introduced-in
    s.markChannelIntroSeeded('int-1', 100)

    expect(s.channelIntroSet('bot-a', 'slack')).toEqual(new Set(['C1', 'C2']))
    expect(s.isChannelIntroSeeded('int-1')).toBe(true)
    // Scoped: another agent / platform / integration is unaffected.
    expect(s.channelIntroSet('bot-b', 'slack')).toEqual(new Set())
    expect(s.channelIntroSet('bot-a', 'telegram')).toEqual(new Set())
    expect(s.isChannelIntroSeeded('int-2')).toBe(false)

    // Idempotent: re-marking never duplicates or overwrites the original row.
    s.markChannelIntro('bot-a', 'slack', 'C1', 999)
    s.markChannelIntroSeeded('int-1', 999)
    expect(s.channelIntroSet('bot-a', 'slack')).toEqual(new Set(['C1', 'C2']))
    s.close()
  })

  it('supports both latest-wins and per-turn token accounting', () => {
    const s = store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    s.addTokenUsage(key, { totalTokens: 12, inputTokens: 10, outputTokens: 2 })
    s.addTokenUsage(key, { totalTokens: 9, inputTokens: 7, outputTokens: 2, cachedReadTokens: 3 })
    expect(s.getUsage(key)).toMatchObject({
      totalTokens: 21,
      inputTokens: 17,
      outputTokens: 4,
      cachedReadTokens: 3
    })
    s.setTokenUsage(key, { totalTokens: 30, inputTokens: 24, outputTokens: 6 })
    expect(s.getUsage(key)).toMatchObject({ totalTokens: 30, inputTokens: 24, outputTokens: 6 })
    s.close()
  })

  it('accumulates fallback cost and lets a runtime snapshot replace it', () => {
    const s = store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    expect(s.addCost(key, 0.1, 'USD')).toBe(true)
    expect(s.addCost(key, 0.2, 'USD')).toBe(true)
    expect(s.getUsage(key).costAmount).toBeCloseTo(0.3)
    expect(s.getUsage(key).costCurrency).toBe('USD')
    expect(s.addCost(key, 0.4, 'EUR')).toBe(false)

    s.setUsageSnapshot(key, { costAmount: 0.25, costCurrency: 'USD' })
    expect(s.getUsage(key)).toMatchObject({ costAmount: 0.25, costCurrency: 'USD' })
    s.close()
  })
})

describe('LocalStore session/transcript read-back (session/list, session/history)', () => {
  const seed = (s: LocalStore, key: string, agentId: string, acpSessionId: string | null, updatedAt: number) =>
    s.upsertSession({
      key,
      agentId,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt
    })

  it('listSessions excludes null-acpSessionId rows, filters by agent, orders updatedAt DESC', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    seed(s, 'k2', 'bot-a', 'acp-2', 300)
    seed(s, 'k3', 'bot-a', null, 999) // never launched → no acp id → excluded
    seed(s, 'k4', 'bot-b', 'acp-4', 200)
    // all agents: newest first, null acp dropped
    expect(s.listSessions().map((r) => r.acpSessionId)).toEqual(['acp-2', 'acp-4', 'acp-1'])
    // scoped to bot-a
    expect(s.listSessions('bot-a').map((r) => r.acpSessionId)).toEqual(['acp-2', 'acp-1'])
    s.close()
  })

  it('getSessionByAcpId returns the row on hit and undefined on miss', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(s.getSessionByAcpId('acp-1')?.key).toBe('k1')
    expect(s.getSessionByAcpId('nope')).toBeUndefined()
    s.close()
  })

  it('getSessionByAcpIdForAgent disambiguates runtime-local session ids', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'shared-acp-id', 100)
    seed(s, 'k2', 'bot-b', 'shared-acp-id', 200)
    expect(s.getSessionByAcpIdForAgent('bot-a', 'shared-acp-id')?.key).toBe('k1')
    expect(s.getSessionByAcpIdForAgent('bot-b', 'shared-acp-id')?.key).toBe('k2')
    expect(s.getSessionByAcpIdForAgent('bot-c', 'shared-acp-id')).toBeUndefined()
    s.close()
  })

  it('triggeredBy is first-wins across upserts and survives state-only rewrites', () => {
    const s = store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      triggeredBy: 'U-FIRST'
    })
    // A later turn's upsert (different sender, or a read-back row without the
    // field) must not steal / clear the original credit.
    s.upsertSession({ ...s.getSession(key)!, state: 'prompting', updatedAt: 2, triggeredBy: 'U-SECOND' })
    expect(s.getSession(key)?.triggeredBy).toBe('U-FIRST')
    expect(s.listSessions('bot-a')[0]?.triggeredBy).toBe('U-FIRST')
    s.close()
  })

  it('setSessionTitle: latest wins, null clears, survives upserts; unknown key is a no-op', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(s.getSession('k1')?.title).toBeNull() // fresh rows have no title
    s.setSessionTitle('k1', 'Fix the deploy script')
    expect(s.listSessions('bot-a')[0]?.title).toBe('Fix the deploy script')
    s.setSessionTitle('k1', 'Fix the deploy script (renamed)')
    expect(s.getSession('k1')?.title).toBe('Fix the deploy script (renamed)')
    // a session-state upsert (e.g. a new turn) must not clear the title
    s.upsertSession({ ...s.getSession('k1')!, state: 'prompting', updatedAt: 200 })
    expect(s.getSession('k1')?.title).toBe('Fix the deploy script (renamed)')
    // ACP semantics: an explicit null clears
    s.setSessionTitle('k1', null)
    expect(s.getSession('k1')?.title).toBeNull()
    // unknown key: no row created
    s.setSessionTitle('slack:C1:none:x', 'ghost')
    expect(s.getSession('slack:C1:none:x')).toBeUndefined()
    s.close()
  })

  it('adds the title column to a pre-existing sessions table (in-place migration)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mig-title-')), 'local.sqlite')
    // Hand-build the pre-title schema (post-usage/muted/triggeredBy vintage).
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE sessions (
      key TEXT PRIMARY KEY, agentId TEXT, platform TEXT, channel TEXT, thread TEXT,
      acpSessionId TEXT, state TEXT, lastDeliveredTs TEXT, updatedAt INTEGER,
      usage TEXT, muted INTEGER, triggeredBy TEXT
    )`)
    legacy
      .prepare('INSERT INTO sessions (key, agentId, acpSessionId, state, updatedAt) VALUES (?,?,?,?,?)')
      .run('k1', 'bot-a', 'acp-1', 'idle', 100)
    legacy.close()

    const s = new LocalStore(path)
    expect(s.getSession('k1')?.title).toBeNull() // legacy rows read back untitled
    s.setSessionTitle('k1', 'Migrated title')
    expect(s.listSessions()[0]?.title).toBe('Migrated title')
    s.close()
  })

  it('modelOverride: undefined until set, then persists across state upserts; unknown key no-op', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(s.getModelOverride('k1')).toBeUndefined()
    s.setModelOverride('k1', 'opus-4.8')
    expect(s.getModelOverride('k1')).toBe('opus-4.8')
    // a later turn's state-only upsert must not drop the override
    s.upsertSession({ ...s.getSession('k1')!, state: 'prompting', updatedAt: 200 })
    expect(s.getModelOverride('k1')).toBe('opus-4.8')
    s.setModelOverride('slack:C1:none:x', 'ghost')
    expect(s.getModelOverride('slack:C1:none:x')).toBeUndefined()
    s.close()
  })

  it('permissionModeOverride: undefined until set, then persists across state upserts; unknown key no-op', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(s.getPermissionModeOverride('k1')).toBeUndefined()
    s.setPermissionModeOverride('k1', 'plan')
    expect(s.getPermissionModeOverride('k1')).toBe('plan')
    // a later turn's state-only upsert must not drop the override
    s.upsertSession({ ...s.getSession('k1')!, state: 'prompting', updatedAt: 200 })
    expect(s.getPermissionModeOverride('k1')).toBe('plan')
    s.setPermissionModeOverride('slack:C1:none:x', 'ghost')
    expect(s.getPermissionModeOverride('slack:C1:none:x')).toBeUndefined()
    s.close()
  })

  it('clears every chat-authored runtime override without clearing output mode', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'acp-1', 100)
    s.setModelOverride('k1', 'opus-4.8')
    s.setEffortOverride('k1', 'high')
    s.setPermissionModeOverride('k1', 'plan')
    s.setFastModeOverride('k1', true)
    s.setOutputModeOverride('k1', 'high')

    s.clearRuntimeConfigOverrides('bot-a')

    expect(s.getModelOverride('k1')).toBeUndefined()
    expect(s.getEffortOverride('k1')).toBeUndefined()
    expect(s.getPermissionModeOverride('k1')).toBeUndefined()
    expect(s.getFastModeOverride('k1')).toBeUndefined()
    expect(s.getOutputModeOverride('k1')).toBe('high')
    s.close()
  })

  it('adds the modelOverride column to a pre-existing sessions table (in-place migration)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mig-mo-')), 'local.sqlite')
    // Hand-build the pre-modelOverride schema (post-title vintage).
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE sessions (
      key TEXT PRIMARY KEY, agentId TEXT, platform TEXT, channel TEXT, thread TEXT,
      acpSessionId TEXT, state TEXT, lastDeliveredTs TEXT, updatedAt INTEGER,
      usage TEXT, muted INTEGER, triggeredBy TEXT, title TEXT
    )`)
    legacy
      .prepare('INSERT INTO sessions (key, agentId, acpSessionId, state, updatedAt) VALUES (?,?,?,?,?)')
      .run('k1', 'bot-a', 'acp-1', 'idle', 100)
    legacy.close()

    const s = new LocalStore(path)
    expect(s.getModelOverride('k1')).toBeUndefined() // legacy rows have no override
    s.setModelOverride('k1', 'sonnet-5')
    expect(s.getModelOverride('k1')).toBe('sonnet-5')
    expect(s.getPermissionModeOverride('k1')).toBeUndefined()
    s.setPermissionModeOverride('k1', 'acceptEdits')
    expect(s.getPermissionModeOverride('k1')).toBe('acceptEdits')
    s.close()
  })

  it('display names: latest-wins upsert, batch lookup returns only known ids', () => {
    const s = store()
    s.setDisplayName('C1', 'general', 1)
    s.setDisplayName('U1', 'Dana Reyes', 1)
    s.setDisplayName('C1', 'general-renamed', 2)
    const names = s.getDisplayNames(['C1', 'U1', 'U-unknown'])
    expect(names.get('C1')).toBe('general-renamed')
    expect(names.get('U1')).toBe('Dana Reyes')
    expect(names.has('U-unknown')).toBe(false)
    expect(s.getDisplayNames([]).size).toBe(0)
    s.close()
  })

  it('profile avatars: latest-wins upsert, batch lookup returns only known ids', () => {
    const s = store()
    s.setProfileAvatar('slack:one', 'bad', 'not-a-url', 1)
    s.setProfileAvatar('slack:one', 'U1', 'https://avatars.example.test/old.png', 1)
    s.setProfileAvatar('slack:one', 'U1', 'https://avatars.example.test/new.png', 2)
    s.setProfileAvatar('slack:two', 'U1', 'https://avatars.example.test/other.png', 2)
    const avatars = s.getProfileAvatars('slack:one', ['U1', 'U-unknown'])
    expect(avatars.get('U1')).toBe('https://avatars.example.test/new.png')
    expect(avatars.has('U-unknown')).toBe(false)
    expect(s.getProfileAvatars('slack:two', ['U1']).get('U1')).toBe('https://avatars.example.test/other.png')
    expect(s.getProfileAvatars('slack:one', ['bad']).size).toBe(0)
    expect(s.getProfileAvatars('slack:one', []).size).toBe(0)
    s.close()
  })

  it('channel scopes: latest-wins, batch lookup returns only known ids', () => {
    const s = store()
    s.setChannelScope('T1', { parentId: 'C1' }, 1)
    s.setChannelScope('T2', { parentId: 'C1' }, 2)
    // A moved thread re-parents (latest-wins).
    s.setChannelScope('T1', { parentId: 'C2' }, 3)
    const scopes = s.getChannelScopes(['T1', 'T2', 'unknown'])
    expect(scopes.get('T1')).toEqual({ parentId: 'C2' })
    expect(scopes.get('T2')).toEqual({ parentId: 'C1' })
    expect(scopes.has('unknown')).toBe(false)
    // An empty note writes no row at all.
    s.setChannelScope('T9', {}, 4)
    expect(s.getChannelScopes(['T9']).size).toBe(0)
    expect(s.getChannelScopes([]).size).toBe(0)
    s.close()
  })

  it('observedChannels/observedUsers: distinct per physical bot, newest-first, name-joined', () => {
    const s = store()
    const sess = (
      key: string,
      platform: string,
      channel: string,
      triggeredBy: string,
      updatedAt: number,
      transportScope: string | null = 'bot-scope-a'
    ) =>
      s.upsertSession({
        key,
        agentId: 'bot-a',
        platform,
        channel,
        thread: 't',
        transportScope,
        acpSessionId: null,
        state: 'idle',
        lastDeliveredTs: null,
        triggeredBy,
        updatedAt
      })
    sess('k1', 'telegram', '-100', 'U1', 1)
    sess('k2', 'telegram', '55', 'U1', 3) // same user, newer; distinct channel
    sess('k3', 'telegram', '-100', 'U2', 2) // same channel as k1, newer than k1
    sess('k4', 'slack', 'C9', 'U9', 5) // different platform — excluded
    sess('k5', 'telegram', '-999', 'U9', 9, 'bot-scope-b') // different physical bot — excluded
    sess('k6', 'telegram', '-legacy', 'U8', 8, null) // legacy unknown bot — excluded
    s.setDisplayName('-100', 'team chat', 1)
    s.setDisplayName('55', '@bob', 1)

    const chans = s.observedChannels('bot-a', 'telegram', 'bot-scope-a')
    // Distinct channels, newest-first by their latest session (55@3 before -100@2), names joined.
    expect(chans).toEqual([
      { id: '55', name: '@bob' },
      { id: '-100', name: 'team chat' }
    ])
    // Slack session's channel is not in the Telegram set.
    expect(chans.find((c) => c.id === 'C9')).toBeUndefined()

    const users = s.observedUsers('bot-a', 'telegram', 'bot-scope-a')
    expect(users).toEqual([
      { id: 'U1', name: null }, // U1's latest session @3 (no display name → null)
      { id: 'U2', name: null }
    ])
    expect(s.observedUsers('bot-a', 'discord', 'bot-scope-a')).toEqual([])
    s.close()
  })

  it('transcriptPage returns newest-first, paginates via beforeSeq, and reports hasMore', () => {
    const s = store()
    // seq is AUTOINCREMENT → insertion order 1..4
    for (const ts of ['1', '2', '3', '4']) {
      s.appendTranscript({ channel: 'C1', thread: 'T', ts, sender: 'U', kind: 'text', text: `m${ts}` })
    }
    // A title-tool row persisted by an older daemon is internal housekeeping. It must
    // not consume page slots or surface after that daemon upgrades.
    s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '5',
      sender: 'bot-a',
      toolCallId: 'title-tool',
      title: 'mcp.agentconnect.setSessionTitle',
      body: JSON.stringify({
        toolCallId: 'title-tool',
        rawInput: { server: 'agentconnect', tool: 'setSessionTitle', arguments: { title: 'Hidden' } }
      })
    })
    // newest page of 2: seq 4,3 (DESC), more older rows remain
    const page1 = s.transcriptPage('C1', 'T', null, 2)
    expect(page1.rows.map((r) => r.text)).toEqual(['m4', 'm3'])
    expect(page1.hasMore).toBe(true)
    // next page strictly older than seq 3: seq 2,1 — last page, no more
    const lowest = page1.rows[page1.rows.length - 1]!.seq
    const page2 = s.transcriptPage('C1', 'T', lowest, 2)
    expect(page2.rows.map((r) => r.text)).toEqual(['m2', 'm1'])
    expect(page2.hasMore).toBe(false)
    // beforeSeq is exclusive (seq >= beforeSeq excluded)
    expect(s.transcriptPage('C1', 'T', 2, 10).rows.map((r) => r.text)).toEqual(['m1'])
    s.close()
  })

  it('keeps a session-local tool id isolated between agents sharing a thread', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-tool-owner-mig-')), 'local.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        sender TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        tool_call_id TEXT, body TEXT, recipient TEXT, eventTimeUs INTEGER,
        attachmentsJson TEXT
      );
      CREATE UNIQUE INDEX transcript_tool_call
        ON transcript (channel, thread, tool_call_id) WHERE tool_call_id IS NOT NULL;
    `)
    legacy.close()

    // Opening the upgraded store replaces the old thread-wide identity.
    const s = new LocalStore(path)
    const toolCallId = 'session-local-tc'
    const aBody = JSON.stringify({ toolCallId, rawOutput: 'agent-a output' })
    const bInitial = JSON.stringify({ toolCallId, rawOutput: 'agent-b partial' })
    const bFinal = JSON.stringify({ toolCallId, rawOutput: 'agent-b final' })
    s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'bot-a',
      toolCallId,
      title: 'agent-a tool',
      body: aBody
    })
    s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '2',
      sender: 'bot-b',
      toolCallId,
      title: 'agent-b tool',
      body: bInitial
    })
    s.updateToolCall('C1', 'T', 'bot-b', toolCallId, { title: 'agent-b done', body: bFinal })

    expect(s.getToolBodyForAgent('C1', 'T', 'bot-a', toolCallId)).toBe(aBody)
    expect(s.getToolBodyForAgent('C1', 'T', 'bot-b', toolCallId)).toBe(bFinal)
    s.close()
  })

  it('transcriptPageForAgent scopes to what THAT agent received or produced (no peer cross-talk)', () => {
    const s = store()
    // Delivered to bot-a + bot-a's own reply.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'to-a'
    })
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '2', sender: 'bot-a', kind: 'text', text: 'a-reply' })
    // Delivered to bot-b + bot-b's own reply.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '3',
      sender: 'U1',
      recipient: 'bot-b',
      kind: 'text',
      text: 'to-b'
    })
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4', sender: 'bot-b', kind: 'text', text: 'b-reply' })
    // bot-b's PRIVATE reasoning (sender=bot-b, no recipient) — must NOT leak into bot-a's view.
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '5', sender: 'bot-b', kind: 'reasoning', text: 'b-thinks' })
    // bot-a owns this legacy row, so the agent scope alone would include it. The
    // internal-housekeeping filter must still remove it from console history.
    s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '6',
      sender: 'bot-a',
      toolCallId: 'title-tool',
      title: 'mcp.agentconnect.setSessionTitle',
      body: JSON.stringify({ toolCallId: 'title-tool' })
    })

    expect(
      s
        .transcriptPageForAgent('C1', 'T', 'bot-a', null, 50)
        .rows.map((r) => r.text)
        .reverse()
    ).toEqual(['to-a', 'a-reply'])
    expect(
      s
        .transcriptPageForAgent('C1', 'T', 'bot-b', null, 50)
        .rows.map((r) => r.text)
        .reverse()
    ).toEqual(['to-b', 'b-reply', 'b-thinks'])
    s.close()
  })

  it('transcriptPageForAgent shows a shared message to EVERY agent it was delivered to (dedup survival)', () => {
    const s = store()
    // A shared thread message that both agents catch up on. The second appendTranscript is
    // deduped by the (channel, thread, ts) unique index, so the row keeps recipient='bot-a'
    // — but the delivery to 'bot-b' must still be recorded so bot-b's view shows it.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'shared'
    })
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-b',
      kind: 'text',
      text: 'shared'
    })

    expect(s.transcriptPageForAgent('C1', 'T', 'bot-a', null, 50).rows.map((r) => r.text)).toEqual(['shared'])
    expect(s.transcriptPageForAgent('C1', 'T', 'bot-b', null, 50).rows.map((r) => r.text)).toEqual(['shared'])
    // A third agent it was never delivered to does not see it.
    expect(s.transcriptPageForAgent('C1', 'T', 'bot-c', null, 50).rows.map((r) => r.text)).toEqual([])
    s.close()
  })

  it('does not pull in a peer non-text row that shares a ts with a delivered text message', () => {
    const s = store()
    // A text message delivered to bot-a at ts='7'.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '7',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'to-a'
    })
    // A peer's PRIVATE reasoning that happens to share ts='7' (internal rows aren't ts-deduped,
    // so a collision is possible). The delivery match is keyed by ts, so it must be gated to
    // text rows or this peer row would leak into bot-a's view.
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '7', sender: 'bot-b', kind: 'reasoning', text: 'b-secret' })

    const aRows = s.transcriptPageForAgent('C1', 'T', 'bot-a', null, 50).rows
    expect(aRows.map((r) => r.text)).toEqual(['to-a'])
    expect(aRows.some((r) => r.text === 'b-secret')).toBe(false)
    s.close()
  })
})

describe('LocalStore session lifecycle (§7.3/#111/#118)', () => {
  const seed = (s: LocalStore, key: string, agentId: string, state: 'idle' | 'prompting', updatedAt: number) =>
    s.upsertSession({
      key,
      agentId,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId: 'acp-' + key,
      state,
      lastDeliveredTs: null,
      updatedAt
    })

  it('setSessionState transitions an existing row and stamps updatedAt', () => {
    const s = store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    seed(s, key, 'bot-a', 'prompting', 100)
    s.setSessionState(key, 'idle', 500)
    const got = s.getSession(key)
    expect(got?.state).toBe('idle')
    expect(got?.updatedAt).toBe(500)
    // unknown key is a no-op (row created later by the SessionManager)
    s.setSessionState('slack:C1:none:x', 'idle', 1)
    expect(s.getSession('slack:C1:none:x')).toBeUndefined()
    s.close()
  })

  it('agentLastActivityTs is the max updatedAt across an agent non-closed sessions', () => {
    const s = store()
    seed(s, 'k1', 'bot-a', 'idle', 100)
    seed(s, 'k2', 'bot-a', 'prompting', 300)
    seed(s, 'k3', 'bot-b', 'idle', 999)
    expect(s.agentLastActivityTs('bot-a')).toBe(300)
    expect(s.agentLastActivityTs('nobody')).toBeNull()
    // a closed session no longer counts toward activity
    s.setSessionState('k2', 'closed', 300)
    expect(s.agentLastActivityTs('bot-a')).toBe(100)
    s.close()
  })

  it('setSessionMuted persists a cold !stop tombstone across reopen and later session creation', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mute-')), 'local.sqlite')
    let s = new LocalStore(path)
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    expect(s.getSession(key)).toBeUndefined()
    expect(s.isSessionMuted(key)).toBe(false)
    s.setSessionMuted(key, true)
    expect(s.isSessionMuted(key)).toBe(true)
    expect(s.getSession(key)).toBeUndefined()
    s.close()

    // A daemon restart before SessionManager creates the row must retain the mute.
    s = new LocalStore(path)
    expect(s.isSessionMuted(key)).toBe(true)
    // Creating/upserting the actual session mirrors but never overwrites the tombstone.
    seed(s, key, 'bot-a', 'idle', 100)
    expect(s.getSession(key)?.muted).toBe(1)
    seed(s, key, 'bot-a', 'prompting', 200)
    expect(s.isSessionMuted(key)).toBe(true)
    s.setSessionMuted(key, false)
    expect(s.isSessionMuted(key)).toBe(false)
    s.close()

    const reopened = new LocalStore(path)
    expect(reopened.isSessionMuted(key)).toBe(false)
    expect(reopened.getSession(key)?.muted).toBe(0)
    reopened.close()
  })

  it('backfills legacy sessions.muted rows into tombstones without resurrecting a cleared mute', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mute-migrate-')), 'local.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE sessions (
        key TEXT PRIMARY KEY, agentId TEXT, platform TEXT, channel TEXT, thread TEXT,
        acpSessionId TEXT, state TEXT, lastDeliveredTs TEXT, updatedAt INTEGER,
        usage TEXT, muted INTEGER, triggeredBy TEXT
      )
    `)
    legacy
      .prepare(
        'INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, lastDeliveredTs, updatedAt, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('legacy-muted', 'bot-a', 'slack', 'C1', 'T1', null, 'idle', null, 1, 1)
    legacy.close()

    let s = new LocalStore(path)
    expect(s.isSessionMuted('legacy-muted')).toBe(true)
    s.setSessionMuted('legacy-muted', false)
    s.close()

    s = new LocalStore(path)
    expect(s.isSessionMuted('legacy-muted')).toBe(false)
    s.close()
  })

  it('closeIdleSessions closes only idle rows past the TTL, leaving prompting alone', () => {
    const s = store()
    seed(s, 'old-idle', 'bot-a', 'idle', 100)
    seed(s, 'fresh-idle', 'bot-a', 'idle', 900)
    seed(s, 'old-prompting', 'bot-a', 'prompting', 100) // a live turn keeps the thread open
    const closed = s.closeIdleSessions(1000, 500) // cutoff = 500
    expect(closed.map((r) => r.key)).toEqual(['old-idle'])
    expect(closed[0]).toMatchObject({
      key: 'old-idle',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'old-idle',
      acpSessionId: 'acp-old-idle'
    })
    expect(s.getSession('old-idle')?.state).toBe('closed')
    expect(s.getSession('fresh-idle')?.state).toBe('idle')
    expect(s.getSession('old-prompting')?.state).toBe('prompting')
    s.close()
  })

  it('closeIdleSessions spares a session the isExempt predicate keeps (background work in flight)', () => {
    const s = store()
    seed(s, 'busy', 'bot-a', 'idle', 100) // idle + past TTL, but has live background work
    seed(s, 'done', 'bot-a', 'idle', 100) // idle + past TTL, quiescent
    // Exempt the one whose acpSessionId is still working.
    const closed = s.closeIdleSessions(1000, 500, (_agentId, acpSessionId) => acpSessionId === 'acp-busy')
    expect(closed.map((r) => r.key)).toEqual(['done'])
    expect(s.getSession('busy')?.state).toBe('idle') // spared
    expect(s.getSession('done')?.state).toBe('closed') // closed as usual
    s.close()
  })

  it('openSessionAgents excludes closed rows; closedSessionAgents returns exactly them', () => {
    const s = store()
    // Seed with real (channel, thread) coords — the shared `seed` above stores
    // thread=key, which would defeat a per-thread query.
    const put = (agentId: string, thread: string, state: 'idle' | 'closed') =>
      s.upsertSession({
        key: sessionKey('slack', 'C1', thread, agentId),
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread,
        acpSessionId: `acp-${agentId}-${thread}`,
        state,
        lastDeliveredTs: null,
        updatedAt: 100
      })
    // Two agents once active in thread T1; plus a live session in T2 (scoping check).
    put('bot-a', 'T1', 'idle')
    put('bot-b', 'T1', 'idle')
    put('bot-a', 'T2', 'idle')
    expect(s.openSessionAgents('C1', 'T1').sort()).toEqual(['bot-a', 'bot-b'])
    expect(s.closedSessionAgents('C1', 'T1')).toEqual([])

    s.setSessionState(sessionKey('slack', 'C1', 'T1', 'bot-a'), 'closed', 200)
    expect(s.openSessionAgents('C1', 'T1')).toEqual(['bot-b'])
    expect(s.closedSessionAgents('C1', 'T1')).toEqual(['bot-a'])

    s.setSessionState(sessionKey('slack', 'C1', 'T1', 'bot-b'), 'closed', 200)
    expect(s.openSessionAgents('C1', 'T1')).toEqual([])
    expect(s.closedSessionAgents('C1', 'T1').sort()).toEqual(['bot-a', 'bot-b'])
    // T2 stays live and unaffected.
    expect(s.openSessionAgents('C1', 'T2')).toEqual(['bot-a'])
    expect(s.closedSessionAgents('C1', 'T2')).toEqual([])
    s.close()
  })
})

describe('LocalStore session retention GC (#485)', () => {
  const seed = (
    s: LocalStore,
    key: string,
    state: 'idle' | 'prompting' | 'cancelling' | 'resuming' | 'closed',
    updatedAt: number,
    acpSessionId: string | null = 'acp-' + key
  ) =>
    s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId,
      state,
      lastDeliveredTs: null,
      updatedAt
    })

  it('listExpiredSessions returns idle/closed rows past the cutoff oldest-first, including unbound ones', () => {
    const s = store()
    seed(s, 'old-closed', 'closed', 200)
    seed(s, 'older-idle', 'idle', 100)
    seed(s, 'never-bound', 'closed', 150, null) // no ACP id, still a candidate (may own a worktree)
    seed(s, 'fresh-closed', 'closed', 900)
    seed(s, 'old-prompting', 'prompting', 100) // live turn — never a candidate
    seed(s, 'old-resuming', 'resuming', 100) // re-attaching — never a candidate
    expect(s.listExpiredSessions(500).map((r) => r.key)).toEqual(['older-idle', 'never-bound', 'old-closed'])
    s.close()
  })

  it('sessionHasPendingInboxRows counts admitted work, not terminal hook receipts', () => {
    const s = store()
    // A completed hook receipt (dedup row) must not pin the session forever —
    // hook-triggered review sessions are exactly what #485 collects.
    s.appendInbox({
      id: 'receipt',
      sessionKey: 'k',
      agentId: 'bot-a',
      msg: '{}',
      completedAt: 50,
      enqueuedAt: '0000000001'
    })
    expect(s.sessionHasPendingInboxRows('k')).toBe(false)
    s.appendInbox({ id: 'queued', sessionKey: 'k', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000002' })
    expect(s.sessionHasPendingInboxRows('k')).toBe(true)
    s.close()
  })

  it('deleteSession removes the row and its mute/inbox/gate/permission cascades, keeping transcripts', () => {
    const s = store()
    seed(s, 'gone', 'closed', 100)
    s.setSessionMuted('gone', true)
    s.setLocalCaptureGate('acp-gone', true)
    s.appendInbox({ id: 'm1', sessionKey: 'gone', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000001' })
    // An unacknowledged terminal hook report is an outbox toward the CP and must
    // survive the session delete (same rule as removeInboxByAgentId).
    s.appendInbox({
      id: 'm1-report',
      sessionKey: 'gone',
      agentId: 'bot-a',
      msg: '{}',
      completedAt: 90,
      terminalReport: '{"outcome":"done"}',
      enqueuedAt: '0000000002'
    })
    s.createPermissionRequest({
      id: 'p1',
      agentId: 'bot-a',
      sessionId: 'acp-gone',
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'rm -rf /tmp/x',
      status: 'pending',
      resolvedAt: null
    })
    // ACP session ids are runtime-local: another agent's identically named
    // session must keep its permission history.
    s.createPermissionRequest({
      id: 'p2',
      agentId: 'bot-b',
      sessionId: 'acp-gone',
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'ls',
      status: 'pending',
      resolvedAt: null
    })
    // Thread history is (channel, thread)-scoped and shared — it must survive.
    s.appendTranscript({ channel: 'C1', thread: 'gone', ts: '1.1', sender: 'u1', kind: 'text', text: 'hello' })
    expect(s.sessionHasPendingInboxRows('gone')).toBe(true)

    expect(s.deleteSession('gone')).toBe(true)

    expect(s.getSession('gone')).toBeUndefined()
    expect(s.isSessionMuted('gone')).toBe(false)
    expect(s.sessionHasPendingInboxRows('gone')).toBe(false)
    expect(s.listInboxBySessionKeyFifo().map((r) => r.id)).toEqual(['m1-report'])
    expect(s.listPermissionRequests('bot-a')).toEqual([])
    expect(s.listPermissionRequests('bot-b').map((r) => r.id)).toEqual(['p2'])
    // The gate row is gone: an unknown session falls back to excluded-by-default.
    expect(s.transcriptSince('C1', 'gone', null).map((r) => r.text)).toEqual(['hello'])
    // Idempotent: a second delete (or an unknown key) reports false, not an error.
    expect(s.deleteSession('gone')).toBe(false)
    s.close()
  })

  it('deleteSession keeps a capture gate another agent still references through the same ACP id', () => {
    const s = store()
    // ACP session ids are runtime-local: bot-a and bot-b can both hold `acp-shared`.
    const put = (key: string, agentId: string) =>
      s.upsertSession({
        key,
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread: key,
        acpSessionId: 'acp-shared',
        state: 'closed',
        lastDeliveredTs: null,
        updatedAt: 100
      })
    put('a', 'bot-a')
    put('b', 'bot-b')
    s.setLocalCaptureGate('acp-shared', false) // capture open (not excluded)
    expect(s.isCaptureExcluded('acp-shared')).toBe(false)

    // bot-a's session expires first: bot-b still references the id — gate survives.
    expect(s.deleteSession('a')).toBe(true)
    expect(s.isCaptureExcluded('acp-shared')).toBe(false)

    // The last referencing session goes: the gate is finally collected too.
    expect(s.deleteSession('b')).toBe(true)
    expect(s.isCaptureExcluded('acp-shared')).toBe(true) // no row ⇒ excluded-by-default
    s.close()
  })

  it('deleteSession leaves unrelated sessions and their dependents alone', () => {
    const s = store()
    seed(s, 'gone', 'closed', 100)
    seed(s, 'kept', 'closed', 100)
    s.setSessionMuted('kept', true)
    s.appendInbox({ id: 'm2', sessionKey: 'kept', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000002' })
    s.deleteSession('gone')
    expect(s.getSession('kept')).toBeDefined()
    expect(s.isSessionMuted('kept')).toBe(true)
    expect(s.sessionHasPendingInboxRows('kept')).toBe(true)
    s.close()
  })

  it('deleteSession records the CP-owed purge receipt in the same transaction', () => {
    const s = store()
    seed(s, 'gone', 'closed', 100)
    // A session that never bound an ACP id was never reported to the CP, so there
    // is no metadata row to mark and no receipt to keep.
    seed(s, 'unbound', 'closed', 100, null)

    s.deleteSession('gone', { reason: 'retention', at: 1_700 })
    s.deleteSession('unbound', { reason: 'retention', at: 1_800 })

    expect(s.listSessionPurges(10)).toEqual([
      { agentId: 'bot-a', sessionId: 'acp-gone', reason: 'retention', purgedAt: 1_700 }
    ])
    s.close()
  })

  it('a purge receipt survives until acknowledged, and only for the reported agent', () => {
    const s = store()
    seed(s, 'a', 'closed', 100)
    s.upsertSession({
      key: 'b',
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: 'b',
      // ACP ids are runtime-local: two agents can each have purged an `acp-1`.
      acpSessionId: 'acp-a',
      state: 'closed',
      lastDeliveredTs: null,
      updatedAt: 100
    })
    s.deleteSession('a', { reason: 'retention', at: 100 })
    s.deleteSession('b', { reason: 'retention', at: 200 })
    expect(s.listSessionPurges(10)).toHaveLength(2)

    s.acknowledgeSessionPurges('bot-a', ['acp-a'])
    expect(s.listSessionPurges(10)).toEqual([
      { agentId: 'bot-b', sessionId: 'acp-a', reason: 'retention', purgedAt: 200 }
    ])
    s.close()
  })

  it('pruneSessionPurges drops only receipts older than the cutoff and reports the count', () => {
    const s = store()
    seed(s, 'old', 'closed', 100)
    seed(s, 'recent', 'closed', 100)
    s.deleteSession('old', { reason: 'retention', at: 100 })
    s.deleteSession('recent', { reason: 'retention', at: 900 })

    expect(s.pruneSessionPurges(500)).toBe(1)
    expect(s.listSessionPurges(10).map((row) => row.sessionId)).toEqual(['acp-recent'])
    expect(s.pruneSessionPurges(500)).toBe(0)
    s.close()
  })
})

describe('LocalStore runtime model-catalog cache (runtime-model-catalog.md §4)', () => {
  const meta = (runtimeId: string, fingerprint: string, observedAt = 100) => ({
    runtimeId,
    fingerprint,
    source: 'acp' as const,
    defaultModel: 'opus',
    permissionModes: [{ value: 'default', name: 'Default' }],
    observedAt
  })
  const cap = (runtimeId: string, modelId: string, observedAt = 100) => ({
    runtimeId,
    modelId,
    fingerprint: 'fp-1',
    caps: { name: modelId, efforts: [{ value: 'high', name: 'High' }], defaultEffort: 'high', fastMode: true },
    observedAt
  })

  it('round-trips defaultPermissionMode (absent stays absent)', () => {
    const s = store()
    s.recordRuntimeCatalogMeta({ ...meta('copilot', 'fp-1'), defaultPermissionMode: 'agent' })
    expect(s.getRuntimeCatalogMeta('copilot')?.defaultPermissionMode).toBe('agent')
    s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    expect(s.getRuntimeCatalogMeta('claude')).not.toHaveProperty('defaultPermissionMode')
  })

  it('round-trips catalog meta and per-model capability rows', () => {
    const s = store()
    expect(s.getRuntimeCatalogMeta('claude')).toBeUndefined()
    expect(s.listRuntimeCatalogMetas()).toEqual([])
    expect(s.listRuntimeModelCaps()).toEqual([])

    s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    s.upsertRuntimeModelCap(cap('claude', 'opus'))
    s.upsertRuntimeModelCap(cap('claude', 'sonnet'))
    s.upsertRuntimeModelCap({ ...cap('codex', 'gpt'), caps: {} })

    // A phase-1 meta write is never complete and carries no modelsHash — both keys
    // are absent (not null) on read-back.
    expect(s.getRuntimeCatalogMeta('claude')).toEqual({
      runtimeId: 'claude',
      fingerprint: 'fp-1',
      source: 'acp',
      defaultModel: 'opus',
      permissionModes: [{ value: 'default', name: 'Default' }],
      complete: false,
      observedAt: 100
    })
    expect(s.listRuntimeCatalogMetas().map((m) => m.runtimeId)).toEqual(['claude'])
    expect(s.listRuntimeModelCaps('claude').map((c) => c.modelId)).toEqual(['opus', 'sonnet'])
    expect(s.listRuntimeModelCaps('claude')[0]?.caps).toEqual({
      name: 'opus',
      efforts: [{ value: 'high', name: 'High' }],
      defaultEffort: 'high',
      fastMode: true
    })
    // Unscoped list spans runtimes; empty caps round-trip as {}.
    expect(s.listRuntimeModelCaps().map((c) => `${c.runtimeId}:${c.modelId}`)).toEqual([
      'claude:opus',
      'claude:sonnet',
      'codex:gpt'
    ])
    expect(s.listRuntimeModelCaps('codex')[0]?.caps).toEqual({})

    // Latest-wins upsert on (runtimeId, modelId).
    s.upsertRuntimeModelCap({ ...cap('claude', 'opus', 999), fingerprint: 'fp-2', caps: { fastMode: false } })
    const opus = s.listRuntimeModelCaps('claude').find((c) => c.modelId === 'opus')
    expect(opus).toMatchObject({ fingerprint: 'fp-2', observedAt: 999 })
    expect(opus?.caps).toEqual({ fastMode: false })
    s.close()
  })

  it('recordRuntimeCatalogMeta preserves complete/modelsHash on the same fingerprint, resets on change', () => {
    const s = store()
    s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    s.markRuntimeCatalogComplete('claude', 'fp-1', 'hash-1', 200)
    expect(s.getRuntimeCatalogMeta('claude')).toMatchObject({ complete: true, modelsHash: 'hash-1', observedAt: 200 })

    // A phase-1 re-write on the SAME generation must neither satisfy nor re-open the
    // discovery gate: complete/modelsHash survive while the mutable fields update.
    s.recordRuntimeCatalogMeta({ ...meta('claude', 'fp-1', 300), defaultModel: 'sonnet' })
    expect(s.getRuntimeCatalogMeta('claude')).toMatchObject({
      complete: true,
      modelsHash: 'hash-1',
      defaultModel: 'sonnet',
      observedAt: 300
    })

    // An adapter upgrade (new fingerprint) re-opens the gate.
    s.recordRuntimeCatalogMeta(meta('claude', 'fp-2', 400))
    const reset = s.getRuntimeCatalogMeta('claude')
    expect(reset).toMatchObject({ fingerprint: 'fp-2', complete: false, observedAt: 400 })
    expect(reset?.modelsHash).toBeUndefined()
    s.close()
  })

  it('markRuntimeCatalogComplete is fenced by fingerprint (stale discovery cannot close a new generation)', () => {
    const s = store()
    s.recordRuntimeCatalogMeta(meta('claude', 'fp-2'))
    s.markRuntimeCatalogComplete('claude', 'fp-1', 'stale-hash', 999) // old-generation straggler
    expect(s.getRuntimeCatalogMeta('claude')).toMatchObject({ complete: false, observedAt: 100 })
    expect(s.getRuntimeCatalogMeta('claude')?.modelsHash).toBeUndefined()
    s.markRuntimeCatalogComplete('claude', 'fp-2', 'hash-2', 500)
    expect(s.getRuntimeCatalogMeta('claude')).toMatchObject({ complete: true, modelsHash: 'hash-2', observedAt: 500 })
    // Unknown runtime: no row created.
    s.markRuntimeCatalogComplete('ghost', 'fp', 'h', 1)
    expect(s.getRuntimeCatalogMeta('ghost')).toBeUndefined()
    s.close()
  })

  it('pruneRuntimeModelCaps keeps only the listed ids, scoped to one runtime', () => {
    const s = store()
    for (const id of ['opus', 'sonnet', 'haiku']) s.upsertRuntimeModelCap(cap('claude', id))
    s.upsertRuntimeModelCap(cap('codex', 'gpt'))
    s.pruneRuntimeModelCaps('claude', ['opus', 'haiku'])
    expect(s.listRuntimeModelCaps('claude').map((c) => c.modelId)).toEqual(['haiku', 'opus'])
    expect(s.listRuntimeModelCaps('codex').map((c) => c.modelId)).toEqual(['gpt'])
    // An empty keep-set clears the runtime's rows entirely.
    s.pruneRuntimeModelCaps('claude', [])
    expect(s.listRuntimeModelCaps('claude')).toEqual([])
    expect(s.listRuntimeModelCaps('codex')).toHaveLength(1)
    s.close()
  })

  it('gcRuntimeCatalog drops rows older than the cutoff from both tables', () => {
    const s = store()
    s.recordRuntimeCatalogMeta(meta('old-rt', 'fp-old', 100))
    s.recordRuntimeCatalogMeta(meta('fresh-rt', 'fp-new', 900))
    s.upsertRuntimeModelCap(cap('old-rt', 'm1', 100))
    s.upsertRuntimeModelCap(cap('fresh-rt', 'm2', 900))
    s.gcRuntimeCatalog(500)
    expect(s.getRuntimeCatalogMeta('old-rt')).toBeUndefined()
    expect(s.getRuntimeCatalogMeta('fresh-rt')).toBeDefined()
    expect(s.listRuntimeModelCaps().map((c) => c.runtimeId)).toEqual(['fresh-rt'])
    s.close()
  })

  it('finds a pending skill proposal behind many skill-bearing dreams', () => {
    // The proposed filter must be IN the query: rows whose candidates are all
    // accepted/dismissed (or empty) must not consume the scan window, or one
    // genuinely pending older proposal ages out permanently.
    const s = store()
    const base = {
      agentId: 'a1',
      status: 'adopted' as const,
      trigger: 'manual' as const,
      sessionIds: [],
      snapshotDigest: 'sha256:x'
    }
    // The pending one is the OLDEST.
    s.insertDream({
      ...base,
      dreamId: 'drm-pending',
      createdAt: '2020-01-01T00:00:00.000Z',
      skills: [{ name: 'deploy-staging', description: 'd', state: 'proposed' }]
    })
    // …buried behind 600 newer dreams that all carry skills, none pending.
    for (let i = 0; i < 600; i++) {
      s.insertDream({
        ...base,
        dreamId: `drm-${i}`,
        createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        skills: [{ name: `done-${i}`, description: 'd', state: i % 2 ? 'accepted' : 'dismissed' }]
      })
    }

    const pending = s.pendingSkillDreams('a1', 50)
    expect(pending.map((d) => d.dreamId)).toEqual(['drm-pending'])
    s.close()
  })
})

describe('LocalStore webchat MCP grant ledger', () => {
  const tuple = {
    conversationId: 'conv-1',
    agentId: 'agent-1',
    authorityId: 'auth-1',
    authorityGeneration: 3
  }

  it('tracks active grants and queues durable revocations', () => {
    const s = store()
    s.recordWebchatMcpGrant({ ...tuple, now: 10 })
    expect(s.listDueWebchatMcpRevocations(100)).toEqual([])

    s.markWebchatMcpGrantRevoking({ ...tuple, reason: 'agent_detached', now: 20 })
    const due = s.listDueWebchatMcpRevocations(20)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ ...tuple, state: 'revoking', reason: 'agent_detached', attempts: 0 })

    s.retryWebchatMcpRevocation('conv-1', 'auth-1', 3, 500, 30)
    expect(s.listDueWebchatMcpRevocations(100)).toEqual([])
    expect(s.listDueWebchatMcpRevocations(500)[0]).toMatchObject({ attempts: 1 })

    s.clearWebchatMcpGrant('conv-1', 'auth-1', 3)
    expect(s.listDueWebchatMcpRevocations(10_000)).toEqual([])
    s.close()
  })

  it('re-provisioning cancels a queued revocation, and exact-tuple fences protect newer authorities', () => {
    const s = store()
    s.markWebchatMcpGrantRevoking({ ...tuple, reason: 'session_expired', now: 10 })
    // Conversation resumes: the CP re-validated the authority; the stale revoke must not fire.
    s.recordWebchatMcpGrant({ ...tuple, authorityGeneration: 4, now: 20 })
    expect(s.listDueWebchatMcpRevocations(10_000)).toEqual([])

    // A late clear/downgrade for the OLD tuple must not touch the newer active row.
    s.clearWebchatMcpGrant('conv-1', 'auth-1', 3)
    s.markWebchatMcpGrantRevoking({ ...tuple, authorityGeneration: 4, reason: 'session_closed', now: 30 })
    expect(s.listDueWebchatMcpRevocations(30)[0]).toMatchObject({ authorityGeneration: 4 })
    s.close()
  })

  it('marks all leftover active grants revoking on the startup orphan sweep', () => {
    const s = store()
    s.recordWebchatMcpGrant({ ...tuple, now: 10 })
    s.recordWebchatMcpGrant({ ...tuple, conversationId: 'conv-2', now: 10 })
    expect(s.markAllWebchatMcpGrantsRevoking('session_closed', 50)).toBe(2)
    const due = s.listDueWebchatMcpRevocations(50)
    expect(due.map((r) => r.conversationId).sort()).toEqual(['conv-1', 'conv-2'])
    expect(due.every((r) => r.reason === 'session_closed')).toBe(true)
    s.close()
  })
  it('an authoritative event time upgrades a row the derived-axis observer wrote first', () => {
    // Regression (merged-conversation-view.md §6 / PR review): with
    // turnFinalContextRefresh on, recordObservedInbound races SessionManager
    // and wins the INSERT — a Telegram row ts="4821" landed at the derived
    // 4_821_000_000µs axis, and the later authoritative append was
    // INSERT-OR-IGNOREd without repair. Explicit eventTimeUs must upgrade the
    // deduped row (and bump its revision); derived recomputes never flap it.
    const s = store()
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4821', sender: 'U1', kind: 'text', text: 'hi' })
    const before = s.transcriptSince('C1', 'T', null)[0] as { eventTimeUs?: number }
    expect(before.eventTimeUs).toBe(4_821_000_000)
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '4821',
      sender: 'U1',
      kind: 'text',
      text: 'hi',
      eventTimeUs: 1_754_123_458_000_000
    })
    const after = s.transcriptSince('C1', 'T', null)[0] as { eventTimeUs?: number }
    expect(after.eventTimeUs).toBe(1_754_123_458_000_000)
  })

  it('a later append with the fetched image upgrades the observer-written row', () => {
    // The observer records a platform message before the bytes are downloaded, so the
    // authoritative append is INSERT-OR-IGNOREd — without an in-place upgrade the row's
    // attachmentsJson stays NULL and the console shows only the `[attached: …]` label.
    const s = store()
    const text = 'look\n[attached: shot.png (image/png)]'
    s.appendTranscript({ channel: 'C1', thread: 'T', ts: '99', sender: 'U1', kind: 'text', text })
    s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '99',
      sender: 'U1',
      kind: 'text',
      text,
      attachments: [{ name: 'shot.png', mimeType: 'image/png', data: 'aW1n' }]
    })
    const row = s.transcriptSince('C1', 'T', null)[0] as { attachmentsJson?: string | null }
    expect(JSON.parse(row.attachmentsJson ?? 'null')).toEqual([
      { name: 'shot.png', mimeType: 'image/png', data: 'aW1n' }
    ])
    s.close()
  })
})

describe('LocalStore activation rendezvous (send-message-routing-rework.md §3.2/§8.6)', () => {
  const KEY = ['slack', 'scope-1', '1720000000.000100', 'agent-target'].join('\u0000')
  const ENVELOPE = JSON.stringify({ callFrom: 'agent-author', hopCount: 3 })

  it('admits an internal-wake-first pairing exactly once and replays the same child', () => {
    const s = store()
    const first = s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(first.dispatch).toBe(true)
    expect(s.admitActivation(KEY, 'child-1')).toBe(true)

    // A retry of the same delivery — a redelivered wake, or replay after restart — must
    // read back the SAME child rather than opening a second session.
    const retry = s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(retry.dispatch).toBe(false)
    expect(retry.record.state).toBe('admitted')
    expect(retry.record.childSessionId).toBe('child-1')
    s.close()
  })

  it('holds a platform-first observation pending until the envelope arrives', () => {
    const s = store()
    const claimed = s.claimActivationObservation(
      KEY,
      { agentCallDeliveryId: 'd-1', platformMessageId: '1720000000.000100', transcriptCoordinates: 'C1 T1' },
      1000
    )
    expect(claimed.state).toBe('pending')
    expect(claimed.callEnvelope).toBeFalsy()
    // The precondition the design states outright: a platform-first record cannot become
    // `admitted` until `callEnvelope` is present — the visible post carries none of the
    // lineage, so admitting on it would fabricate the call it is supposed to accompany.
    expect(s.admitActivation(KEY, 'child-1')).toBe(false)

    const attached = s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(attached.dispatch).toBe(true)
    expect(s.admitActivation(KEY, 'child-1')).toBe(true)
    expect(s.getActivation(KEY)?.state).toBe('admitted')
    // The visible observation survives the transition, so the later half reconciles onto
    // the same transcript row instead of duplicating the hand-off.
    expect(s.getActivation(KEY)?.platformMessageId).toBe('1720000000.000100')
    s.close()
  })

  it('is idempotent for a redelivered platform event', () => {
    const s = store()
    const obs = { agentCallDeliveryId: 'd-1', platformMessageId: 'ts-1', transcriptCoordinates: 'C1 T1' }
    s.claimActivationObservation(KEY, obs, 1000)
    s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    s.admitActivation(KEY, 'child-1')
    // Slack redelivers; the observation must not reset an admitted record.
    s.claimActivationObservation(KEY, obs, 1000)
    expect(s.getActivation(KEY)?.state).toBe('admitted')
    expect(s.getActivation(KEY)?.childSessionId).toBe('child-1')
    s.close()
  })

  it('expires an envelope-less pairing to transcript-only, and never revives it', () => {
    const s = store()
    s.claimActivationObservation(
      KEY,
      { agentCallDeliveryId: 'd-1', platformMessageId: 'ts-1', transcriptCoordinates: 'C1 T1' },
      1000
    )
    expect(s.expireActivations(999).transcriptOnly).toEqual([])
    const expired = s.expireActivations(1000)
    expect(expired.transcriptOnly.map((r) => r.agentCallDeliveryId)).toEqual(['d-1'])
    expect(s.getActivation(KEY)?.state).toBe('transcript-only')

    // A very late wake must not resurrect a delivery already reported failed — otherwise
    // the operator sees a failure AND the target runs a turn for it anyway.
    const late = s.attachActivationEnvelope(KEY, ENVELOPE, 5000)
    expect(late.dispatch).toBe(false)
    expect(s.getActivation(KEY)?.state).toBe('transcript-only')
    s.close()
  })

  it('never expires a record that already has its envelope', () => {
    const s = store()
    s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(s.expireActivations(999).transcriptOnly).toEqual([])
    expect(s.getActivation(KEY)?.state).toBe('pending')
    s.close()
  })

  it('releases — not reports — a claim left pending WITH an envelope past its TTL', () => {
    // The crash case. In-process, a dispatch that never admits is repaired by the
    // admission callback; a hard crash in that window leaves the row with nobody to run
    // it. Left alone the key is claimed forever and every retry after restart is
    // deduplicated against a child that does not exist — exactly-once becoming never.
    const s = store()
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(true)
    const sweep = s.expireActivations(1000)
    // Not a delivery FAILURE report: unlike the envelope-less case, nothing here says the
    // delivery was observed and lost — only that this attempt did not finish.
    expect(sweep.transcriptOnly).toEqual([])
    expect(sweep.released).toBe(1)
    expect(s.getActivation(KEY)).toBeUndefined()
    // …and the key is claimable again, which is the whole point.
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 5000).dispatch).toBe(true)
    s.close()
  })

  it('grants the dispatch claim once, even before admission settles', () => {
    // Admission settles asynchronously, so "not yet admitted" is NOT "nobody is handling
    // it". A second arrival inside that window must not also be told to dispatch, or one
    // logical delivery wakes the target twice.
    const s = store()
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(true)
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(false)
    expect(s.getActivation(KEY)?.state).toBe('pending')
    s.close()
  })

  it('releases a claim whose dispatch never admitted, so a retry is a first attempt', () => {
    // The other half of exactly-once: a rejected turn, a persistence failure, or a crash
    // between claim and admission would otherwise leave a claimed key with no child, and
    // every retry would be deduplicated against it — exactly-once becoming never.
    const s = store()
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(true)
    expect(s.releaseActivation(KEY)).toBe(true)
    expect(s.getActivation(KEY)).toBeUndefined()
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(true)

    // …but releasing never reopens a settled decision: an admitted record has a real
    // child, and a transcript-only one was already reported as a delivery failure.
    s.admitActivation(KEY, 'child-1')
    expect(s.releaseActivation(KEY)).toBe(false)
    expect(s.getActivation(KEY)).toMatchObject({ state: 'admitted', childSessionId: 'child-1' })
    s.close()
  })

  it('reconciles a crashed claim against the durable inbox instead of guessing', () => {
    // A crash between claim and admission leaves two rows that look identical and need
    // OPPOSITE answers. Releasing both would let a replayed turn be dispatched a second
    // time; admitting both would strand a delivery that never persisted. The inbox row is
    // the only evidence that distinguishes them.
    const s = store()
    const durable = ['slack', 'scope-1', 'ts-durable', 'agent-target'].join('\u0000')
    const lost = ['slack', 'scope-1', 'ts-lost', 'agent-target'].join('\u0000')
    expect(s.attachActivationEnvelope(durable, ENVELOPE, 1000, 'delivery-durable').dispatch).toBe(true)
    expect(s.attachActivationEnvelope(lost, ENVELOPE, 1000, 'delivery-lost').dispatch).toBe(true)
    // Only the first one's turn actually reached the durable queue before the crash.
    s.appendInbox({ id: 'delivery-durable', sessionKey: 'k', agentId: 'bot-b', msg: '{}', enqueuedAt: '0000000001' })

    const sweep = s.expireActivations(1000)
    expect(sweep.transcriptOnly).toEqual([])
    // Durably queued ⇒ startup replay will run it, so the claim COMPLETES. A later retry
    // must be deduplicated against it, not allowed to deliver again.
    expect(s.getActivation(durable)?.state).toBe('admitted')
    expect(s.attachActivationEnvelope(durable, ENVELOPE, 5000).dispatch).toBe(false)
    // Never persisted ⇒ nothing will replay, so the key must become claimable again.
    expect(sweep.released).toBe(1)
    expect(s.getActivation(lost)).toBeUndefined()
    expect(s.attachActivationEnvelope(lost, ENVELOPE, 5000, 'delivery-lost-retry').dispatch).toBe(true)
    s.close()
  })

  it('releases a legacy claim that carries no dispatch id', () => {
    // Rows written before `dispatchId` existed cannot be reconciled. Releasing is the same
    // answer as "never persisted" — the safe direction, since the alternative strands the
    // key forever.
    const s = store()
    expect(s.attachActivationEnvelope(KEY, ENVELOPE, 1000).dispatch).toBe(true)
    expect(s.expireActivations(1000).released).toBe(1)
    expect(s.getActivation(KEY)).toBeUndefined()
    s.close()
  })

  it('keys separate targets of one visible post independently', () => {
    // §3.2: one channel-root post can address several agents; each must be admitted once,
    // and one target's admission must not consume another's.
    const s = store()
    const a = ['slack', 'scope-1', 'ts-1', 'agent-a'].join('\u0000')
    const b = ['slack', 'scope-1', 'ts-1', 'agent-b'].join('\u0000')
    expect(s.attachActivationEnvelope(a, ENVELOPE, 1000).dispatch).toBe(true)
    expect(s.attachActivationEnvelope(b, ENVELOPE, 1000).dispatch).toBe(true)
    s.admitActivation(a, 'child-a')
    expect(s.getActivation(b)?.state).toBe('pending')
    s.close()
  })
})
