import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  delegatedCellSandboxWrap,
  detectSandbox,
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
    const targetCreationIndex = args.indexOf(canonicalTargetDir)
    expect(args[maskIndex - 1]).toBe('--tmpfs')
    expect(args[targetCreationIndex - 1]).toBe('--dir')
    expect(targetCreationIndex).toBeGreaterThan(maskIndex)
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

    expect(() => {
      delegatedCellSandboxWrap('codex', ['--acp'], [], {
        maskedRoot,
        sourceDir,
        targetDir: join(maskedRoot, 'private')
      })
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it('rejects a mount source whose symlink escapes the masked root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const maskedRoot = join(root, 'broker')
    const outside = join(root, 'outside')
    mkdirSync(maskedRoot)
    mkdirSync(outside)
    symlinkSync(outside, join(maskedRoot, 'cell-a'))

    expect(() => {
      delegatedCellSandboxWrap('codex', ['--acp'], [], {
        maskedRoot,
        sourceDir: join(maskedRoot, 'cell-a'),
        targetDir: join(maskedRoot, 'private')
      })
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it.each(['masked root', 'source directory'] as const)(
    'rejects a missing %s without disclosing its path',
    (missing) => {
      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceDir = join(maskedRoot, 'cell-a')
      mkdirSync(sourceDir)
      const missingPath = join(maskedRoot, 'private-daemon-path-do-not-leak')

      expect(() => {
        delegatedCellSandboxWrap('codex', ['--acp'], [], {
          maskedRoot: missing === 'masked root' ? missingPath : maskedRoot,
          sourceDir: missing === 'source directory' ? missingPath : sourceDir,
          targetDir: join(maskedRoot, 'private')
        })
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    }
  )

  it.each(['masked root', 'source directory'] as const)(
    'rejects a non-directory %s without disclosing its path',
    (nonDirectory) => {
      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceDir = join(maskedRoot, 'cell-a')
      const filePath = join(maskedRoot, 'private-daemon-file-do-not-leak')
      mkdirSync(sourceDir)
      writeFileSync(filePath, 'not a directory')

      expect(() => {
        delegatedCellSandboxWrap('codex', ['--acp'], [], {
          maskedRoot: nonDirectory === 'masked root' ? filePath : maskedRoot,
          sourceDir: nonDirectory === 'source directory' ? filePath : sourceDir,
          targetDir: join(maskedRoot, 'private')
        })
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    }
  )

  it('rejects a symlink loop without disclosing its path', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const loopPath = join(maskedRoot, 'private-daemon-loop-do-not-leak')
    symlinkSync(loopPath, loopPath)

    expect(() => {
      delegatedCellSandboxWrap('codex', ['--acp'], [], {
        maskedRoot,
        sourceDir: loopPath,
        targetDir: join(maskedRoot, 'private')
      })
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it('rejects an inaccessible source directory without disclosing its path', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'private-daemon-source-do-not-leak')
    mkdirSync(sourceDir)
    chmodSync(maskedRoot, 0o000)

    try {
      expect(() => {
        delegatedCellSandboxWrap('codex', ['--acp'], [], {
          maskedRoot,
          sourceDir,
          targetDir: join(maskedRoot, 'private')
        })
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    } finally {
      chmodSync(maskedRoot, 0o700)
    }
  })
})

describe('bwrap delegated mount behavior', () => {
  it.skipIf(process.platform !== 'linux')(
    'masks every source from ordinary hosts and reveals only the entitled cell at its target',
    () => {
      expect(detectSandbox(), 'Linux unit CI must provide a working bwrap').toBe('bwrap')

      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceA = join(maskedRoot, 'cell-a')
      const sourceB = join(maskedRoot, 'cell-b')
      const targetA = join(maskedRoot, 'private')
      mkdirSync(sourceA)
      mkdirSync(sourceB)
      writeFileSync(join(sourceA, 'marker'), 'alpha')
      writeFileSync(join(sourceB, 'marker'), 'bravo')
      const canonicalMaskedRoot = realpathSync(maskedRoot)
      const canonicalTargetA = join(canonicalMaskedRoot, 'private')

      const ordinary = sandboxWrap(
        'sh',
        ['-c', 'test ! -e "$1/cell-a/marker" && test ! -e "$1/cell-b/marker"', 'sh', canonicalMaskedRoot],
        {
          mechanism: 'bwrap',
          writable: [],
          maskedReadRoots: [maskedRoot]
        }
      )
      execFileSync(ordinary.cmd, ordinary.args)

      const entitled = delegatedCellSandboxWrap(
        'sh',
        [
          '-c',
          'test "$(cat "$1/marker")" = alpha && test ! -e "$2/cell-a/marker" && test ! -e "$2/cell-b/marker"',
          'sh',
          canonicalTargetA,
          canonicalMaskedRoot
        ],
        [],
        {
          maskedRoot,
          sourceDir: sourceA,
          targetDir: targetA
        }
      )
      execFileSync(entitled.cmd, entitled.args)
    }
  )
})
