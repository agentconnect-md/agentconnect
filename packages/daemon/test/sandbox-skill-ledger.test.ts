import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { skillLedgerLocation, treeDigest } from '../src/skills/skill-install-ledger.js'
import { legacySandboxSkillLedger } from '../src/skills/sandbox-skill-ledger.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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

it('refuses an unfinished host publication instead of treating its pending content as unowned', async () => {
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
  await expect(legacySandboxSkillLedger('agent', cwd, state)).rejects.toThrow('unfinished host skill installation')
})
