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

  // The wrapper no longer parses argv: it hands the whole thing to the CLI, which resolves
  // the target with cp/gh-target.ts. `process.argv` here is [node, cli, gh-token, agentId, --, …].
  const setup = () => {
    root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
    const realBin = join(root, 'real-bin')
    const argvCapture = join(root, 'argv.json')
    const capabilityCapture = join(root, 'capability.txt')
    const tokenCapture = join(root, 'token.txt')
    const cliEntry = join(root, 'fake-cli.mjs')
    mkdirSync(realBin)

    writeFileSync(
      cliEntry,
      `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(4)))\n` +
        `writeFileSync(process.env.CAPABILITY_CAPTURE, process.env.AC_GITCRED_CAPABILITY ?? '')\n` +
        `process.stdout.write('token-for-' + process.argv[3])\n`
    )
    const realGh = join(realBin, 'gh')
    writeFileSync(realGh, '#!/bin/sh\nprintf %s "$GH_TOKEN" > "$TOKEN_CAPTURE"\n')
    chmodSync(realGh, 0o755)

    const shimDir = ghShimDir(root)
    const shim = join(writeGhShim(root, cliEntry), 'gh')
    const run = (args: string[]) =>
      execFileSync(shim, args, {
        env: {
          ...process.env,
          PATH: `${shimDir}:${realBin}`,
          AC_AGENT_ID: 'agent-1',
          AC_GITCRED_CAPABILITY: 'cap-agent-1',
          ARGV_CAPTURE: argvCapture,
          CAPABILITY_CAPTURE: capabilityCapture,
          TOKEN_CAPTURE: tokenCapture
        }
      })
    const captured = () => ({
      argv: JSON.parse(readFileSync(argvCapture, 'utf8')) as string[],
      capability: readFileSync(capabilityCapture, 'utf8'),
      token: readFileSync(tokenCapture, 'utf8')
    })
    return { run, captured }
  }

  it('forwards the whole gh argv after `--` and exports the returned token', () => {
    const { run, captured } = setup()
    run(['repo', 'view', '--json', 'nameWithOwner', 'acme/infra'])

    expect(captured().argv).toEqual(['--', 'repo', 'view', '--json', 'nameWithOwner', 'acme/infra'])
    expect(captured().capability).toBe('cap-agent-1')
    expect(captured().token).toBe('token-for-agent-1')
  })

  it("passes gh's own flags through verbatim rather than eating them", () => {
    const { run, captured } = setup()
    run(['api', '-X', 'GET', 'repos/acme/infra/pulls/64', '--jq', '.title'])

    expect(captured().argv).toEqual(['--', 'api', '-X', 'GET', 'repos/acme/infra/pulls/64', '--jq', '.title'])
  })
})
