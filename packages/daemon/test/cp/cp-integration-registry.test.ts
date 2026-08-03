import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CpIntegrationRegistry } from '../../src/cp/cp-integration-registry.js'
import type { IntegrationSpec } from '@agentconnect.md/protocol'

const A1 = '11111111-1111-4111-8111-111111111111'
const I1 = '66666666-6666-4666-8666-666666666666'
const I2 = '77777777-7777-4777-8777-777777777777'

const spec = (over: Partial<IntegrationSpec> = {}): IntegrationSpec => ({
  integrationId: I1,
  agentId: A1,
  platform: 'slack',
  slack: {
    botToken: 'xoxb-secret',
    appToken: 'xapp-secret',
    bindRules: [{ match: { kind: 'mention' } }]
  },
  ...over
})

function agentsDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-cpintreg-'))
}
function writeAgentFile(dir: string, folder: string, raw: Record<string, unknown>) {
  mkdirSync(join(dir, folder), { recursive: true })
  writeFileSync(join(dir, folder, 'agent.json'), JSON.stringify(raw))
}
function readAgent(dir: string, folder: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, folder, 'agent.json'), 'utf8'))
}
function makeReg(dir: string) {
  const onChange = vi.fn()
  const warn = vi.fn()
  const reg = new CpIntegrationRegistry(dir, { warn }, onChange)
  return { reg, onChange, warn }
}

const AGENT_RAW = {
  id: A1,
  name: 'helper',
  runtime: 'claude',
  workspace: { mode: 'from-scratch', path: './ws' }
}

describe('CpIntegrationRegistry (filesystem-backed)', () => {
  it('upsert APPENDS the integration to the owning agent.json (creating integrations[]) and fires onChange', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', AGENT_RAW)
    const { reg, onChange } = makeReg(dir)
    reg.upsert(spec())
    const a = readAgent(dir, 'helper')
    expect(a.integrations).toHaveLength(1)
    const int = (a.integrations as any[])[0]
    expect(int.id).toBe(I1)
    expect(int.platform).toBe('slack')
    expect(int.slack.botToken).toBe('xoxb-secret')
    expect(int.slack.appToken).toBe('xapp-secret')
    expect(int.slack.bindRules).toEqual([{ match: { kind: 'mention' } }])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('upsert REPLACES the same-id entry and preserves other integrations + literal strings + relative path', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      integrations: [
        { id: I1, platform: 'slack', slack: { botToken: 'xoxb-old', appToken: 'xapp-old' } },
        { id: 'local-1', platform: 'slack', slack: { botToken: '${MY_BOT}', appToken: '${MY_APP}' } }
      ]
    })
    const { reg } = makeReg(dir)
    reg.upsert(spec({ slack: { botToken: 'xoxb-new', appToken: 'xapp-new', bindRules: [] } }))
    const a = readAgent(dir, 'helper')
    expect(a.integrations).toHaveLength(2)
    const [cp, local] = a.integrations as any[]
    expect(cp.id).toBe(I1)
    expect(cp.slack.botToken).toBe('xoxb-new')
    // Hand-authored placeholder-looking strings stay literal.
    expect(local.slack.botToken).toBe('${MY_BOT}')
    expect(local.slack.appToken).toBe('${MY_APP}')
    // raw-JSON edit: relative workspace.path never absolutized
    expect((a.workspace as any).path).toBe('./ws')
  })

  it('upsert locates the owning agent by INTERNAL id (custom-named dir)', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'my-cool-bot', AGENT_RAW)
    const { reg } = makeReg(dir)
    reg.upsert(spec())
    const a = readAgent(dir, 'my-cool-bot')
    expect((a.integrations as any[])[0].id).toBe(I1)
  })

  it('upsert for a missing agent warns (ids only) and persists nothing, still fires onChange', () => {
    const dir = agentsDir()
    const { reg, onChange, warn } = makeReg(dir)
    reg.upsert(spec())
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0]![0] as string
    expect(msg).toContain(I1)
    expect(msg).toContain(A1)
    expect(msg).not.toContain('xoxb') // never the token material
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('remove splices the entry out of whichever agent.json holds it; absent id is a no-op', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      integrations: [
        { id: I1, platform: 'slack', slack: { botToken: 'xoxb-a', appToken: 'xapp-a' } },
        { id: I2, platform: 'slack', slack: { botToken: 'xoxb-b', appToken: 'xapp-b' } }
      ]
    })
    const { reg, onChange } = makeReg(dir)
    reg.remove(I1)
    const a = readAgent(dir, 'helper')
    expect(a.integrations).toHaveLength(1)
    expect((a.integrations as any[])[0].id).toBe(I2)
    expect(onChange).toHaveBeenCalledTimes(1)
    // removing an unknown id changes nothing (but still re-reconciles)
    reg.remove('no-such-integration')
    expect(readAgent(dir, 'helper').integrations).toHaveLength(1)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('converge upserts each roster entry and does NOT prune integrations absent from the roster', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      integrations: [{ id: I1, platform: 'slack', slack: { botToken: 'xoxb-a', appToken: 'xapp-a' } }]
    })
    const { reg, onChange } = makeReg(dir)
    reg.converge([spec({ integrationId: I2, slack: { botToken: 'xoxb-b', appToken: 'xapp-b', bindRules: [] } })])
    const a = readAgent(dir, 'helper')
    // I2 created from the roster; I1 NOT pruned (deletion only via integration/remove)
    expect((a.integrations as any[]).map((i) => i.id).sort()).toEqual([I1, I2].sort())
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
