import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countingManifest } from '../games/engine.js'
import { prepareRealSubject, prepareScriptedSubject, preflightRealSubject } from '../games/subject.js'
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

/** A stand-in for the daemon CLI: the preflight's structural check is "does this
 *  entry implement the `mcp-bridge` command", so the fixture only has to contain
 *  that command name. Keeping it hermetic means the check is covered even when
 *  the daemon bundle has not been built. */
function daemonEntryStub(): string {
  const path = join(scratch(), 'daemon-cli-stub.js')
  writeFileSync(path, "// AgentConnect daemon CLI stub\nprogram.command('mcp-bridge')\n")
  return path
}

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

  it('forces account-app isolation on even when the template disables it, and preserves other security settings', () => {
    const root = template()
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    config.security = { isolateAccountApps: false, requireSandbox: true }
    writeFileSync(join(root, 'config.json'), JSON.stringify(config))
    const subject = prepareRealSubject(topology, {
      kind: 'real',
      subjectRoot: root,
      templateAgentIds: ['template-agent']
    })
    try {
      const prepared = JSON.parse(readFileSync(join(subject.root, 'config.json'), 'utf8'))
      expect(prepared.security).toEqual({ isolateAccountApps: true, requireSandbox: true })
    } finally {
      subject.cleanup()
    }
  })

  it('harvests template credentials into the redaction set; scripted subjects carry none', () => {
    const subject = prepareRealSubject(topology, {
      kind: 'real',
      subjectRoot: template(),
      templateAgentIds: ['template-agent']
    })
    try {
      // config controlPlane.key + the template agent's slack botToken.
      expect(subject.secrets).toContain('template-cp-key-value')
      expect(subject.secrets).toContain('xoxb-template')
    } finally {
      subject.cleanup()
    }
    const scripted = prepareScriptedSubject(topology)
    try {
      expect(scripted.secrets).toEqual([])
    } finally {
      scripted.cleanup()
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

describe('real-subject preflight — an unlaunchable runtime fails loudly, not silently', () => {
  /** Materialize a real subject whose runtime is exactly `command` + `args`. */
  function realSubjectWithRuntime(command: string, args: string[]) {
    const root = scratch()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: { probe: { command, args } } })
    )
    const agentDir = join(root, 'agents', 'template-agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({ id: 'template-agent', name: 'Template Agent', status: 'active', runtime: 'probe' })
    )
    const subject = prepareRealSubject(topology, {
      kind: 'real',
      subjectRoot: root,
      templateAgentIds: ['template-agent']
    })
    scratchRoots.push(subject.root)
    return subject
  }

  it('reports the runtime, the command and the child stderr when the runtime exits immediately', async () => {
    // The real-world shape of this is a corrupted npx cache: the launcher exits
    // at once, the daemon never produces an agent effect, and the game burns its
    // whole deadline writing an empty world with no explanation.
    const subject = realSubjectWithRuntime(process.execPath, [
      '-e',
      'process.stderr.write("npm error could not determine executable to run"); process.exit(1)'
    ])
    await expect(preflightRealSubject(subject.root)).rejects.toThrow(/runtime "probe" exited immediately/)
    await expect(preflightRealSubject(subject.root)).rejects.toThrow(/could not determine executable to run/)
    await expect(preflightRealSubject(subject.root)).rejects.toThrow(/stall with zero agent effects/)
  }, 60_000)

  it('reports a runtime whose command does not exist at all', async () => {
    const subject = realSubjectWithRuntime('ac-no-such-runtime-binary', [])
    await expect(preflightRealSubject(subject.root)).rejects.toThrow(/runtime "probe" could not be spawned/)
  }, 60_000)

  it('passes a runtime that stays alive on stdio, the way an ACP adapter does', async () => {
    const subject = realSubjectWithRuntime(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    const previous = process.env.AGENTCONNECT_DAEMON_ENTRY
    process.env.AGENTCONNECT_DAEMON_ENTRY = daemonEntryStub()
    try {
      await expect(preflightRealSubject(subject.root, { probeMs: 1_000 })).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.AGENTCONNECT_DAEMON_ENTRY
      else process.env.AGENTCONNECT_DAEMON_ENTRY = previous
    }
  }, 60_000)

  it('terminates the whole process tree, not just an npx-style wrapper', async () => {
    // Measured hazard: `npx -y <adapter>` runs the REAL adapter as a GRANDCHILD of
    // the npm wrapper. Killing only the direct child leaves that grandchild alive,
    // reparented to pid 1, holding its inherited pipes open — every preflight then
    // leaks another adapter. `AcpHost` spawns detached and signals the group for
    // this exact reason; the probe must too. The grandchild here ignores stdin, so
    // an adapter that happens to exit on EOF cannot mask the leak.
    const marker = `ac-preflight-tree-${process.pid}-${Date.now()}`
    const root = scratch()
    const grandchild = join(root, `${marker}-grandchild.mjs`)
    const wrapper = join(root, `${marker}-wrapper.mjs`)
    writeFileSync(grandchild, 'setInterval(() => {}, 1000)\n')
    writeFileSync(
      wrapper,
      `import { spawn } from 'node:child_process'\n` +
        `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' })\n` +
        `setInterval(() => {}, 1000)\n`
    )
    const subject = realSubjectWithRuntime(process.execPath, [wrapper])
    const previous = process.env.AGENTCONNECT_DAEMON_ENTRY
    process.env.AGENTCONNECT_DAEMON_ENTRY = daemonEntryStub()
    try {
      await expect(preflightRealSubject(subject.root, { probeMs: 1_500 })).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.AGENTCONNECT_DAEMON_ENTRY
      else process.env.AGENTCONNECT_DAEMON_ENTRY = previous
    }
    // Give the SIGTERM→SIGKILL escalation time to reach the whole group.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const survivors = execFileSync('/bin/sh', [
      '-c',
      `ps -eo pid,args | grep ${marker}-grandchild | grep -v grep || true`
    ])
      .toString()
      .trim()
    expect(survivors, `preflight orphaned a grandchild:\n${survivors}`).toBe('')
  }, 60_000)

  it('refuses an MCP bridge entry that is not the daemon CLI — the silent no-tools failure', async () => {
    // A real runtime reaches every AgentConnect tool through a `mcp-bridge`
    // subprocess spawned from the daemon CLI. Point that at anything else and
    // the ACP session comes up with no tools at all, which reads as the model
    // improvising rather than as a harness fault.
    const subject = realSubjectWithRuntime(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    const previous = process.env.AGENTCONNECT_DAEMON_ENTRY
    const notTheCli = join(scratch(), 'not-the-cli.js')
    writeFileSync(notTheCli, 'console.log("I am a test runner, not the daemon")\n')
    try {
      process.env.AGENTCONNECT_DAEMON_ENTRY = notTheCli
      await expect(preflightRealSubject(subject.root, { probeMs: 500 })).rejects.toThrow(
        /is not the AgentConnect daemon CLI/
      )
      process.env.AGENTCONNECT_DAEMON_ENTRY = join(scratch(), 'missing-entry.js')
      await expect(preflightRealSubject(subject.root, { probeMs: 500 })).rejects.toThrow(/does not exist/)
    } finally {
      if (previous === undefined) delete process.env.AGENTCONNECT_DAEMON_ENTRY
      else process.env.AGENTCONNECT_DAEMON_ENTRY = previous
    }
  }, 60_000)
})
