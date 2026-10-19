import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpHost } from '../../src/acp/acp-host.js'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const script = fileURLToPath(new URL('../fixtures/ahp-acp-agent.mjs', import.meta.url))

describe('AHP acceptance runtime process', () => {
  it('speaks actual ACP permission, input, load and cancellation messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahp-acp-fixture-'))
    paths.push(dir)
    const log = join(dir, 'runtime.jsonl')
    const texts: string[] = []
    const host = new AcpHost(
      { command: process.execPath, args: [script, log], env: [] },
      {
        onUpdate: (_session, update) => {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
            texts.push(update.content.text)
        },
        onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
        onElicit: async () => ({ action: 'accept', content: { value: 'two' } })
      }
    )
    await host.start()
    try {
      const session = await host.newSession(dir)
      expect((await host.prompt(session, [{ type: 'text', text: '[ahp:approve] [ahp:input]' }])).stopReason).toBe(
        'end_turn'
      )
      expect(texts.join('')).toContain('allow-once')
      expect(texts.join('')).toContain('two')
      await host.loadSession(session, dir)
      texts.length = 0
      const held = host.prompt(session, [{ type: 'text', text: '[ahp:hold]' }])
      await expect.poll(() => texts.join('')).toContain('fixture started')
      await host.cancel(session)
      expect((await held).stopReason).toBe('cancelled')
      const methods = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).method)
      expect(methods.filter((method) => method === 'session/prompt')).toHaveLength(2)
      expect(methods.filter((method) => method === 'session/cancel')).toHaveLength(1)
      expect(methods).toContain('session/load')
    } finally {
      await host.stop()
    }
  })
})
