import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { ALLOWED_GIT_SUBCOMMANDS, ExecRefusedError, createExecHandler } from '../src/shim/exec-handler.js'
import { configFilesDir } from '../src/shim/config-file-env.js'
import type { GitExecResult } from '../src/shim/git-exec.js'

/**
 * The sandbox side of the exec channel, which is where the declared git inventory is actually
 * ENFORCED.
 *
 * The daemon declaring a closed list is not a control: this process spawns git, so a
 * compromised or buggy daemon reaching arbitrary git — and through `-c`, hooks or
 * `--upload-pack`, arbitrary execution — is refused here or not at all. Every case below runs
 * the real handler against a real repository.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-execguard-'))
  roots.push(root)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
  writeFileSync(join(root, 'file.txt'), 'x\n')
  execFileSync('git', ['add', 'file.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'seed'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e'
    }
  })
  return root
}

function handler(root: string) {
  return createExecHandler({ workspaceRoot: root, log: { info: () => {}, warn: () => {} } })
}

describe('sandbox exec handler', () => {
  it('runs a permitted subcommand and reports its output', async () => {
    const root = repository()
    const result = (await handler(root)('exec', {
      tool: 'git',
      args: ['rev-parse', '--verify', 'HEAD']
    })) as GitExecResult
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports a git failure as an exit code rather than throwing', async () => {
    const root = repository()
    const result = (await handler(root)('exec', {
      tool: 'git',
      args: ['rev-parse', '--verify', 'refs/heads/missing']
    })) as GitExecResult
    // A git-level failure is data the daemon interprets; only a refusal is exceptional.
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toBe('')
  })

  it('refuses a subcommand outside the declared inventory', async () => {
    const root = repository()
    for (const subcommand of ['push', 'submodule', 'daemon', 'gc', 'apply', 'checkout', 'for-each-ref']) {
      await expect(handler(root)('exec', { tool: 'git', args: [subcommand] })).rejects.toBeInstanceOf(ExecRefusedError)
    }
    // And the inventory is the daemon's declared list, not a superset invented here.
    expect(ALLOWED_GIT_SUBCOMMANDS.has('push')).toBe(false)
    expect(ALLOWED_GIT_SUBCOMMANDS.has('status')).toBe(true)
  })

  it('refuses arguments that turn a permitted subcommand into arbitrary execution', async () => {
    const root = repository()
    // Each of these reaches execution THROUGH git, so a permitted subcommand is not sufficient.
    const attacks = [
      ['-c', 'core.pager=sh -c "id"', 'status'],
      ['status', '-c', 'protocol.ext.allow=always'],
      ['--exec-path=/tmp/evil', 'status'],
      ['fetch', '--upload-pack=sh -c "id"', 'origin'],
      ['--config-env=core.pager=EVIL', 'status']
    ]
    for (const args of attacks) {
      await expect(handler(root)('exec', { tool: 'git', args })).rejects.toBeInstanceOf(ExecRefusedError)
    }
  })

  it('serves the worktree inventory the pod-side session paths need', async () => {
    // Each of these is called by the worktree and secondary-root paths, which run in the pod once
    // the workspace-fs seam lets them. A subcommand the daemon calls and this side refuses is a
    // session that fails on a pool member and works self-hosted.
    const root = repository()
    for (const args of [
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
      ['branch', '--list']
    ]) {
      const result = (await handler(root)('exec', { tool: 'git', args })) as GitExecResult
      expect(result.code).toBe(0)
    }
    for (const subcommand of ['branch', 'ls-remote', 'show-ref', 'symbolic-ref']) {
      expect(ALLOWED_GIT_SUBCOMMANDS.has(subcommand)).toBe(true)
    }
  })

  it('serves the branch-and-materialize sequence the confined session tier runs instead of a checkout', async () => {
    // The clone tier (git-workspace-model.md §11) puts a session clone on its own generated branch.
    // `checkout` is deliberately outside the inventory, so the daemon expresses that as three
    // subcommands that are inside it — and here is where that has to hold: a refusal on this side is
    // a session that fails on a pool member and works self-hosted, which is how it reached the field.
    const root = repository()
    for (const args of [
      ['branch', '--no-track', 'dev/ada-lovelace/quiet-harbor', 'refs/heads/main'],
      ['symbolic-ref', 'HEAD', 'refs/heads/dev/ada-lovelace/quiet-harbor'],
      ['reset', '--hard']
    ]) {
      const result = (await handler(root)('exec', { tool: 'git', args })) as GitExecResult
      expect(result.code).toBe(0)
    }
    const head = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
    expect(head.trim()).toBe('dev/ada-lovelace/quiet-harbor')
    // The tree is materialized, not merely pointed at, which is the half `checkout` was doing.
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('x\n')
    expect(ALLOWED_GIT_SUBCOMMANDS.has('checkout')).toBe(false)
    // And the snapshot probe retirement runs in that clone, which `for-each-ref` used to answer.
    const probe = (await handler(root)('exec', {
      tool: 'git',
      args: ['show-ref', '--verify', 'refs/agentconnect/reviews/session-1/head']
    })) as GitExecResult
    expect(probe.code).not.toBe(0)
  })

  it('still refuses every execution option on the newly permitted subcommands', async () => {
    // Widening the inventory must not widen what an argument may do: `-c` is refused as a PREFIX,
    // in each of its accepted spellings, whatever subcommand carries it.
    const root = repository()
    const attacks = [
      ['-c', 'core.pager=sh -c "id"', 'branch'],
      ['branch', '-ccore.pager=EVIL'],
      ['show-ref', '--config-env=core.pager=EVIL'],
      ['symbolic-ref', '--config=core.pager=EVIL'],
      ['ls-remote', '--upload-pack=sh -c "id"', 'origin'],
      ['branch', '--exec-path=/tmp/evil']
    ]
    for (const args of attacks) {
      await expect(handler(root)('exec', { tool: 'git', args })).rejects.toBeInstanceOf(ExecRefusedError)
    }
  })

  it('refuses a worktree path outside the workspace root, which the cwd fence never sees', async () => {
    // `worktree add`/`remove` name a directory in argv and create or delete it, exactly as a clone
    // target does — so the same containment applies, on the side holding the filesystem.
    const root = repository()
    const outside = mkdtempSync(join(tmpdir(), 'ac-worktree-outside-'))
    roots.push(outside)
    await expect(
      handler(root)('exec', {
        tool: 'git',
        args: ['worktree', 'add', '-b', 'dev/alice/quiet-harbor', join(outside, 'stolen'), 'HEAD'],
        cwd: root
      })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    await expect(
      handler(root)('exec', { tool: 'git', args: ['worktree', 'remove', join(root, '..', 'escaped')], cwd: root })
    ).rejects.toBeInstanceOf(ExecRefusedError)
  })

  it('refuses a RELATIVE operand that escapes, which git resolves against the cwd', async () => {
    // The trap an absolute-only check leaves open: git resolves `../escaped` against the cwd, so the
    // fence passes it untouched and the write lands outside the root anyway.
    const root = repository()
    for (const args of [
      ['worktree', 'add', '../escaped', 'HEAD'],
      ['worktree', 'remove', '../escaped'],
      ['clone', 'https://github.com/acme/repo.git', '../escaped']
    ]) {
      await expect(handler(root)('exec', { tool: 'git', args, cwd: root })).rejects.toBeInstanceOf(ExecRefusedError)
    }
    // A relative operand that stays inside is what the daemon actually sends, and it still runs.
    const inside = (await handler(root)('exec', {
      tool: 'git',
      args: ['worktree', 'add', '--detach', 'worktrees/one', 'HEAD'],
      cwd: root
    })) as GitExecResult
    expect(inside.code).toBe(0)
  })

  it('refuses a cwd outside the workspace root, whatever the daemon asked for', async () => {
    const root = repository()
    const outside = mkdtempSync(join(tmpdir(), 'ac-outside-'))
    roots.push(outside)
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain'], cwd: outside })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain'], cwd: join(root, '..') })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain'], cwd: 'relative' })
    ).rejects.toBeInstanceOf(ExecRefusedError)

    // A subdirectory of the root is fine — the check is containment, not equality.
    mkdirSync(join(root, 'sub'), { recursive: true })
    const inside = (await handler(root)('exec', {
      tool: 'git',
      args: ['status', '--porcelain'],
      cwd: join(root, 'sub')
    })) as GitExecResult
    expect(inside.code).toBe(0)
  })

  it('refuses a clone TARGET outside the workspace root, which the cwd fence never sees', async () => {
    // A clone writes to a path in argv. The daemon sends a relative target precisely so the fenced
    // cwd contains it, but this side holds the filesystem, so it re-checks rather than trusting that.
    const root = repository()
    const outside = mkdtempSync(join(tmpdir(), 'ac-clone-outside-'))
    roots.push(outside)
    await expect(
      handler(root)('exec', {
        tool: 'git',
        args: ['clone', 'https://github.com/acme/repo.git', join(outside, 'stolen')],
        cwd: root
      })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    await expect(
      handler(root)('exec', {
        tool: 'git',
        args: ['clone', 'https://github.com/acme/repo.git', join(root, '..', 'escaped')],
        cwd: root
      })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    // An absolute target INSIDE the root is allowed: the check is containment, not a ban on
    // absolute paths — and it must not refuse the URL argument either.
    await expect(
      handler(root)('exec', {
        tool: 'git',
        args: ['clone', 'https://github.com/acme/repo.git', join(root, 'nested')],
        cwd: root
      })
    ).resolves.toMatchObject({ code: expect.any(Number) })
  })

  it('applies the request env as given rather than merging the sandbox environment', async () => {
    // Verified through `config`, which IS in the inventory. An earlier version of this test used
    // `commit` — and the guard refused it, correctly: the daemon never commits, so `commit` is
    // not on the list. The test reaching for a convenient command it does not use was the bug.
    const root = repository()
    const globalConfig = join(root, 'from-request.gitconfig')
    writeFileSync(globalConfig, '[user]\n\tname = Only From Request\n')
    const result = (await handler(root)('exec', {
      tool: 'git',
      args: ['config', '--get', 'user.name'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        GIT_CONFIG_GLOBAL: globalConfig
      }
    })) as GitExecResult
    // git only reads that file if the request env reached the child.
    expect(result.stdout.trim()).toBe('Only From Request')

    // And without it, the same argv does not see that name — so the previous result was the
    // env doing the work rather than ambient configuration.
    const withoutEnv = (await handler(root)('exec', {
      tool: 'git',
      args: ['config', '--get', 'user.name']
    })) as GitExecResult
    expect(withoutEnv.stdout.trim()).not.toBe('Only From Request')
  })

  it('refuses every accepted SPELLING of an execution option, not just the separated one', async () => {
    // The first version of this guard matched exact tokens and probed `-c` in the GLOBAL
    // position, where git rejects the attached form. That was the wrong position: `git clone -c`
    // is clone's own option and accepts `-ck=v` and `--config=k=v`, which is how
    // `-cprotocol.ext.allow=always ext::<helper>` reaches a helper the caller names. All of the
    // spellings below were measured executing against git 2.43 before being refused here.
    const root = repository()
    const evil = join(root, 'evil.sh')
    writeFileSync(evil, '#!/bin/sh\necho EVIL-RAN >&2\nexit 1\n', { mode: 0o755 })
    const spellings = [
      ['clone', '-u', evil, 'file:///nonexistent', join(root, 'd1')], // separated
      ['clone', `-u${evil}`, 'file:///nonexistent', join(root, 'd2')], // attached
      ['clone', `--upload-pack=${evil}`, 'file:///nonexistent', join(root, 'd3')], // long, =
      ['clone', '--upload-pack', evil, 'file:///nonexistent', join(root, 'd4')], // long, separated
      ['clone', '-cprotocol.ext.allow=always', `ext::${evil}`, join(root, 'd5')], // clone's own -c
      ['clone', '--config=protocol.ext.allow=always', `ext::${evil}`, join(root, 'd6')],
      ['clone', '-c', 'protocol.ext.allow=always', `ext::${evil}`, join(root, 'd7')],
      ['config', '-e'],
      ['config', '--edit'],
      ['status', '-ccore.pager=EVIL'],
      ['status', '--config-env=core.pager=EVIL']
    ]
    for (const args of spellings) {
      await expect(handler(root)('exec', { tool: 'git', args })).rejects.toBeInstanceOf(ExecRefusedError)
    }
    // Nothing ran: the helper writes to stderr, and a refusal happens before any spawn.
    expect(readFileSync(evil, 'utf8')).toContain('EVIL-RAN')

    // And NOT a blanket ban. `-u` means --untracked-files to status, which the daemon sends on
    // every status call, and `--count` must survive `/^-c/` — its second character is `-`.
    const status = (await handler(root)('exec', {
      tool: 'git',
      args: ['status', '--porcelain=v2', '--branch', '-u', '-z']
    })) as GitExecResult
    expect(status.code).toBe(0)
    const count = (await handler(root)('exec', { tool: 'git', args: ['rev-list', '--count', 'HEAD'] })) as GitExecResult
    expect(count.code).toBe(0)
    expect(count.stdout.trim()).toBe('1')
  })

  it('refuses a cwd that escapes through a SYMLINK beneath the root', async () => {
    // Containment was lexical, so `<root>/link` passed the prefix check while pointing anywhere.
    const root = repository()
    const outside = mkdtempSync(join(tmpdir(), 'ac-symlink-target-'))
    roots.push(outside)
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: outside })
    const link = join(root, 'link')
    symlinkSync(outside, link)
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain'], cwd: link })
    ).rejects.toBeInstanceOf(ExecRefusedError)

    // A symlink that stays inside is still fine — the rule is where it LANDS, not that it is one.
    mkdirSync(join(root, 'real'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'inner-link'))
    const inside = (await handler(root)('exec', {
      tool: 'git',
      args: ['status', '--porcelain'],
      cwd: join(root, 'inner-link')
    })) as GitExecResult
    expect(inside.code).toBe(0)
  })

  it('refuses a result too large to frame instead of assembling one the transport will drop', async () => {
    // The result crosses as ONE shim frame capped at MAX_FRAME_BYTES. A 32 MiB buffer did not
    // permit large results, it produced a result the transport discards — killing the channel
    // rather than failing the call.
    const root = repository()
    const many = join(root, 'many')
    mkdirSync(many, { recursive: true })
    for (let i = 0; i < 4000; i += 1) writeFileSync(join(many, `file-with-a-longish-name-${i}.txt`), 'x')
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain=v2', '--branch', '-u', '-z'] })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    // The guard has to sit below the frame cap, not at it: the JSON envelope carries both
    // streams plus escaping.
    expect(MAX_FRAME_BYTES).toBeGreaterThan(64 * 1024)
  })

  it('refuses a result under the raw cap but over the WIRE cap once encoded', async () => {
    // JSON encoding is not size-preserving: `git status -z` emits filenames verbatim, control
    // bytes included, and each becomes a six-byte \uXXXX escape. A raw-only check passed this
    // and the transport then dropped the frame — measured at 51,682 raw / 302,976 encoded, so
    // the earlier 64 KiB raw guard did not see it at all.
    const root = repository()
    const control = String.fromCharCode(1).repeat(200)
    for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${i}${control}`), 'x')
    await expect(
      handler(root)('exec', { tool: 'git', args: ['status', '--porcelain=v2', '--branch', '-u', '-z'] })
    ).rejects.toThrow(/once encoded/)
    // The guard has to sit below the frame cap, since the envelope shares the frame.
    expect(MAX_FRAME_BYTES).toBe(256 * 1024)
  })

  it('reports a TIMED-OUT git as a failure, never as exit 0', async () => {
    // Node gives a signalled child `code: null`, which an earlier version mapped to 0 — so a
    // timed-out `status` returned success with partial output, which every caller reads as a
    // clean tree. The hang is real: git blocks reading a config file that is a FIFO.
    const root = repository()
    const blocking = join(root, 'blocking.gitconfig')
    execFileSync('mkfifo', [blocking])
    const result = (await handler(root)('exec', {
      tool: 'git',
      args: ['config', '--get', 'user.name'],
      env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_GLOBAL: blocking },
      timeoutMs: 1_000
    })) as GitExecResult
    expect(result.code).not.toBe(0)
    // 128 + SIGTERM, the shell convention, and a reason the daemon can surface.
    expect(result.code).toBe(143)
    expect(result.stderr).toMatch(/terminated by SIGTERM after 1000ms/)
  })

  it('bounds a caller-supplied deadline rather than trusting it', async () => {
    // The deadline arrives from the daemon, so the sandbox keeps a ceiling: otherwise a
    // compromised caller pins a child here for as long as it likes.
    const root = repository()
    const bounded = createExecHandler({ workspaceRoot: root, timeoutMs: 1_000 })
    const blocking = join(root, 'ceiling.gitconfig')
    execFileSync('mkfifo', [blocking])
    const result = (await bounded('exec', {
      tool: 'git',
      args: ['config', '--get', 'user.name'],
      env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_GLOBAL: blocking },
      timeoutMs: 900_000
    })) as GitExecResult
    expect(result.code).toBe(143)
    expect(result.stderr).toMatch(/after 1000ms/)
  })

  it('serves materialization and refuses a path escaping the sink root', async () => {
    const root = repository()
    await handler(root)('materialize', {
      op: 'write',
      root: configFilesDir(root),
      relPath: ['kubeconfig'],
      content: 'apiVersion: v1\n'
    })
    expect(readFileSync(join(configFilesDir(root), 'kubeconfig'), 'utf8')).toBe('apiVersion: v1\n')
    await expect(
      handler(root)('materialize', { op: 'write', root: configFilesDir(root), relPath: ['..', 'escape'], content: 'x' })
    ).rejects.toThrow()
  })

  it('refuses a capability it does not serve', async () => {
    const root = repository()
    // acp is served by the runner and tunnel is not implemented here; neither may fall through
    // to the git path by accident.
    await expect(handler(root)('acp', { op: 'open' })).rejects.toBeInstanceOf(ExecRefusedError)
    await expect(handler(root)('tunnel', { op: 'open' })).rejects.toBeInstanceOf(ExecRefusedError)
  })
})
