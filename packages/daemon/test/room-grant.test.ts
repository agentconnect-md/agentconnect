// A conversation-gated agent's own new room: announced, reported, and its first message held while the grant lands (resource-visibility.md §14.10).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const INTEGRATION = 'int-slack'
const ROOM = 'C0ROOM'

const inRoom = (extra: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:${ROOM}:1`,
    traceId: `slack:${ROOM}:1`,
    source: 'user',
    platform: 'slack',
    channel: ROOM,
    thread: ROOM,
    sender: { id: 'U1', isBot: false, name: 'Example Person' },
    text: 'build the thing',
    mentionedBots: [],
    isDm: false,
    conversationBotId: 'UBOT',
    ...extra
  }) as NormalizedMessage

/** A creation that finishes when the test says so. */
function slowMake(made: { result: string; channel?: string }) {
  let finish = (): void => {}
  const done = new Promise<typeof made>((resolve) => (finish = () => resolve(made)))
  return { make: () => done, finish: () => finish() }
}

describe('a room a gated agent makes', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function setup(roomGrant = vi.fn(async (_payload: { phase: string; channel?: string }) => true)) {
    root = mkdtempSync(join(tmpdir(), 'ac-room-grant-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: {} })
    )
    const daemon = new Daemon({ root, hostFactory: () => ({}) as any }) as any
    const bindRules: { channel: string; match: { kind: 'mention' } }[] = []
    const integration = { id: INTEGRATION, platform: 'slack', core: { mode: 'shared', gated: true, bindRules } }
    daemon.integrationConfigById = (id: string) => (id === INTEGRATION ? integration : undefined)
    daemon.cpClient = { roomGrant, grantsRooms: () => true }
    /** The rules the control plane ships once it has opened the room. */
    const rulesLand = () => void bindRules.push({ channel: ROOM, match: { kind: 'mention' } })
    return { daemon, roomGrant, rulesLand }
  }

  it('tells the control plane before making the room, then names the room it made', async () => {
    const { daemon, roomGrant } = setup()
    const order: string[] = []
    roomGrant.mockImplementation(async (payload) => {
      order.push(payload.phase)
      return true
    })

    const make = async () => {
      order.push('make')
      return { result: 'made', channel: ROOM }
    }
    const result = await daemon.admitRoom(INTEGRATION, 'C1', make, true)

    expect(result).toBe('made')
    expect(order).toEqual(['opening', 'make', 'opened'])
    expect(roomGrant).toHaveBeenLastCalledWith({
      integrationId: INTEGRATION,
      origin: 'C1',
      phase: 'opened',
      channel: ROOM
    })
  })

  it('reports a creation that made nothing, or failed, as abandoned', async () => {
    const { daemon, roomGrant } = setup()

    await daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'already there' }), true)
    const refused = async () => {
      throw new Error('missing_scope')
    }
    await expect(daemon.admitRoom(INTEGRATION, 'C1', refused, true)).rejects.toThrow('missing_scope')

    expect(roomGrant.mock.calls.map(([payload]) => payload.phase)).toEqual([
      'opening',
      'abandoned',
      'opening',
      'abandoned'
    ])
    expect(daemon.roomGrants.size).toBe(0)
  })

  it('abandons nothing the control plane never took, and still names a room it made', async () => {
    const { daemon, roomGrant } = setup(vi.fn(async () => false))

    await daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'already there' }), true)
    await daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'made', channel: ROOM }), true)

    expect(roomGrant.mock.calls.map(([payload]) => payload.phase)).toEqual(['opening', 'opening', 'opened'])
  })

  it('for an ungated agent names the room only where the control plane took the announcement, and holds nothing', async () => {
    const taken = setup()
    await taken.daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'made', channel: ROOM }), false)
    expect(taken.roomGrant.mock.calls.map(([payload]) => payload.phase)).toEqual(['opening', 'opened'])
    expect(taken.daemon.roomGrants.size).toBe(0)

    // An agent that has its bot to itself is answered false, and nothing more is sent.
    const alone = setup(vi.fn(async () => false))
    await alone.daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'made', channel: ROOM }), false)
    expect(alone.roomGrant.mock.calls.map(([payload]) => payload.phase)).toEqual(['opening'])
  })

  it('makes the room even when the control plane cannot be asked', async () => {
    const { daemon } = setup(
      vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    )
    await expect(
      daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'made', channel: ROOM }), true)
    ).resolves.toBe('made')
  })

  it('holds the room’s first message until the grant’s rules land', async () => {
    const { daemon, rulesLand } = setup()
    const { make, finish } = slowMake({ result: 'made', channel: ROOM })
    const making = daemon.admitRoom(INTEGRATION, 'C1', make, true)

    // The platform's copy of the request arrives while the room is still being made.
    expect(daemon.gatedAdmission(INTEGRATION, inRoom())).toBe(false)
    expect(daemon.roomGrantOpen(INTEGRATION, inRoom())).toBe(true)
    const landed = daemon.roomGrantLanded(INTEGRATION, inRoom(), 5_000)
    finish()
    await making
    rulesLand()

    await expect(landed).resolves.toBe(true)
    expect(daemon.gatedAdmission(INTEGRATION, inRoom())).toBe(true)
  })

  it('stops holding once the grant was refused, so the refusal stands', async () => {
    const { daemon } = setup(vi.fn(async () => false))
    await daemon.admitRoom(INTEGRATION, 'C1', async () => ({ result: 'made', channel: ROOM }), true)

    expect(daemon.roomGrantOpen(INTEGRATION, inRoom())).toBe(false)
    await expect(daemon.roomGrantLanded(INTEGRATION, inRoom(), 5_000)).resolves.toBe(false)
  })

  it('holds nothing outside a room the platform assigns to this bot, nor a bot’s message', async () => {
    const { daemon } = setup()
    const { make, finish } = slowMake({ result: 'made' })
    const making = daemon.admitRoom(INTEGRATION, 'C1', make, true)

    const { conversationBotId: _unowned, ...elsewhere } = inRoom()
    expect(daemon.roomGrantOpen(INTEGRATION, elsewhere)).toBe(false)
    expect(daemon.roomGrantOpen(INTEGRATION, inRoom({ sender: { id: 'B1', isBot: true } }))).toBe(false)
    await expect(daemon.roomGrantLanded(INTEGRATION, elsewhere, 5_000)).resolves.toBe(false)
    finish()
    await making
  })

  it('gives up after its wait, leaving the message to the ordinary refusal', async () => {
    const { daemon } = setup()
    const { make, finish } = slowMake({ result: 'made' })
    const making = daemon.admitRoom(INTEGRATION, 'C1', make, true)

    await expect(daemon.roomGrantLanded(INTEGRATION, inRoom(), 120)).resolves.toBe(false)
    finish()
    await making
  })
})
