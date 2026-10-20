import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { AhpAttachmentAuthorization } from '@agentconnect.md/protocol'
import { LocalStore } from '../../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../../src/store/sqlite-async-database.js'
import { initialAhpChat } from '../../src/ahp/initial-state.js'
import { chatSessionKey } from '../../src/session/chat-application.js'

it('reads a minted native slot without creating a runtime row and refuses unrelated missing history', async () => {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')),
    shared: true,
    ownerId: 'daemon',
    orgForAgent: () => 'org'
  })
  try {
    const agentId = randomUUID(),
      conversationId = randomUUID()
    const key = chatSessionKey(conversationId, agentId)
    const sessionId = await store.ensureOutwardSessionId(key, agentId)
    const binding = { reservationId: randomUUID(), conversationId, sessionId, sessionUri: 'ahp-session:/client-chosen' }
    const auth: AhpAttachmentAuthorization = {
      agentId,
      orgId: 'org',
      user: 'Reader',
      userId: 'reader',
      callerRole: 'owner',
      callerApproves: false,
      grant: { token: 'signed', expiresAtMs: Date.now() + 60_000 }
    }
    expect(await initialAhpChat(store, binding, auth, (text) => text, 1)).toMatchObject({
      resource: 'ahp-chat:/client-chosen/main',
      turns: []
    })
    expect(await store.getSession(key)).toBeUndefined()
    expect(await store.ensureOutwardSessionId(key, agentId)).toBe(sessionId)
    await expect(
      initialAhpChat(store, { ...binding, sessionId: 'missing-historical' }, auth, (text) => text, 1)
    ).rejects.toThrow('current local slot')
    await expect(
      initialAhpChat(store, binding, { ...auth, targetSessionId: sessionId }, (text) => text, 1)
    ).rejects.toThrow('current local slot')
    await expect(initialAhpChat(store, binding, { ...auth, agentId: randomUUID() }, (text) => text, 1)).rejects.toThrow(
      'current local slot'
    )
  } finally {
    await store.close()
  }
})
