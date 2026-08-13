import { afterAll, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceListPage, WorkspaceReadContent, WorkspaceWriteOk } from '@agentconnect.md/protocol'
import { createExecHandler } from '../src/shim/exec-handler.js'
import {
  ShimWorkspaceFiles,
  WorkspaceFilesReplySchema,
  applyWorkspaceFilesPayload
} from '../src/shim/workspace-files-channel.js'
import type { ShimRequester } from '../src/shim/channels.js'
import {
  assertSameDirectory,
  createWorkspaceFiles,
  directoryIdentity,
  localWorkspaceFiles,
  WorkspaceConflictError,
  WorkspaceViolationError
} from '../src/workspace/workspace-files.js'

/**
 * The `read` capability: the console's workspace file operations, served where the files are.
 *
 * The half that matters here is the SANDBOX's. The daemon fences its paths too, but this process
 * holds the filesystem, so the root fence, the containment and the typed refusals are enforced here
 * or nowhere — and the refusals have to survive the channel as refusals rather than collapsing into
 * "the daemon may be offline".
 */

const roots: string[] = []
const AGENT = 'bot-files'

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A pod-shaped layout: the mounted volume, with the checkout one level down. */
function volume(): { mount: string; checkout: string } {
  const mount = mkdtempSync(join(tmpdir(), 'ac-shimfiles-'))
  roots.push(mount)
  const checkout = join(mount, 'repo')
  mkdirSync(join(checkout, 'src'), { recursive: true })
  writeFileSync(join(checkout, 'README.md'), '# hello\nsecond line\n')
  writeFileSync(join(checkout, 'src', 'index.ts'), 'export const x = 1\n')
  return { mount, checkout }
}

const handlerFor = (mount: string) => createExecHandler({ workspaceRoot: mount })

describe('the shim read capability', () => {
  it('lists and reads the pod volume, dirs first', async () => {
    const { mount, checkout } = volume()
    const reply = await handlerFor(mount)('read', {
      op: 'list',
      root: checkout,
      req: { agentId: AGENT, path: '', limit: 50 }
    })
    const page = WorkspaceFilesReplySchema.parse(reply)
    expect(page.ok).toBe(true)
    const value = (page as { ok: true; value: WorkspaceListPage }).value
    expect(value.exists).toBe(true)
    expect(value.entries.map((entry) => entry.name)).toEqual(['src', 'README.md'])

    const readReply = await handlerFor(mount)('read', {
      op: 'read',
      root: checkout,
      req: { agentId: AGENT, path: 'README.md', offset: 0, limit: 65_536 }
    })
    const content = (WorkspaceFilesReplySchema.parse(readReply) as { ok: true; value: WorkspaceReadContent }).value
    expect(content).toMatchObject({ exists: true, type: 'file', encoding: 'utf8', content: '# hello\nsecond line\n' })
  })

  it('refuses a root outside the sandbox workspace, whatever the daemon asked for', async () => {
    const { mount } = volume()
    // The daemon's own root resolution is not a control on this side: this is the check that stops a
    // buggy — or compromised — daemon reading /etc through a channel it legitimately holds.
    await expect(
      handlerFor(mount)('read', { op: 'list', root: '/etc', req: { agentId: AGENT, path: '', limit: 10 } })
    ).rejects.toThrow(/escapes the workspace root/)
  })

  it('keeps a containment refusal a REFUSAL across the channel, with its reason', async () => {
    const { mount, checkout } = volume()
    // A path escape is data the console can act on ("that path is not readable"), not an outage.
    // Collapsing it into an error frame would make it indistinguishable from an offline daemon.
    const reply = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', {
        op: 'read',
        root: checkout,
        req: { agentId: AGENT, path: '../secret.env', offset: 0, limit: 10 }
      })
    )
    expect(reply).toEqual({
      ok: false,
      refusal: { kind: 'violation', reason: 'path-escape', message: expect.any(String) }
    })
  })

  it('refuses a read through a symlinked directory that leaves the checkout', async () => {
    const { mount, checkout } = volume()
    // Lexical containment passes for `vendor/x` while the real path resolves out of the checkout —
    // onto the mount, which holds the materialized provider config. The canonical re-check is what
    // catches it, and it has to run HERE because only this side can resolve the link.
    writeFileSync(join(mount, 'PROVIDER_SECRET.env'), 'token=abc\n')
    symlinkSync(mount, join(checkout, 'vendor'), 'dir')
    const escape = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', {
        op: 'read',
        root: checkout,
        req: { agentId: AGENT, path: 'vendor/PROVIDER_SECRET.env', offset: 0, limit: 10 }
      })
    )
    expect(escape).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'path-escape' } })
  })

  it('answers exactly what the local implementation answers, refusals included', async () => {
    const { mount, checkout } = volume()
    // The property that matters for this channel is not a new contract but the ABSENCE of one: a
    // pod workspace must not acquire its own answers. Both sides run `localWorkspaceFiles`, and this
    // is what fails if a future change re-implements the pod side instead of routing to it — the
    // symlink case included, where the two could plausibly disagree.
    symlinkSync(mount, join(checkout, 'vendor'), 'dir')
    const cases = [
      { agentId: AGENT, path: 'README.md', offset: 0, limit: 65_536 },
      { agentId: AGENT, path: 'nope.md', offset: 0, limit: 65_536 },
      { agentId: AGENT, path: 'src', offset: 0, limit: 65_536 },
      { agentId: AGENT, path: 'vendor/PROVIDER_SECRET.env', offset: 0, limit: 65_536 }
    ]
    for (const req of cases) {
      const remote = WorkspaceFilesReplySchema.parse(
        await handlerFor(mount)('read', { op: 'read', root: checkout, req })
      )
      const local = await localWorkspaceFiles.read(checkout, req).then(
        (value) => ({ ok: true, value }),
        (err: unknown) =>
          err instanceof WorkspaceViolationError
            ? { ok: false, refusal: { kind: 'violation', reason: err.reason, message: err.message } }
            : { thrown: (err as Error).name }
      )
      expect(remote).toEqual(local)
    }
  })

  it('enforces the scratch gate again where the write lands', async () => {
    const { mount, checkout } = volume()
    // The daemon decides this (it reads agent configuration) and sends the answer, so the value is
    // trusted — but a request that arrived with `scratch:false` must still be refused here rather
    // than written because the daemon "would have" checked.
    const reply = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', {
        op: 'write',
        root: checkout,
        scratch: false,
        req: { agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('hi\n').toString('base64') }
      })
    )
    expect(reply).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'read-only-workspace' } })
    expect(() => readFileSync(join(checkout, 'notes.md'))).toThrow()
  })

  it('publishes a scratch file and reports a stale replacement as a conflict', async () => {
    const { mount, checkout } = volume()
    const handle = handlerFor(mount)
    const created = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: { agentId: AGENT, path: 'notes.md', contentBase64: Buffer.from('first\n').toString('base64') }
      })
    )
    expect(created.ok).toBe(true)
    const written = (created as { ok: true; value: WorkspaceWriteOk }).value
    expect(readFileSync(join(checkout, 'notes.md'), 'utf8')).toBe('first\n')

    // The optimistic-concurrency check, which is a CONFLICT and not a violation: the console
    // reloads on it rather than telling the reader their path was rejected.
    const stale = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: {
          agentId: AGENT,
          path: 'notes.md',
          contentBase64: Buffer.from('second\n').toString('base64'),
          ifMatchMtime: new Date(0).toISOString()
        }
      })
    )
    expect(stale).toMatchObject({ ok: false, refusal: { kind: 'conflict' } })
    expect(readFileSync(join(checkout, 'notes.md'), 'utf8')).toBe('first\n')

    // ...and the matching mtime replaces it.
    const replaced = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: {
          agentId: AGENT,
          path: 'notes.md',
          contentBase64: Buffer.from('second\n').toString('base64'),
          ifMatchMtime: written.mtime
        }
      })
    )
    expect(replaced.ok).toBe(true)
    expect(readFileSync(join(checkout, 'notes.md'), 'utf8')).toBe('second\n')
  })

  it('refuses a root that reaches out through a symlink, not just one that looks contained', async () => {
    const { mount, checkout } = volume()
    // The lexical fence was borrowed from the clone-target check, where the path deliberately does not
    // exist yet. A read's root DOES, and the shared implementation `realpath`s it to derive its own
    // containment boundary — so anything in this pod that replaces the checkout with a symlink moves
    // every downstream check onto the link's target. Such a root still reads as contained lexically.
    const escaped = mkdtempSync(join(tmpdir(), 'ac-shimfiles-outside-'))
    roots.push(escaped)
    writeFileSync(join(escaped, 'HOST_SECRET.env'), 'token=abc\n')
    rmSync(checkout, { recursive: true, force: true })
    symlinkSync(escaped, checkout, 'dir')

    await expect(
      handlerFor(mount)('read', { op: 'list', root: checkout, req: { agentId: AGENT, path: '', limit: 50 } })
    ).rejects.toThrow(/escapes the workspace root/)
  })

  it('answers a not-yet-materialized root without letting the operations resolve the name', async () => {
    const { mount, checkout } = volume()
    // `realpath` fails while the workspace is still being cloned, and absence is the answer a reader
    // wants — but the name must not travel onward for the operations to resolve on their first
    // `await`. That window is long enough for the runtime, which owns this volume, to create
    // `<mount>/repo` as a symlink to `<mount>` and have them adopt the config directory as their own
    // containment root. So the reply is produced HERE, and the operations are never called.
    rmSync(checkout, { recursive: true, force: true })
    let asked = 0
    const spy = {
      ...localWorkspaceFiles,
      list: async (root: string, req: Parameters<typeof localWorkspaceFiles.list>[1]) => {
        asked += 1
        return localWorkspaceFiles.list(root, req)
      }
    }
    const reply = await applyWorkspaceFilesPayload(
      { op: 'list', root: checkout, req: { agentId: AGENT, path: '', limit: 50 } },
      (requested) => (requested === checkout ? undefined : requested),
      spy
    )
    expect(reply).toMatchObject({ ok: true, value: { exists: false, entries: [] } })
    expect(asked).toBe(0)
    // And through the real handler, whose fence answers `undefined` for the same reason.
    expect(
      WorkspaceFilesReplySchema.parse(
        await handlerFor(mount)('read', { op: 'list', root: checkout, req: { agentId: AGENT, path: '', limit: 50 } })
      )
    ).toMatchObject({ ok: true, value: { exists: false, entries: [] } })
  })

  it('refuses when the root stops resolving to itself between the fence and the work', async () => {
    const { mount, checkout } = volume()
    // The fence approved a canonical `<mount>/repo`; by the time the operation resolves that same name
    // the runtime has replaced the directory with a symlink pointing at the mount, whose materialized
    // config would then be the containment root. A canonical path resolves to itself, so the mismatch
    // is the detection — this is the check that binds the work to the directory that was validated.
    const pinned = createWorkspaceFiles({ pinnedRoot: true })
    rmSync(checkout, { recursive: true, force: true })
    symlinkSync(mount, checkout, 'dir')
    await expect(pinned.list(checkout, { agentId: AGENT, path: '', limit: 50 })).rejects.toMatchObject({
      name: 'WorkspaceViolationError',
      reason: 'path-escape'
    })
    // The daemon's own instance keeps resolving its root, whose path may legitimately be a symlink.
    await expect(localWorkspaceFiles.list(checkout, { agentId: AGENT, path: '', limit: 50 })).resolves.toMatchObject({
      exists: true
    })
  })

  it('refuses when the directory the root named is replaced by another real one', async () => {
    const { mount, checkout } = volume()
    // The window the pinned check above cannot see: `canonicalUnder` returns, and THEN the runtime
    // renames the checkout aside and puts something else at the same path. Every later `readdir` and
    // `open` follows the replacement, and no amount of re-resolving the same name notices — the path
    // still resolves, still canonically, still inside the mount. The inode does not, which is why the
    // identity is captured at validation and re-checked before any answer leaves.
    // Renamed into place rather than deleted and recreated: freeing an inode and immediately asking
    // for another can hand back the same number, which would make this test pass for the wrong reason.
    const replacement = join(mount, 'other')
    mkdirSync(replacement, { recursive: true })
    const identity = await directoryIdentity(checkout)
    rmSync(checkout, { recursive: true, force: true })
    renameSync(replacement, checkout) // same path, definitely a different inode
    await expect(assertSameDirectory(checkout, identity)).rejects.toMatchObject({
      name: 'WorkspaceViolationError',
      reason: 'path-escape'
    })
    // ...and the same check passes for the directory it was taken from.
    await expect(assertSameDirectory(checkout, await directoryIdentity(checkout))).resolves.toBeUndefined()
  })

  it('refuses a pinned root that disappears between the fence and the work', async () => {
    const { mount, checkout } = volume()
    // Proven to exist a moment ago, so its absence now is the same event as its replacement — not the
    // "nothing to escape through" case, which only applies to a root nobody has resolved yet.
    const pinned = createWorkspaceFiles({ pinnedRoot: true })
    rmSync(checkout, { recursive: true, force: true })
    await expect(pinned.list(checkout, { agentId: AGENT, path: '', limit: 50 })).rejects.toMatchObject({
      reason: 'path-escape'
    })
    expect(mount).toBeTruthy()
  })

  it('hands the operations the RESOLVED root, so the fence and the boundary are one resolution', async () => {
    const { mount, checkout } = volume()
    // Validating a canonical path and then passing the original string onward leaves two separate
    // resolutions of the same root, and the runtime owns this volume — it can change the answer
    // between them, and the second one becomes the operations' inner containment boundary. A benign
    // in-mount symlink is enough to observe WHICH value arrives: the checkout reached through a link.
    const real = join(mount, 'real-repo')
    mkdirSync(real, { recursive: true })
    rmSync(checkout, { recursive: true, force: true })
    symlinkSync(real, checkout, 'dir')

    const seen: string[] = []
    const spy = {
      ...localWorkspaceFiles,
      list: async (root: string, req: Parameters<typeof localWorkspaceFiles.list>[1]) => {
        seen.push(root)
        return localWorkspaceFiles.list(root, req)
      }
    }
    await applyWorkspaceFilesPayload(
      { op: 'list', root: checkout, req: { agentId: AGENT, path: '', limit: 10 } },
      (root) => {
        // The exec handler's fence, in the shape the handler uses it: it RETURNS the root to use.
        expect(root).toBe(checkout)
        return realpathSync(root)
      },
      spy
    )
    expect(seen).toEqual([realpathSync(real)])
    expect(seen).not.toContain(checkout)
  })

  it('refuses a payload that is not one of the four operations', async () => {
    const { mount, checkout } = volume()
    await expect(handlerFor(mount)('read', { op: 'chmod', root: checkout })).rejects.toThrow()
  })
})

describe('ShimWorkspaceFiles', () => {
  /** Loops the daemon-side client straight into the shim-side handler, so both halves of the
   *  channel are exercised without a pod. */
  function loopback(mount: string): ShimWorkspaceFiles {
    const requester: ShimRequester = {
      request: async (capability, payload) => {
        expect(capability).toBe('read')
        return applyWorkspaceFilesPayload(payload, (root) => {
          if (!root.startsWith(mount)) throw new Error('escapes the workspace root')
          return root
        })
      }
    }
    return new ShimWorkspaceFiles(requester)
  }

  it('re-throws a violation as the SAME class the local path throws, reason intact', async () => {
    const { mount, checkout } = volume()
    // The dispatcher above maps these classes onto wire frames, so a remote workspace answering with
    // a bare Error would surface a contained path escape as an internal daemon failure.
    await expect(
      loopback(mount).read(checkout, { agentId: AGENT, path: '../escape', offset: 0, limit: 10 })
    ).rejects.toMatchObject({ name: 'WorkspaceViolationError', reason: 'path-escape' })
    await expect(
      loopback(mount).read(checkout, { agentId: AGENT, path: '../escape', offset: 0, limit: 10 })
    ).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('re-throws a conflict as a conflict, so the console reloads instead of reporting an outage', async () => {
    const { mount, checkout } = volume()
    await expect(
      loopback(mount).delete(checkout, true, {
        agentId: AGENT,
        path: 'README.md',
        ifMatchMtime: new Date(0).toISOString()
      })
    ).rejects.toBeInstanceOf(WorkspaceConflictError)
  })

  it('answers a listing identically to the local implementation', async () => {
    const { mount, checkout } = volume()
    const remote = await loopback(mount).list(checkout, { agentId: AGENT, path: 'src', limit: 50 })
    expect(remote).toMatchObject({ agentId: AGENT, path: 'src', exists: true })
    expect(remote.entries.map((entry) => entry.name)).toEqual(['index.ts'])
  })
})
