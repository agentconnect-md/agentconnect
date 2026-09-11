import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { skillLedgerLocation, treeDigest } from '../src/skills/skill-install-ledger.js'
import { legacySandboxSkillLedger } from '../src/skills/sandbox-skill-ledger.js'
import { microsandboxSkillTarget, type MicrosandboxShim } from '../src/microsandbox/shim.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('retains skill authority across VM replacement but revokes it when storage is replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-sandbox-identity-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const shim = { session: { hasCapability: () => true }, incarnation: 'first-vm' } as unknown as MicrosandboxShim
  const first = await microsandboxSkillTarget(shim, cwd)
  const replacement = { ...shim, incarnation: 'replacement-vm' }
  expect((await microsandboxSkillTarget(replacement, cwd)).workspaceIncarnation).toBe(first.workspaceIncarnation)
  await rename(cwd, join(root, 'retired'))
  await mkdir(cwd)
  expect((await microsandboxSkillTarget(replacement, cwd)).workspaceIncarnation).not.toBe(first.workspaceIncarnation)
})

it('adopts only a ready daemon-owned receipt for the same workspace and agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-sandbox-ledger-'))
  roots.push(root)
  const cwd = join(root, 'workspace'),
    state = join(root, 'state')
  await mkdir(cwd)
  expect(await legacySandboxSkillLedger('agent', cwd, state)).toBeUndefined()
  const location = await skillLedgerLocation(cwd, state)
  const info = await lstat(cwd, { bigint: true })
  const files = [{ path: 'SKILL.md', mode: 0o600, size: 1, sha256: 'a'.repeat(64) }]
  const ledger = {
    version: 3,
    phase: 'ready',
    workspaceRealpath: location.workspaceRealpath,
    workspaceIdentity: location.workspaceIdentity,
    agentId: 'agent',
    runtime: 'codex',
    cliVersion: '1.5.21',
    gitResolutions: [],
    owned: [
      {
        relativeRoot: '.agents/skills/fixture',
        sourceKey: 'managed:fixture',
        treeDigest: treeDigest(files),
        files,
        identity: { dev: String(info.dev), ino: String(info.ino) }
      }
    ]
  }
  await writeFile(location.file, JSON.stringify(ledger), { mode: 0o600 })
  expect((await legacySandboxSkillLedger('agent', cwd, state))?.roots[0]).toMatchObject({
    path: '.agents/skills/fixture',
    files,
    digest: treeDigest(files)
  })
  await expect(legacySandboxSkillLedger('another-agent', cwd, state)).rejects.toThrow('another agent')
  await writeFile(location.file, JSON.stringify({ ...ledger, workspaceIdentity: { dev: '0', ino: '0' } }))
  await expect(legacySandboxSkillLedger('agent', cwd, state)).rejects.toThrow()
})

it('recovers an interrupted host publication before transferring its receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-sandbox-ledger-'))
  roots.push(root)
  const cwd = join(root, 'workspace'),
    state = join(root, 'state')
  await mkdir(cwd)
  const location = await skillLedgerLocation(cwd, state)
  await writeFile(
    location.file,
    JSON.stringify({
      version: 3,
      phase: 'applying',
      workspaceRealpath: location.workspaceRealpath,
      workspaceIdentity: location.workspaceIdentity,
      agentId: 'agent',
      runtime: 'codex',
      cliVersion: '1.5.21',
      priorGitResolutions: [],
      prior: [],
      pending: [],
      operations: []
    }),
    { mode: 0o600 }
  )
  expect(await legacySandboxSkillLedger('agent', cwd, state)).toEqual({ roots: [], gitResolutions: [] })
})
