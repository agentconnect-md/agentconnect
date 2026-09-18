import { describe, expect, it, vi } from 'vitest'
import { wireWorkspacePlane, type ExecutionPlane, type PlaneScope } from '../src/execution/plane.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { LocalWorkspaceFs, localWorkspaceFs } from '../src/workspace/workspace-fs.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
import { testPlane } from './workspace-plane-support.js'

describe('wireWorkspacePlane', () => {
  it("answers the workspace manager's git, filesystem and path-clearing questions from the plane", async () => {
    const runner = {} as GitRunner
    const fs = new LocalWorkspaceFs()
    const gitRunnerFor = vi.fn<ExecutionPlane['gitRunnerFor']>(() => runner)
    const workspaceFsFor = vi.fn<ExecutionPlane['workspaceFsFor']>(() => ({ fs, mount: '/agent' }))
    const clearPath = vi.fn<NonNullable<ExecutionPlane['clearPath']>>(async () => 'read-only volume')
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, testPlane({ workspacesOffDisk: true, gitRunnerFor, workspaceFsFor, clearPath }))

    const abort = new AbortController().signal
    expect(workspaces.resolveGitRunner('agent-a', '/agent/checkout', abort)).toBe(runner)
    expect(gitRunnerFor).toHaveBeenCalledWith('agent-a', '/agent/checkout', abort)
    expect(workspaces.fsFor('agent-a')).toBe(fs)
    expect(workspaces.sandboxMountFor('agent-a')).toBe('/agent')
    expect(await workspaces.clearPath('agent-a', '/agent/checkout')).toBe('read-only volume')
    expect(clearPath).toHaveBeenCalledWith('agent-a', '/agent/checkout')
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(true)

    // An agent the plane does not place keeps this daemon's own runner and disk, yet still reads as off-disk: that is the plane's answer, not a bound channel's.
    gitRunnerFor.mockReturnValue(undefined)
    workspaceFsFor.mockReturnValue(undefined)
    expect(workspaces.resolveGitRunner('agent-b')).toBeUndefined()
    expect(workspaces.fsFor('agent-b')).toBe(localWorkspaceFs)
    expect(workspaces.sandboxMountFor('agent-b')).toBeUndefined()
    expect(workspaces.offDisk({ agentId: 'agent-b' })).toBe(true)
  })

  it('keeps a plane whose files are on this disk out of the off-disk answer, and clears nothing through it', async () => {
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, testPlane({ gitRunnerFor: () => ({}) as GitRunner }))

    // Having a plane and living off this disk are two properties: a VM that mounts host directories has the first only.
    expect(workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')).toBeDefined()
    expect(workspaces.offDisk({ agentId: 'agent-a', path: '/agents/a/workspace' })).toBe(false)
    expect(await workspaces.clearPath('agent-a', '/agents/a/workspace')).toBeUndefined()

    workspaces.setPlaneResolver(undefined)
    expect(workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')).toBeUndefined()
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(false)
  })
})

describe('the plane resolver', () => {
  it('is asked with the narrowest scope each question holds, and may answer per scope', async () => {
    const asked: PlaneScope[] = []
    const remote = testPlane({ workspacesOffDisk: true, clearPath: async () => undefined })
    const workspaces = new WorkspaceManager()
    // Only one session is placed off this disk; the agent's other scopes stay local.
    workspaces.setPlaneResolver((scope) => {
      asked.push(scope)
      return scope.sessionKey === 'remote-session' ? remote : undefined
    })

    expect(workspaces.offDisk({ agentId: 'agent-a', sessionKey: 'remote-session' })).toBe(true)
    expect(workspaces.offDisk({ agentId: 'agent-a', sessionKey: 'local-session' })).toBe(false)
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(false)
    workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')
    workspaces.fsFor('agent-a')
    await workspaces.clearPath('agent-a', '/agents/a/sessions/leaf')

    expect(asked).toEqual([
      { agentId: 'agent-a', sessionKey: 'remote-session' },
      { agentId: 'agent-a', sessionKey: 'local-session' },
      { agentId: 'agent-a' },
      { agentId: 'agent-a', path: '/agents/a/workspace' },
      { agentId: 'agent-a' },
      { agentId: 'agent-a', path: '/agents/a/sessions/leaf' }
    ])
  })
})
