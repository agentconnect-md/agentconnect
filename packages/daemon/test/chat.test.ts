import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { runChat } from '../src/cli/chat.js'
import type { AcpHost } from '../src/acp/acp-host.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs')

function scaffold(): { agentsDir: string; configPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-chat-'))
  const configPath = join(root, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { fake: { command: process.execPath, args: [fakeAgent], env: [] } }
    })
  )
  const agentSubdir = join(root, 'agent')
  mkdirSync(agentSubdir, { recursive: true })
  writeFileSync(
    join(agentSubdir, 'agent.json'),
    JSON.stringify({
      id: 'solo',
      name: 'Solo',
      status: 'active',
      runtime: 'fake',
      workspace: { mode: 'from-scratch', path: join(agentSubdir, 'ws') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return { agentsDir: agentSubdir, configPath, root }
}

function capture(): { stream: Writable; text: () => string } {
  let buf = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString()
      cb()
    }
  })
  return { stream, text: () => buf }
}

function curatedScaffold(runtimeId: string): ReturnType<typeof scaffold> {
  const files = scaffold()
  writeFileSync(files.configPath, JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  writeFileSync(
    join(files.agentsDir, 'agent.json'),
    JSON.stringify({
      id: 'solo',
      name: 'Solo',
      status: 'active',
      runtime: runtimeId,
      workspace: { mode: 'from-scratch', path: join(files.agentsDir, 'ws') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return files
}

function catalog(runtimeId: string, command = runtimeId): ResolvedRuntimeCatalog {
  const runtime = { command, args: ['acp'], env: [] }
  return {
    entries: { [runtimeId]: { runtime, source: 'curated', name: runtimeId, version: '' } },
    runtimes: { [runtimeId]: runtime }
  }
}

function quietHost(): AcpHost {
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'session'),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    stop: vi.fn(async () => {})
  } as unknown as AcpHost
}

describe('runChat', () => {
  it('single-shot: discovers the lone agent, spawns runtime, streams the echoed reply', async () => {
    const { agentsDir, configPath, root } = scaffold()
    const out = capture()
    await runChat({ agentsDir, message: 'hi', configPath, root, out: out.stream })
    expect(out.text()).toContain('echo:hi')
  }, 20_000)

  it('errors clearly when the runtime name is unknown', async () => {
    const { agentsDir, configPath, root } = scaffold()
    writeFileSync(
      join(agentsDir, 'agent.json'),
      JSON.stringify({
        id: 'solo',
        name: 'Solo',
        status: 'active',
        runtime: 'missing',
        workspace: { mode: 'from-scratch', path: join(agentsDir, 'ws') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    await expect(runChat({ agentsDir, message: 'hi', configPath, root, out: capture().stream })).rejects.toThrow(
      /runtime "missing".*Available: .*fake/s
    )
  }, 20_000)

  it('errors and asks for --agent when several agents are discovered', async () => {
    const { agentsDir, configPath, root } = scaffold()
    const parent = dirname(agentsDir)
    mkdirSync(join(parent, 'agent2'), { recursive: true })
    writeFileSync(
      join(parent, 'agent2', 'agent.json'),
      JSON.stringify({
        id: 'solo2',
        name: 'Solo2',
        status: 'active',
        runtime: 'fake',
        workspace: { mode: 'from-scratch', path: join(parent, 'agent2', 'ws') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    await expect(
      runChat({ agentsDir: parent, message: 'hi', configPath, root, out: capture().stream })
    ).rejects.toThrow(/multiple agents found.*--agent/s)
  }, 20_000)

  it('synchronously admits a curated runtime before creating the real host', async () => {
    const files = curatedScaffold('omp')
    const probeRuntimes = vi.fn(async (_runtimes, options) => {
      expect(options.curated).toBe(true)
      return [{ runtime: 'omp', ok: true, models: [] }]
    })
    let launchedArgs: string[] = []
    const hostFactory = vi.fn((runtime) => {
      launchedArgs = runtime.args
      return quietHost()
    })

    await runChat({
      ...files,
      message: 'hi',
      out: capture().stream,
      resolveCatalog: async () => catalog('omp'),
      installed: (runtimes) => runtimes,
      probeRuntimes,
      hostFactory
    })

    expect(probeRuntimes).toHaveBeenCalledOnce()
    expect(hostFactory).toHaveBeenCalledOnce()
    expect(launchedArgs.slice(-2)[0]).toBe('--config')
    expect(launchedArgs.at(-1)).toMatch(/omp-memory-off\.yml$/)
  })

  it('rejects a curated runtime with no initialized host state before probing or spawning', async () => {
    const files = curatedScaffold('hermes-agent')
    const probeRuntimes = vi.fn()
    const hostFactory = vi.fn()

    await expect(
      runChat({
        ...files,
        message: 'hi',
        out: capture().stream,
        resolveCatalog: async () => catalog('hermes-agent', 'hermes'),
        installed: () => ({}),
        probeRuntimes,
        hostFactory
      })
    ).rejects.toThrow(/not installed or initialized/i)
    expect(probeRuntimes).not.toHaveBeenCalled()
    expect(hostFactory).not.toHaveBeenCalled()
  })

  it('does not create the real host when curated ACP admission fails', async () => {
    const files = curatedScaffold('maki')
    const hostFactory = vi.fn()

    await expect(
      runChat({
        ...files,
        message: 'hi',
        out: capture().stream,
        resolveCatalog: async () => catalog('maki'),
        installed: (runtimes) => runtimes,
        probeRuntimes: async () => [{ runtime: 'maki', ok: false, models: [], error: 'initialize failed' }],
        hostFactory
      })
    ).rejects.toThrow(/probe has not succeeded.*initialize failed/i)
    expect(hostFactory).not.toHaveBeenCalled()
  })
})
