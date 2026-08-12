import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceReader, WorkspaceViolationError } from '../src/cp/workspace-reader.js'
import { createLocalSkillsReader } from '../src/cp/local-skills-reader.js'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { setSandboxWorkspaceMode, setWorkspaceGitRunnerResolver } from '../src/workspace/workspace-manager.js'
import { localWorkspaceFiles, type WorkspaceFiles } from '../src/workspace/workspace-files.js'

/**
 * The routing half: the reader must ask the filesystem the agent's workspace is ON.
 *
 * Before this the reader always used `node:fs`, so a cluster agent's Files panel listed an empty
 * daemon-side directory and its skills list reported "not prepared yet" — both about a machine the
 * workspace was not on. The fixtures here stand in for the pod: a root the resolver names, reachable
 * only through the injected seam.
 */

const roots: string[] = []
const AGENT = 'bot-cluster'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Two directories: the one this daemon would have read, and the one the workspace is really in. */
function split(): { daemonSide: string; podSide: string } {
  const base = mkdtempSync(join(tmpdir(), 'ac-route-'))
  roots.push(base)
  const daemonSide = join(base, 'daemon-disk')
  const podSide = join(base, 'pod-volume')
  mkdirSync(daemonSide, { recursive: true })
  mkdirSync(podSide, { recursive: true })
  // Present ONLY on the daemon's disk: an answer mentioning this proves the wrong filesystem.
  writeFileSync(join(daemonSide, 'STALE-DAEMON-COPY.txt'), 'wrong filesystem\n')
  writeFileSync(join(podSide, 'app.ts'), 'export const real = true\n')
  return { daemonSide, podSide }
}

/** A seam bound to one root, standing in for the shim channel: same operations, other filesystem. */
function filesAt(podSide: string): WorkspaceFiles {
  return {
    list: (_root, req) => localWorkspaceFiles.list(podSide, req),
    read: (_root, req) => localWorkspaceFiles.read(podSide, req),
    write: (_root, scratch, req) => localWorkspaceFiles.write(podSide, scratch, req),
    delete: (_root, scratch, req) => localWorkspaceFiles.delete(podSide, scratch, req)
  }
}

const pass = <T>(_id: string, write: () => Promise<T>): Promise<T> => write()

describe('createWorkspaceReader routing', () => {
  it('lists the workspace filesystem, not this daemon disk', async () => {
    const { daemonSide, podSide } = split()
    const reader = createWorkspaceReader(
      () => ({ root: daemonSide, scratch: true }),
      pass,
      () => filesAt(podSide)
    )
    const page = await reader.list({ agentId: AGENT, path: '', limit: 50 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['app.ts'])
  })

  it('reads and WRITES there too, so an edit is not published to a directory nobody runs in', async () => {
    const { daemonSide, podSide } = split()
    const reader = createWorkspaceReader(
      () => ({ root: daemonSide, scratch: true }),
      pass,
      () => filesAt(podSide)
    )
    expect(await reader.read({ agentId: AGENT, path: 'app.ts', offset: 0, limit: 65_536 })).toMatchObject({
      exists: true,
      content: 'export const real = true\n'
    })
    await reader.write({ agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('hi\n').toString('base64') })
    expect(readFileSync(join(podSide, 'notes.md'), 'utf8')).toBe('hi\n')
    // The silent-wrong-placement failure this replaces: the file used to land here instead.
    expect(() => readFileSync(join(daemonSide, 'notes.md'))).toThrow()
  })

  it('keeps the scratch gate on the daemon side, before anything is shipped', async () => {
    const { daemonSide, podSide } = split()
    let asked = false
    const files = filesAt(podSide)
    const reader = createWorkspaceReader(
      () => ({ root: daemonSide, scratch: false }),
      pass,
      () => ({
        ...files,
        write: (...args) => {
          asked = true
          return files.write(...args)
        }
      })
    )
    await expect(
      reader.write({ agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('x').toString('base64') })
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
    // Not merely refused — never asked. A read-only workspace must not spend a round trip, and the
    // bytes of a rejected edit must not travel at all.
    expect(asked).toBe(false)
  })

  it('falls back to this filesystem when no seam is registered, so self-hosting needs no wiring', async () => {
    const { daemonSide } = split()
    const reader = createWorkspaceReader(() => ({ root: daemonSide, scratch: true }), pass)
    const page = await reader.list({ agentId: AGENT, path: '', limit: 50 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['STALE-DAEMON-COPY.txt'])
  })
})

describe('createLocalSkillsReader routing', () => {
  function skill(root: string, dir: string, name: string, description: string): void {
    mkdirSync(join(root, '.claude', 'skills', dir), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'skills', dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
    )
  }

  it('inventories the skills the agent harness will actually load, in the pod', async () => {
    const { daemonSide, podSide } = split()
    // Repo-committed skills DO exist for a cluster agent — they arrive with the checkout, even though
    // the daemon installs none there. Reported as `repo`, which is what they are.
    skill(podSide, 'deploy', 'deploy', 'ship it')
    skill(daemonSide, 'ghost', 'ghost', 'must not appear')
    const reader = createLocalSkillsReader(
      () => podSide,
      join(daemonSide, 'skill-installs'),
      () => filesAt(podSide)
    )
    expect(await reader.list({ agentId: AGENT })).toEqual({
      materialized: true,
      skills: [{ name: 'deploy', description: 'ship it', origin: 'repo', path: '.claude/skills/deploy' }]
    })
  })

  it('reports an unprepared workspace as unmaterialized rather than as empty', async () => {
    const { daemonSide } = split()
    const missing = join(daemonSide, 'not-created-yet')
    const reader = createLocalSkillsReader(
      () => missing,
      daemonSide,
      () => filesAt(missing)
    )
    expect(await reader.list({ agentId: AGENT })).toEqual({ materialized: false, skills: [] })
  })

  it('still reads this daemon own workspace when no seam is registered', async () => {
    const { daemonSide } = split()
    skill(daemonSide, 'local-one', 'local-one', 'on this disk')
    const reader = createLocalSkillsReader(() => daemonSide, join(daemonSide, 'skill-installs'))
    const answer = await reader.list({ agentId: AGENT })
    expect(answer.materialized).toBe(true)
    expect(answer.skills.map((entry) => entry.name)).toEqual(['local-one'])
  })
})

describe('an unreachable sandbox workspace', () => {
  // The pod is suspended, or was never launched. Nothing is broken and the workspace is not empty —
  // it is simply not reachable from here until the agent's next turn wakes it. Both seams have to say
  // that, because the alternatives are the two answers a reader cannot act on: "not a git checkout"
  // and an empty file tree, each about a workspace that is fine.
  afterEach(() => {
    setSandboxWorkspaceMode(false)
    setWorkspaceGitRunnerResolver(undefined)
  })

  it('is a refusal with a machine-readable reason, not an empty listing', async () => {
    const { daemonSide } = split()
    setSandboxWorkspaceMode(true)
    // No seam registered for this agent — exactly what the plane answers with no bound channel.
    const reader = createWorkspaceReader(() => ({ root: '/agent', scratch: true }), pass)
    for (const read of [
      () => reader.list({ agentId: AGENT, path: '', limit: 50 }),
      () => reader.read({ agentId: AGENT, path: 'app.ts', offset: 0, limit: 65_536 })
    ]) {
      await expect(read()).rejects.toMatchObject({
        name: 'WorkspaceViolationError',
        reason: 'sandbox-unavailable'
      })
    }
    // A write refuses the same way rather than publishing to this daemon's disk.
    await expect(
      reader.write({ agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('x').toString('base64') })
    ).rejects.toMatchObject({ reason: 'sandbox-unavailable' })
    expect(existsSync(join(daemonSide, 'notes.md'))).toBe(false)
  })

  it('refuses the git seam too, instead of reporting "not a git checkout" for a sleeping pod', async () => {
    setSandboxWorkspaceMode(true)
    const git = createWorkspaceGit(() => '/agent/repo')
    await expect(git.status(AGENT)).rejects.toMatchObject({ reason: 'sandbox-unavailable' })
    await expect(git.log({ agentId: AGENT, limit: 20 })).rejects.toMatchObject({ reason: 'sandbox-unavailable' })
    await expect(git.diff({ agentId: AGENT, path: 'a.ts', staged: false })).rejects.toMatchObject({
      reason: 'sandbox-unavailable'
    })
    // A write must not fall through to a local runner and mutate whatever is at that path here.
    await expect(git.commit({ agentId: AGENT, message: 'nope' })).rejects.toMatchObject({
      reason: 'sandbox-unavailable'
    })
  })

  it('says nothing of the kind once a channel is bound', async () => {
    const { daemonSide, podSide } = split()
    setSandboxWorkspaceMode(true)
    const reader = createWorkspaceReader(
      () => ({ root: daemonSide, scratch: true }),
      pass,
      () => filesAt(podSide)
    )
    expect((await reader.list({ agentId: AGENT, path: '', limit: 50 })).exists).toBe(true)
  })

  it('never fires on a self-hosted daemon, whose workspace is always right here', async () => {
    const { daemonSide } = split()
    // Cluster mode off: the resolver being empty is the NORMAL state, not an unreachable workspace.
    const reader = createWorkspaceReader(() => ({ root: daemonSide, scratch: true }), pass)
    expect((await reader.list({ agentId: AGENT, path: '', limit: 50 })).exists).toBe(true)
  })
})
