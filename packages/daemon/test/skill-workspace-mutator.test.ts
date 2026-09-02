import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalSkillMutationRoot, runSkillWorkspaceMutation } from '../src/skills/skill-workspace-mutator.js'
import { withSkillMutationHelperLease } from '../src/skills/skill-workspace-lock-lease.js'

// The start gate only exists inside the sandbox wrapper; pin the ungated launch so every host runs the race.
vi.mock('../src/skills/offline-sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/skills/offline-sandbox.js')>()),
  probeOfflineSandboxHost: () => ({ available: false, reason: 'pinned off for this test' })
}))

const roots: string[] = []

async function workspace(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ac-skill-alias-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return { root, cwd }
}

// Starve the event loop the way a loaded CI worker does: no stream teardown can run while we sleep.
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('canonicalSkillMutationRoot', () => {
  it('maps a workspace-local skill-root alias to its real relative path', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink('../.claude/skills', join(cwd, '.agents/skills'))

    await expect(canonicalSkillMutationRoot(cwd, '.agents/skills/audit')).resolves.toBe('.claude/skills/audit')
  })

  it('leaves an ordinary or not-yet-created skill root unchanged', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, '.claude/skills'), { recursive: true })

    await expect(canonicalSkillMutationRoot(cwd, '.claude/skills/audit')).resolves.toBe('.claude/skills/audit')
    await expect(canonicalSkillMutationRoot(cwd, '.runtime/skills/audit')).resolves.toBe('.runtime/skills/audit')
  })

  it('refuses a skill-root alias that resolves outside the workspace', async () => {
    const { root, cwd } = await workspace()
    await mkdir(join(root, 'outside/skills'), { recursive: true })
    await mkdir(join(cwd, '.agents'))
    await symlink(join(root, 'outside/skills'), join(cwd, '.agents/skills'))

    await expect(canonicalSkillMutationRoot(cwd, '.agents/skills/audit')).rejects.toThrow(
      /alias resolves outside workspace/
    )
  })
})

describe('runSkillWorkspaceMutation', () => {
  // The race is POSIX pipe semantics: only there does writing to a dead reader raise on the parent.
  it.skipIf(process.platform === 'win32')(
    'keeps the result of an ungated helper that exited before its start gate was written',
    async () => {
      const { cwd } = await workspace()
      const canonical = await realpath(cwd)
      const stat = await lstat(canonical, { bigint: true })
      const operationId = randomUUID()
      // Hold the gate past the helper's own exit, so writing it can only ever break the pipe.
      const lease = {
        registerHelper: async () => blockEventLoop(2_000),
        clearHelper: async () => {}
      }

      const result = await withSkillMutationHelperLease(lease, () =>
        runSkillWorkspaceMutation({
          action: 'reserve',
          cwd: canonical,
          workspaceIdentity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
          relativeRoot: '.claude/skills/audit',
          operationId,
          reservationName: `.agentconnect-skill-new-${operationId}`,
          quarantineName: `.agentconnect-skill-old-${operationId}`
        })
      )

      expect(result.identity).toMatchObject({ dev: expect.any(String), ino: expect.any(String) })
      await expect(lstat(join(canonical, '.claude/skills/audit'))).resolves.toBeTruthy()
    }
  )
})
