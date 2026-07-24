import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ghShimDir, writeGhShim } from '../../src/cp/gh-shim.js'

describe('gh wrapper shim', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('routes a gh repo positional argument after value flags to that repository token', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
    const realBin = join(root, 'real-bin')
    const repoCapture = join(root, 'repo.txt')
    const capabilityCapture = join(root, 'capability.txt')
    const tokenCapture = join(root, 'token.txt')
    const cliEntry = join(root, 'fake-cli.mjs')
    mkdirSync(realBin)

    writeFileSync(
      cliEntry,
      `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync(process.env.REPO_CAPTURE, process.argv[4] ?? '')\n` +
        `writeFileSync(process.env.CAPABILITY_CAPTURE, process.env.AC_GITCRED_CAPABILITY ?? '')\n` +
        `process.stdout.write('token-for-' + (process.argv[4] ?? 'workspace'))\n`
    )
    const realGh = join(realBin, 'gh')
    writeFileSync(realGh, '#!/bin/sh\nprintf %s "$GH_TOKEN" > "$TOKEN_CAPTURE"\n')
    chmodSync(realGh, 0o755)

    const shimDir = ghShimDir(root)
    const shim = join(writeGhShim(root, cliEntry), 'gh')
    execFileSync(shim, ['repo', 'view', '--json', 'nameWithOwner', 'acme/infra'], {
      env: {
        ...process.env,
        PATH: `${shimDir}:${realBin}`,
        AC_AGENT_ID: 'agent-1',
        AC_GITCRED_CAPABILITY: 'cap-agent-1',
        REPO_CAPTURE: repoCapture,
        CAPABILITY_CAPTURE: capabilityCapture,
        TOKEN_CAPTURE: tokenCapture
      }
    })

    expect(readFileSync(repoCapture, 'utf8')).toBe('acme/infra')
    expect(readFileSync(capabilityCapture, 'utf8')).toBe('cap-agent-1')
    expect(readFileSync(tokenCapture, 'utf8')).toBe('token-for-acme/infra')
  })
})
