import { describe, expect, it, vi } from 'vitest'
import { wireWorkspacePlane, type ExecutionPlane } from '../src/execution/plane.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { LocalWorkspaceFs, localWorkspaceFs } from '../src/workspace/workspace-fs.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

describe('wireWorkspacePlane', () => {
  it("answers the workspace manager's git, filesystem and session-retirement slots from the plane", async () => {
    const runner = {} as GitRunner
    const fs = new LocalWorkspaceFs()
    const gitRunnerFor = vi.fn<ExecutionPlane['gitRunnerFor']>(() => runner)
    const workspaceFsFor = vi.fn<ExecutionPlane['workspaceFsFor']>(() => ({ fs, mount: '/agent' }))
    const discardSessions = vi.fn<ExecutionPlane['discardSessions']>(async () => {})
    const workspaces = new WorkspaceManager()
    const setDiscarder = vi.spyOn(workspaces, 'setSessionsDiscarder')
    wireWorkspacePlane(workspaces, { spawnFor: vi.fn(), gitRunnerFor, workspaceFsFor, discardSessions })

    const abort = new AbortController().signal
    expect(workspaces.resolveGitRunner('agent-a', '/agent/checkout', abort)).toBe(runner)
    expect(gitRunnerFor).toHaveBeenCalledWith('agent-a', '/agent/checkout', abort)
    expect(workspaces.fsFor('agent-a')).toBe(fs)
    expect(workspaces.sandboxMountFor('agent-a')).toBe('/agent')
    await setDiscarder.mock.calls[0]![0]!('agent-a', 'session-kept')
    expect(discardSessions).toHaveBeenCalledWith('agent-a', 'session-kept')

    // An agent the plane does not place keeps this daemon's own runner and disk.
    gitRunnerFor.mockReturnValue(undefined)
    workspaceFsFor.mockReturnValue(undefined)
    expect(workspaces.resolveGitRunner('agent-b')).toBeUndefined()
    expect(workspaces.fsFor('agent-b')).toBe(localWorkspaceFs)
    expect(workspaces.sandboxMountFor('agent-b')).toBeUndefined()
    // The wiring leaves the mode and the path clearer alone: only a cluster sets those.
    expect(workspaces.sandboxMode).toBe(false)
    expect(await workspaces.clearPath('agent-a', '/agent/checkout')).toBeUndefined()
  })
})
