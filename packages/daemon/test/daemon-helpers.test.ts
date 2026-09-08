import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ignoreAgentWatchPath } from '../src/daemon/helpers.js'

const agentsDir = join('/home/agent/workspace', 'agents')
const agent = join(agentsDir, 'bot-a')
const dir = { isDirectory: () => true } as never
const file = { isDirectory: () => false } as never

describe('ignoreAgentWatchPath', () => {
  it.each(['memory', 'channels', 'memory-backups', 'memory-dreams', 'memory-archive-2026-09-09T10-00-00-000Z'])(
    'ignores the daemon-owned %s dir and everything beneath it',
    (name) => {
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name), dir)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name), undefined)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name, 'deploys.md'), file)).toBe(true)
      expect(ignoreAgentWatchPath(agentsDir, join(agent, name, 'C123', 'memory'), dir)).toBe(true)
    }
  )

  it('still watches agent.json at the agent root and unrelated directories', () => {
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'agent.json'), file)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, agent, dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'workspace'), dir)).toBe(false)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'workspace', 'src'), dir)).toBe(false)
  })

  it('keeps the existing rules: node_modules, dot segments, and files other than agent.json', () => {
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'node_modules'), dir)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, '.git', 'HEAD'), file)).toBe(true)
    expect(ignoreAgentWatchPath(agentsDir, join(agent, 'workspace', 'README.md'), file)).toBe(true)
  })
})
