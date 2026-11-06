import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { a2aCoordChannel } from '../src/cp/cp-collab-routes.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import * as monotonic from '../src/store/monotonic-ts.js'

/** A valid 2x2 RGB PNG, built so the real preview preparer decodes it. */
function pngOf(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const png = pngOf()
const AGENT = 'page-agent'
let daemon: Daemon | undefined
let root: string | undefined

afterEach(async () => {
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("a delegated task's page", () => {
  it('takes a shared file as a card in its own transcript, though its turn posts nothing to the platform', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-task-page-share-'))
    const dir = join(root, 'agents', AGENT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id: AGENT,
        name: 'Page Agent',
        runtime: 'claude',
        status: 'active',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
    const channel = a2aCoordChannel(AGENT)
    const thread = subsessionCoordinate(monotonic.monotonicTs())
    const context = Object.assign(
      { agentId: AGENT, platform: 'webchat', channel, thread, isDm: false, tools: toolsForIntegrations([]) },
      { deliveryThread: thread }
    ) as SessionContext
    const outcomes: unknown[] = []
    daemon = new Daemon({
      root,
      hostFactory: () =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          promptSupports: () => false,
          newSession: async (cwd: string) => {
            mkdirSync(join(cwd, 'out'), { recursive: true })
            writeFileSync(join(cwd, 'out', 'dog.png'), png)
            return 'acp-page'
          },
          prompt: async () => {
            const deps = (daemon as any).mcp.deps
            outcomes.push(await executeTool(context, 'shareFile', { path: 'out/dog.png' }, deps).catch((e: Error) => e))
            return { stopReason: 'end_turn' }
          }
        }) as any
    })
    await daemon.start()
    // The coordinator moves a console message onto the task's coordinate, with no browser turn of its own.
    const moved: NormalizedMessage = {
      msgId: 'webchat-msg-1',
      traceId: 'trace-1',
      transcriptTs: monotonic.monotonicTs(),
      source: 'user',
      platform: 'webchat',
      channel,
      sessionThread: thread,
      sender: { id: 'user-p', isBot: false, name: 'P' },
      text: 'send me the picture',
      mentionedBots: [],
      isDm: false
    }
    await (daemon as any).dispatch(AGENT, moved, undefined)
    for (let i = 0; i < 500 && outcomes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))

    // Stamped platform-silent at dispatch, and still the person's message.
    expect(moved.headless).toBe(true)
    expect(outcomes[0]).toMatchObject({ type: 'agentconnect.image', published: true })
    const postId = (outcomes[0] as { postId: string }).postId
    const store = (daemon as any).store
    expect(await store.transcriptSharedImage(channel, postId)).toMatchObject({ original: { kind: 'inline' } })
  })
})
