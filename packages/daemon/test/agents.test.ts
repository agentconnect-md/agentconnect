import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { loadAgents, discoverAgents, discoverAgentsTolerant, selectAgent } from '../src/agents/load-agents.js'
import { AgentSchema } from '../src/agents/agent-schema.js'

function writeAgent(dir: string, id: string, agent: unknown) {
  const adir = join(dir, id)
  mkdirSync(adir, { recursive: true })
  writeFileSync(join(adir, 'agent.json'), JSON.stringify(agent))
}

const slackAgent = (id: string, status = 'active') => ({
  id,
  name: id,
  status,
  runtime: 'claude',
  workspace: { mode: 'from-scratch', path: './workspace' },
  integrations: [
    {
      id: 'slack-main',
      platform: 'slack',
      core: { bindRules: [{ channel: 'C1', match: { kind: 'mention' } }] },
      config: { botToken: 'xoxb-x', appToken: 'xapp-x' }
    }
  ],
  output: { mode: 'medium' }
})

describe('loadAgents', () => {
  it('loads active agents and resolves workspace.path to absolute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    const agents = loadAgents(dir)
    expect(agents).toHaveLength(1)
    expect(agents[0]!.id).toBe('bot-a')
    expect(isAbsolute(agents[0]!.workspace.path)).toBe(true)
  })

  it('treats every agent.json string literally and ignores a sibling .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', { ...slackAgent('bot-a'), description: 'Review ${PR_NUMBER}' })
    writeFileSync(join(dir, 'bot-a', '.env'), 'PR_NUMBER=123\n')

    expect(loadAgents(dir)[0]?.description).toBe('Review ${PR_NUMBER}')
  })

  it('loads a historical working subdirectory without validating it at discovery time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', {
      ...slackAgent('bot-a'),
      workspace: {
        mode: 'git-repo',
        path: './workspace',
        gitRepo: 'https://github.com/acme/repo',
        gitBranch: 'main',
        agentDir: '../legacy'
      }
    })

    expect(loadAgents(dir)[0]?.workspace.agentDir).toBe('../legacy')
  })

  it('loads a prior-wire skill source so daemon startup can omit it during current admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', {
      ...slackAgent('bot-a'),
      skills: [
        { name: 'legacy', source: 'https://gitlab.com/acme/legacy' },
        { name: 'current', source: 'acme/current', skills: ['current'] }
      ]
    })

    expect(loadAgents(dir)[0]?.skills).toEqual([
      { name: 'legacy', source: 'https://gitlab.com/acme/legacy', skills: [] },
      { name: 'current', source: 'acme/current', skills: ['current'] }
    ])
  })

  it('skips inactive agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a', 'inactive'))
    expect(loadAgents(dir)).toHaveLength(0)
  })

  it('throws on a malformed agent.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bad', { id: 'bad' }) // missing required fields
    expect(() => loadAgents(dir)).toThrow(/bad/)
  })

  it('can isolate a malformed agent while returning the rest of the fleet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    writeAgent(dir, 'bad', { id: 'bad' })

    const result = discoverAgentsTolerant(dir)

    expect(result.agents.map(({ agent }) => agent.id)).toEqual(['bot-a'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.error.message).toMatch(/invalid agent\.json.*bad\/agent\.json/)
  })

  it.skipIf(process.platform === 'win32')('repairs a legacy detached agent.json without discovering it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    const archivedDir = join(dir, '.detached', 'bot-old', 'agent')
    mkdirSync(archivedDir, { recursive: true })
    const archivedFile = join(archivedDir, 'agent.json')
    writeFileSync(
      archivedFile,
      JSON.stringify({ ...slackAgent('bot-old'), runtimeOverrides: { secrets: { API_TOKEN: 'secret' } } })
    )
    chmodSync(archivedFile, 0o644)

    expect(loadAgents(dir).map((agent) => agent.id)).toEqual(['bot-a'])
    expect(statSync(archivedFile).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('preserves an owner-only read-only agent.json while loading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-agents-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    const file = join(dir, 'bot-a', 'agent.json')
    chmodSync(file, 0o400)

    expect(loadAgents(dir)).toHaveLength(1)
    expect(statSync(file).mode & 0o777).toBe(0o400)
  })
})

describe('discoverAgents (recursive, bounded)', () => {
  it('finds nested agent.json and ignores node_modules/.git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-discover-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    // nested two levels deep
    mkdirSync(join(dir, 'team', 'bot-b'), { recursive: true })
    writeFileSync(join(dir, 'team', 'bot-b', 'agent.json'), JSON.stringify(slackAgent('bot-b')))
    // these must be ignored
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'agent.json'), JSON.stringify(slackAgent('nope')))
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'agent.json'), JSON.stringify(slackAgent('nope2')))

    const ids = discoverAgents(dir)
      .map((d) => d.agent.id)
      .sort()
    expect(ids).toEqual(['bot-a', 'bot-b'])
  })

  it('treats a dir pointing straight at one agent.json as that agent (depth 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-discover-'))
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(slackAgent('solo')))
    expect(discoverAgents(dir).map((d) => d.agent.id)).toEqual(['solo'])
  })

  it('does not let an unsafe root-level CP marker hide local child agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-discover-'))
    writeFileSync(join(dir, '.cp-agent-id'), 'legacy-bad-root\n')
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))

    expect(discoverAgents(dir).map((d) => d.agent.id)).toEqual(['bot-a'])
  })
})

describe('selectAgent', () => {
  it('returns the named agent regardless of status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-select-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a', 'inactive'))
    expect(selectAgent(dir, 'bot-a').status).toBe('inactive')
  })

  it('errors with available ids when the named agent is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-select-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    expect(() => selectAgent(dir, 'ghost')).toThrow(/not found.*Available: bot-a/s)
  })

  it('returns the only agent when no name is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-select-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    expect(selectAgent(dir).id).toBe('bot-a')
  })

  it('errors and suggests --agent when several are found and no name given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-select-'))
    writeAgent(dir, 'bot-a', slackAgent('bot-a'))
    writeAgent(dir, 'bot-b', slackAgent('bot-b'))
    expect(() => selectAgent(dir)).toThrow(/multiple agents found.*bot-a, bot-b.*--agent/s)
  })

  it('errors when no agent.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-select-'))
    expect(() => selectAgent(dir)).toThrow(/no agent\.json found/)
  })
})

describe('AgentSchema defaults', () => {
  it('defaults output/footer and chat runtime controls safely when omitted', () => {
    const parsed = AgentSchema.parse({
      id: 'x',
      name: 'x',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      integrations: []
    })
    expect(parsed.output.mode).toBe('low')
    expect(parsed.output.showFooter).toBe(true)
    expect(parsed.output.showStatusBar).toBe(false)
    expect(parsed.allowRuntimeChangesInChat).toBe(false)
    expect(parsed.runInSandbox).toBe(false)
    expect(parsed.callPolicy).toBe('all')
    expect(parsed.allowedCallerAgentIds).toEqual([])
    expect(parsed.outboundPolicy).toBe('all')
    expect(parsed.allowedTargetAgentIds).toEqual([])
  })

  it('defaults permissionMode to default when omitted', () => {
    const parsed = AgentSchema.parse({
      id: 'x',
      name: 'x',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      integrations: []
    })
    expect(parsed.permissionMode).toBe('default')
  })

  it('round-trips the CP-replicated additional-repository allowlist, defaulting to none', () => {
    const base = { id: 'x', name: 'x', status: 'active', runtime: 'claude', integrations: [] }
    // A provider-less entry is what a pre-GitLab control plane replicates, and it
    // means github; a gitlab project keeps its own qualifier.
    const additionalRepos = [
      { repoFullName: 'example-co/shared-library', repoId: '815' },
      { repoFullName: 'example-group/example-project', repoId: '4455667', provider: 'gitlab' }
    ]

    expect(
      AgentSchema.parse({ ...base, workspace: { mode: 'from-scratch', path: './workspace' } }).workspace.additionalRepos
    ).toEqual([])
    expect(
      AgentSchema.parse({ ...base, workspace: { mode: 'from-scratch', path: './workspace', additionalRepos } })
        .workspace.additionalRepos
    ).toEqual([
      { repoFullName: 'example-co/shared-library', repoId: '815', provider: 'github' },
      { repoFullName: 'example-group/example-project', repoId: '4455667', provider: 'gitlab' }
    ])
  })
})
