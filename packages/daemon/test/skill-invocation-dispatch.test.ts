// End-to-end through the real daemon: a typed `/skill` reaches the runtime as the probe-validated
// instruction, gated on what THIS agent's runtime advertised — while the transcript, and every
// non-command message, keep the user's own words. This is the seam the #1312 review caught missing:
// the picker's UI was right and the wire wasn't, so this test crosses that exact boundary.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-skillinv-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function msg(text: string, n: number) {
  return {
    msgId: `slack:C1:${n}`,
    traceId: String(n),
    source: 'user' as const,
    platform: 'slack' as const,
    channel: 'C1',
    thread: `slack:C1:${n}`,
    sender: { id: 'U123', isBot: false },
    text,
    mentionedBots: ['bot-a'],
    isDm: true,
    trigger: 'dm' as const
  }
}

describe('skill-invocation translation through dispatch', () => {
  it('translates a typed /skill for the prompt only, and only when advertised', async () => {
    const root = scaffold()
    roots.push(root)
    const prompts: string[][] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: (id: string) => id === 'acp-1',
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts.push(blocks.map((b) => String(b.text ?? '')))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    try {
      // Before any advertisement the table is empty, so a typed /name is ordinary text.
      await (daemon as any).dispatch('bot-a', msg('/code-review 42', 1))
      expect(prompts[0]!.join('\n')).toContain('[U123] /code-review 42')

      // The runtime advertises — the same wire the real adapter uses (#1310's capture).
      await (daemon as any).onAcpUpdate('bot-a', 'acp-1', {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'code-review', description: 'Review the current diff (project)', input: { hint: '[pr]' } },
          { name: 'model', description: 'Set the AI model for Claude Code', input: null }
        ]
      })

      // Now the same message is delivered as the instruction — sender envelope intact.
      await (daemon as any).dispatch('bot-a', msg('/code-review 42', 2))
      const translated = prompts[1]!.join('\n')
      expect(translated).toContain('[U123] Run the command /code-review 42')
      expect(translated).not.toContain('[U123] /code-review 42')

      // A built-in never translates; unknown names and paths never translate.
      await (daemon as any).dispatch('bot-a', msg('/model haiku', 3))
      expect(prompts[2]!.join('\n')).toContain('[U123] /model haiku')
      await (daemon as any).dispatch('bot-a', msg('/Users/pc/x is broken', 4))
      expect(prompts[3]!.join('\n')).toContain('[U123] /Users/pc/x is broken')

      // The transcript kept the user's words, not the instruction (prompt ≠ transcript).
      const store = (daemon as any).store
      const rows = await store.transcriptSince('slack:C1', 'slack:C1:2', null, 'bot-a')
      const all = rows.map((r: { text?: string }) => r.text ?? '').join('\n')
      expect(all).not.toContain('Run the command')
    } finally {
      await daemon.stop()
    }

    // Restart onto the same root: the advertisement must survive the process — a daemon
    // upgrade or restart must not read as "this agent has never run" until a session starts.
    const prompts2: string[][] = []
    const fakeHost2 = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-2'),
      hasSession: (id: string) => id === 'acp-2',
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts2.push(blocks.map((b) => String(b.text ?? '')))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const restarted = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost2 as any })
    await restarted.start()
    try {
      await vi.waitFor(() => {
        expect((restarted as any).runtimeCommands.get('bot-a').reported).toBe(true)
      })
      // And the seeded table still drives translation, before any new advertisement.
      await (restarted as any).dispatch('bot-a', msg('/code-review 7', 5))
      expect(prompts2[0]!.join('\n')).toContain('[U123] Run the command /code-review 7')
    } finally {
      await restarted.stop()
    }
  })
})
