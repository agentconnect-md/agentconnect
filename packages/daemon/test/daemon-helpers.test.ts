import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ignoreAgentWatchPath } from '../src/daemon/helpers.js'

// A real tree: the exclusion applies only beneath a directory that actually holds an `agent.json`.
let agentsDir = ''
let agent = ''
const dir = { isDirectory: () => true } as never
const file = { isDirectory: () => false } as never

beforeAll(() => {
  agentsDir = mkdtempSync(join(tmpdir(), 'ac-watch-'))
  agent = join(agentsDir, 'bot-a')
  mkdirSync(agent)
  writeFileSync(join(agent, 'agent.json'), '{}')
})
afterAll(() => rmSync(agentsDir, { recursive: true, force: true }))

describe('ignoreAgentWatchPath', () => {
  it('treats a Control-Plane-managed root (`.cp-agent-id`, no agent.json) as an agent root too', () => {
    const managed = join(agentsDir, 'cp-bot')
    mkdirSync(join(managed, 'memory'), { recursive: true })
    writeFileSync(join(managed, '.cp-agent-id'), 'cp-bot')
    expect(ignoreAgentWatchPath(agentsDir, join(managed, 'memory'), dir)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(managed, 'channels', 'c1'), dir)).toBe(true)
  })

  it('keeps watching a grouping directory whose agent happens to be named like a daemon-owned dir', () => {
    // Recursive discovery: `agents/team/memory/agent.json` is an agent, not bot-a's memory tree — no agent.json above it.
    const team = join(agentsDir, 'team')
    mkdirSync(join(team, 'memory'), { recursive: true })
    writeFileSync(join(team, 'memory', 'agent.json'), '{}')
    expect(ignoreAgentWatchPath(agentsDir, join(team, 'memory'), dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(team, 'memory', 'agent.json'), file)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(team, 'channels'), dir)).toBe(false)
  })

  it.each(['memory', 'channels', 'memory-backups', 'memory-dreams', 'memory-archive-2026-09-09T10-00-00-000Z'])(
    'ignores the daemon-owned %s dir and everything beneath it',
    (name) => {
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name), dir)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name), undefined)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name, 'deploys.md'), file)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name, 'C123', 'memory'), dir)).toBe(true)
    }
  )

  it('still watches the tree root, the agent root, and its agent.json', () => {
    expect(ignoreAgentWatchPath(agentsDir, agentsDir, dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, agent, dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'agent.json'), file)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'agent.json'), undefined)).toBe(false)
  })

  it.each([
    ['workspace', 'src'],
    ['worktrees', 'w-1', 'packages'],
    ['repos', 'acme', 'app', 'worktrees', 'w-1'],
    ['clones', 'c-1', 'app'],
    ['home', 'Library']
  ])('ignores session checkouts and runtime state beneath an agent root: %s/…', (...segments) => {
    // One fs.watch per directory: descending here cost one handle per checkout dir and hit EMFILE on macOS.
    for (let i = 1; i <= segments.length; i++)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, ...segments.slice(0, i)), dir)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, ...segments, 'agent.json'), file)).toBe(true)
  })

  it('ignores everything beneath a Control-Plane-managed root, which discovery never descends', () => {
    const managed = join(agentsDir, 'cp-worker')
    mkdirSync(managed)
    writeFileSync(join(managed, '.cp-agent-id'), 'cp-worker')
    expect(ignoreAgentWatchPath(agentsDir, managed, dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(managed, 'worktrees'), dir)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(managed, 'workspace', 'agent.json'), file)).toBe(true)
  })

  it('watches a new directory before its agent.json lands, so the add is seen', () => {
    const fresh = join(agentsDir, 'group', 'fresh')
    mkdirSync(fresh, { recursive: true })
    expect(ignoreAgentWatchPath(agentsDir, join(agentsDir, 'group'), dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, fresh, dir)).toBe(false)
    writeFileSync(join(fresh, 'agent.json'), '{}')
    expect(ignoreAgentWatchPath(agentsDir, join(fresh, 'agent.json'), file)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(fresh, 'workspace'), dir)).toBe(true)
  })

  it('keeps the existing rules: node_modules, dot segments, and files other than agent.json', () => {
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'node_modules'), dir)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, '.git', 'HEAD'), file)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'workspace', 'README.md'), file)).toBe(true)
  })
})
