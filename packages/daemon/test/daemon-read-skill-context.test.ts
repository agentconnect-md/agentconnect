// Which built-in system skills a running daemon's sessions offer through readSkill (skill-over-mcp.md §4.2).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { checkCoordinate, gettingToKnowCoordinate, researchCoordinate } from '../src/session/subsession-coordinate.js'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-read-skill-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'claude-acp': { command: 'node', args: ['unused'] } }
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
      runtime: 'claude-acp',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(http: boolean) {
  const hostFactory = () =>
    ({
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }) as never
  const daemon = new Daemon({ root: scaffold(), hostFactory })
  await daemon.start()
  const d = daemon as any
  d.runtimeFacts.mcpCapabilities = () => ({ http, sse: false })
  // A relay that renders webchat images is what offers shareFile to a console session.
  d.relays = { advertisesWebchatImages: () => true, stop: async () => {} }
  const context = (input: { thread?: string; platform?: string; hasAdminMcp?: boolean } = {}) => {
    const thread = input.thread ?? 'append:1'
    const agent = d.agents.get('bot-a')
    return d.sessions.deps.toolContextFor({
      agent,
      platform: input.platform ?? 'webchat',
      channel: 'c1',
      thread,
      deliveryThread: thread,
      integrationId: undefined,
      isDm: true,
      sessionKey: `webchat:c1:${thread}:bot-a`,
      ...(input.hasAdminMcp ? { hasAdminMcp: true } : {})
    })
  }
  return { daemon, d, context }
}

const readSkillEnum = (tools: Array<{ name: string; inputSchema: any }> | undefined) =>
  tools?.find((tool) => tool.name === 'readSkill')?.inputSchema.properties.name.enum

describe('toolContextFor and readSkill', () => {
  it('offers every skill to an entitled webchat session and registers the same set on the bridge', async () => {
    const { daemon, d, context } = await boot(true)
    try {
      const entitled = context({ hasAdminMcp: true })
      const all = [
        'agentconnect-images',
        'agentconnect-platform',
        'agentconnect-create-agent',
        'agentconnect-create-team'
      ]
      expect(entitled.builtinSkills).toEqual(all)
      expect(readSkillEnum(entitled.tools)).toEqual(all)
      entitled.mcpServers()
      const registered = [...d.mcp.sessions.values()].at(-1)
      expect(registered.builtinSkills).toEqual(all)
      // The runtime refused agentconnect-admin: the registered context drops create-* before the bridge lists tools.
      entitled.onAdditionalMcpFallback()
      expect(registered.builtinSkills).toEqual(['agentconnect-images', 'agentconnect-platform'])
      expect(readSkillEnum(registered.tools)).toEqual(['agentconnect-images', 'agentconnect-platform'])
      expect(readSkillEnum(entitled.tools)).toEqual(['agentconnect-images', 'agentconnect-platform'])
      expect(entitled.builtinSkills).toEqual(['agentconnect-images', 'agentconnect-platform'])
    } finally {
      await daemon.stop()
    }
  })

  it('keeps create-* off sessions without admin MCP or on a runtime that cannot attach it', async () => {
    const { daemon, d, context } = await boot(true)
    try {
      const plain = context()
      expect(plain.builtinSkills).toEqual(['agentconnect-images', 'agentconnect-platform'])
      expect(plain.onAdditionalMcpFallback).toBeUndefined()
      // A conversation that cannot show a shared image has no shareFile, so no images skill.
      d.relays.advertisesWebchatImages = () => false
      expect(context().builtinSkills).toEqual(['agentconnect-platform'])
      d.relays.advertisesWebchatImages = () => true
      // A changed skill set changes the fingerprint, so a warm session reloads with the new descriptor.
      expect(context({ hasAdminMcp: true }).fingerprint).not.toBe(plain.fingerprint)
    } finally {
      await daemon.stop()
    }
    const noHttp = await boot(false)
    try {
      expect(noHttp.context({ hasAdminMcp: true }).builtinSkills).toEqual([
        'agentconnect-images',
        'agentconnect-platform'
      ])
    } finally {
      await noHttp.daemon.stop()
    }
  })

  it('offers no readSkill to restricted subsessions', async () => {
    const { daemon, context } = await boot(true)
    try {
      for (const thread of [checkCoordinate('f1'), researchCoordinate('r1'), gettingToKnowCoordinate('g1')]) {
        const restricted = context({ thread, hasAdminMcp: true })
        expect(restricted.builtinSkills).toBeUndefined()
        expect(readSkillEnum(restricted.tools)).toBeUndefined()
      }
    } finally {
      await daemon.stop()
    }
  })
})
