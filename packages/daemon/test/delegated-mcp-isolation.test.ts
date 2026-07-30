import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  delegatedCellSandboxWrap,
  sandboxWrap,
  SandboxError,
  supportsDelegatedMcpIsolation
} from '../src/acp/sandbox.js'

describe('supportsDelegatedMcpIsolation', () => {
  it.each([
    {
      name: 'macOS sandbox-exec',
      platform: 'darwin' as const,
      mechanism: 'sandbox-exec' as const,
      requireSandbox: true,
      bwrapProbePassed: true
    },
    {
      name: 'missing bwrap',
      platform: 'linux' as const,
      mechanism: undefined,
      requireSandbox: true,
      bwrapProbePassed: true
    },
    {
      name: 'failed bwrap probe',
      platform: 'linux' as const,
      mechanism: 'bwrap' as const,
      requireSandbox: true,
      bwrapProbePassed: false
    },
    {
      name: 'optional sandbox',
      platform: 'linux' as const,
      mechanism: 'bwrap' as const,
      requireSandbox: false,
      bwrapProbePassed: true
    }
  ])('rejects $name', ({ name: _name, ...input }) => {
    expect(supportsDelegatedMcpIsolation(input)).toBe(false)
  })

  it('accepts only enforced Linux bwrap after a successful probe', () => {
    expect(
      supportsDelegatedMcpIsolation({
        platform: 'linux',
        mechanism: 'bwrap',
        requireSandbox: true,
        bwrapProbePassed: true
      })
    ).toBe(true)
  })
})

describe('delegated bwrap mount isolation', () => {
  it('masks the common source root for an ordinary host without binding anything back', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const canonicalMaskedRoot = realpathSync(maskedRoot)

    const { cmd, args } = sandboxWrap('codex', ['--acp'], {
      mechanism: 'bwrap',
      writable: [],
      maskedReadRoots: [maskedRoot]
    })

    expect(cmd).toBe('bwrap')
    expect(args).toContain('--unshare-pid')
    expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])
    expect(args.slice(args.indexOf(canonicalMaskedRoot) - 1, args.indexOf(canonicalMaskedRoot) + 1)).toEqual([
      '--tmpfs',
      canonicalMaskedRoot
    ])
    expect(args).not.toContain('--bind')
  })

  it('adds exactly one cell-private bind after masking the common source root', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'cell-a')
    const targetDir = join(maskedRoot, 'private')
    const baseWritable = mkdtempSync(join(tmpdir(), 'ac-agent-workspace-'))
    mkdirSync(sourceDir)
    const canonicalMaskedRoot = realpathSync(maskedRoot)
    const canonicalSourceDir = realpathSync(sourceDir)
    const canonicalTargetDir = join(canonicalMaskedRoot, 'private')
    const canonicalBaseWritable = realpathSync(baseWritable)

    const { cmd, args } = delegatedCellSandboxWrap('codex', ['--acp'], [baseWritable], {
      maskedRoot,
      sourceDir,
      targetDir
    })

    expect(cmd).toBe('bwrap')
    expect(args).toContain('--unshare-pid')
    expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])

    const maskIndex = args.indexOf(canonicalMaskedRoot)
    const bindIndexes = args.flatMap((arg, index) => (arg === '--bind' ? [index] : []))
    expect(args[maskIndex - 1]).toBe('--tmpfs')
    expect(
      bindIndexes.map((index) => args.slice(index, index + 3)).filter(([, source]) => source === canonicalSourceDir)
    ).toEqual([['--bind', canonicalSourceDir, canonicalTargetDir]])
    expect(args.slice(bindIndexes[0], bindIndexes[0]! + 3)).toEqual([
      '--bind',
      canonicalBaseWritable,
      canonicalBaseWritable
    ])
    expect(bindIndexes.at(-1)).toBeGreaterThan(maskIndex)
  })

  it('rejects a mount source outside the masked root', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = mkdtempSync(join(tmpdir(), 'ac-outside-cell-'))

    expect(() =>
      delegatedCellSandboxWrap('codex', ['--acp'], [], {
        maskedRoot,
        sourceDir,
        targetDir: join(maskedRoot, 'private')
      })
    ).toThrow(SandboxError)
  })

  it('rejects a mount source whose symlink escapes the masked root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const maskedRoot = join(root, 'broker')
    const outside = join(root, 'outside')
    mkdirSync(maskedRoot)
    mkdirSync(outside)
    symlinkSync(outside, join(maskedRoot, 'cell-a'))

    expect(() =>
      delegatedCellSandboxWrap('codex', ['--acp'], [], {
        maskedRoot,
        sourceDir: join(maskedRoot, 'cell-a'),
        targetDir: join(maskedRoot, 'private')
      })
    ).toThrow(SandboxError)
  })
})
