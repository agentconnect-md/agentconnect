import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countingManifest } from '../games/engine.js'
import { prepareRealSubject, prepareScriptedSubject } from '../games/subject.js'
import { compileTopology } from '../games/topology.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-game-subject-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

function template(): string {
  const root = scratch()
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: true, key: 'template-cp-key-value' },
      relays: [{ url: 'https://relay.example.test' }],
      runtimes: { 'real-runtime': { command: 'real-acp', args: ['--serve'] } }
    })
  )
  const agentDir = join(root, 'agents', 'template-agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'template-agent',
      name: 'Template Agent',
      status: 'inactive',
      runtime: 'real-runtime',
      memory: { provider: 'managed' },
      integrations: [{ id: 'real-int', platform: 'slack', slack: { botToken: 'xoxb-template' } }],
      crons: [{ id: 'c1' }],
      mcpServers: [{ name: 'srv' }],
      workspace: { mode: 'git', path: '/somewhere', gitUrl: 'https://git.example.test/repo.git' }
    })
  )
  writeFileSync(join(agentDir, 'instructions.md'), 'Count carefully.')
  return root
}

const topology = compileTopology(countingManifest({ seed: 21, agents: ['agent-a', 'agent-b', 'agent-c'] }))

describe('game subjects (§8.1/§14 step 4)', () => {
  it('scripted subject scaffolds one scripted agent per compiled uuid with no on-disk integrations', () => {
    const subject = prepareScriptedSubject(topology)
    try {
      for (const agent of topology.agents) {
        const parsed = JSON.parse(readFileSync(join(subject.root, 'agents', agent.agentId, 'agent.json'), 'utf8'))
        expect(parsed).toMatchObject({ id: agent.agentId, name: agent.alias, runtime: 'scripted', integrations: [] })
      }
    } finally {
      subject.cleanup()
    }
  })

  it('real subject materializes each seat from the template under the compiled uuid, stripped of side channels', () => {
    const subject = prepareRealSubject(topology, {
      kind: 'real',
      subjectRoot: template(),
      templateAgentIds: ['template-agent']
    })
    try {
      const config = JSON.parse(readFileSync(join(subject.root, 'config.json'), 'utf8'))
      // The disposable subject never talks to a control plane or relay.
      expect(config.controlPlane).toEqual({ enabled: false })
      expect(config.relays).toEqual([])
      expect(config.runtimes['real-runtime']).toMatchObject({ command: 'real-acp' })
      for (const agent of topology.agents) {
        const parsed = JSON.parse(readFileSync(join(subject.root, 'agents', agent.agentId, 'agent.json'), 'utf8'))
        expect(parsed).toMatchObject({
          id: agent.agentId,
          name: agent.alias,
          status: 'active',
          runtime: 'real-runtime',
          // The evaluation environment stays the only integration authority.
          integrations: [],
          crons: [],
          mcpServers: [],
          memory: { provider: 'none' }
        })
        expect(parsed.workspace.mode).toBe('from-scratch')
        expect(existsSync(parsed.workspace.path)).toBe(true)
        expect(readFileSync(join(subject.root, 'agents', agent.agentId, 'instructions.md'), 'utf8')).toBe(
          'Count carefully.'
        )
      }
    } finally {
      subject.cleanup()
    }
  })

  it('broadcasts a single template across seats and cycles multiple templates in order', () => {
    const root = template()
    const second = join(root, 'agents', 'second-agent')
    mkdirSync(second, { recursive: true })
    writeFileSync(
      join(second, 'agent.json'),
      JSON.stringify({ id: 'second-agent', name: 'Second', runtime: 'real-runtime' })
    )
    const subject = prepareRealSubject(topology, {
      kind: 'real',
      subjectRoot: root,
      templateAgentIds: ['template-agent', 'second-agent']
    })
    try {
      const names = topology.agents.map(
        (agent) =>
          JSON.parse(readFileSync(join(subject.root, 'agents', agent.agentId, 'agent.json'), 'utf8')).name as string
      )
      expect(names).toEqual(['agent-a', 'agent-b', 'agent-c'])
    } finally {
      subject.cleanup()
    }
  })

  it('fails closed on missing templates, unknown runtimes, and symlinked configs', () => {
    expect(() =>
      prepareRealSubject(topology, { kind: 'real', subjectRoot: scratch(), templateAgentIds: ['template-agent'] })
    ).toThrow(/missing .*config\.json/)
    const root = template()
    expect(() =>
      prepareRealSubject(topology, { kind: 'real', subjectRoot: root, templateAgentIds: ['ghost'] })
    ).toThrow(/has no agent "ghost"/)
    expect(() =>
      prepareRealSubject(topology, { kind: 'real', subjectRoot: root, templateAgentIds: ['../escape'] })
    ).toThrow(/not a safe path segment/)
    const linked = template()
    const linkDir = join(linked, 'agents', 'linked-agent')
    mkdirSync(linkDir, { recursive: true })
    symlinkSync(join(linked, 'agents', 'template-agent', 'agent.json'), join(linkDir, 'agent.json'))
    expect(() =>
      prepareRealSubject(topology, { kind: 'real', subjectRoot: linked, templateAgentIds: ['linked-agent'] })
    ).toThrow(/symbolic link/)
  })
})
