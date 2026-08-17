import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-data-plane.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL pool store transcript fence', () => {
  it('isolates two organizations sharing one channel/thread key across pool members', async () => {
    // The real schema, through the SQLite→PostgreSQL rewrite: platform ids are unique only
    // inside one org, so the org has to be part of the key or one org's `ON CONFLICT` dedup
    // swallows the other's message and its console reads the other's rows.
    const suffix = randomUUID()
    const [orgA, orgB] = [`org-a-${suffix}`, `org-b-${suffix}`]
    const [agentA, agentB] = [`agent-a-${suffix}`, `agent-b-${suffix}`]
    const [channel, thread] = [`C-${suffix}`, `T-${suffix}`]
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (id: string) => (id === agentA ? orgA : id === agentB ? orgB : undefined)
    const [first, second] = await Promise.all([
      PostgresDataPlane.open(config, orgForAgent),
      PostgresDataPlane.open(config, orgForAgent)
    ])
    try {
      const row = { channel, thread, ts: '1.000001', sender: `user-${suffix}`, kind: 'text' as const }
      await first.store.appendTranscript({ ...row, recipient: agentA, text: 'org A row' })
      await second.store.appendTranscript({ ...row, recipient: agentB, text: 'org B row' })
      expect(
        (await first.store.transcriptPageForAgent(channel, thread, agentA, null, 10)).rows.map((r) => r.text)
      ).toEqual(['org A row'])
      expect(
        (await second.store.transcriptPageForAgent(channel, thread, agentB, null, 10)).rows.map((r) => r.text)
      ).toEqual(['org B row'])

      // Tool ids are runtime-local, so both orgs can hold `call-1` on the same coordinates.
      const call = { channel, thread, ts: '2.000001', toolCallId: 'call-1', title: 'Bash' }
      await first.store.insertToolCall({ ...call, sender: agentA, body: '{"rawInput":"A"}' })
      await second.store.insertToolCall({ ...call, sender: agentB, body: '{"rawInput":"B"}' })
      await second.store.updateToolCall(channel, thread, agentB, 'call-1', { title: 'Bash', body: '{"rawInput":"B2"}' })
      expect(await first.store.getToolBodyForAgent(channel, thread, agentA, 'call-1')).toBe('{"rawInput":"A"}')
      expect(await second.store.getToolBodyForAgent(channel, thread, agentB, 'call-1')).toBe('{"rawInput":"B2"}')

      // One org's write never moves the other's context fence for the same thread key.
      const peerRevision = await second.store.threadTranscriptRevision(channel, thread, agentB)
      await first.store.appendTranscript({
        channel,
        thread,
        ts: '3.000001',
        sender: agentA,
        kind: 'text',
        text: 'A reply'
      })
      expect(await second.store.threadTranscriptRevision(channel, thread, agentB)).toBe(peerRevision)
      expect(await first.store.currentTranscriptRevision(agentA)).toBeGreaterThan(peerRevision)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})
