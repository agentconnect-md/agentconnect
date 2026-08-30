import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fsp, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import type { WorkspaceListPage, WorkspaceReadContent, WorkspaceWriteOk } from '@agentconnect.md/protocol'
import { createExecHandler } from '../src/shim/exec-handler.js'
import {
  ShimWorkspaceFiles,
  WorkspaceFilesReplySchema,
  applyWorkspaceFilesPayload
} from '../src/shim/workspace-files-channel.js'
import type { ShimRequester } from '../src/shim/channels.js'
import {
  canonicalWorkspacePath,
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
    // buggy — or compromised — daemon reading /etc through a channel it legitimately holds. It is a
    // refusal with a reason rather than an error frame, because the walk expresses the root as steps
    // from the mount and "that is not under the mount" is the same containment answer as any other.
    const reply = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', { op: 'list', root: '/etc', req: { agentId: AGENT, path: '', limit: 10 } })
    )
    expect(reply).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'path-escape' } })
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

  it('agrees with the daemon implementation on every path that is plainly inside the workspace', async () => {
    const { mount, checkout } = volume()
    // The two are separate implementations now — one walks descriptors, one walks names — so what has
    // to be pinned is that they answer alike wherever both are defined. A console must not learn which
    // filesystem its agent is on from the shape of a reply.
    const cases = [
      { agentId: AGENT, path: 'README.md', offset: 0, limit: 65_536 },
      { agentId: AGENT, path: 'nope.md', offset: 0, limit: 65_536 },
      { agentId: AGENT, path: 'src', offset: 0, limit: 65_536 }
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

  it('diverges on ONE case, deliberately: a symlinked directory component inside the workspace', async () => {
    const { mount, checkout } = volume()
    // The daemon resolves such a component and then asks where it landed; the descent refuses to open
    // it at all, because "follow it and check afterwards" is the shape that cannot be made safe on a
    // volume the agent writes to. Pinned rather than smoothed over — it is the one behaviour a repo
    // could notice, and a symlinked subdirectory is a real thing to have in one.
    mkdirSync(join(checkout, 'shared'), { recursive: true })
    writeFileSync(join(checkout, 'shared', 'note.md'), 'inside the workspace\n')
    symlinkSync(join(checkout, 'shared'), join(checkout, 'docs'), 'dir')
    const req = { agentId: AGENT, path: 'docs/note.md', offset: 0, limit: 65_536 }

    // The daemon reads it: the link stays inside the workspace, so its containment check passes.
    await expect(localWorkspaceFiles.read(checkout, req)).resolves.toMatchObject({
      exists: true,
      content: 'inside the workspace\n'
    })
    // The pod refuses it, and says so as containment rather than as absence.
    expect(
      WorkspaceFilesReplySchema.parse(await handlerFor(mount)('read', { op: 'read', root: checkout, req }))
    ).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'path-escape' } })
  })

  it('does not answer whether a path OUTSIDE the workspace exists, which the daemon still does', async () => {
    const { mount, checkout } = volume()
    // A side effect of refusing the component rather than following it: `vendor/<x>` gets one answer
    // whether or not `<x>` is there. The daemon's own path distinguishes them — absent reads as
    // `exists:false` and present as `path-escape` — which is an existence oracle for the mount, and
    // the mount is where the materialized provider config lives.
    symlinkSync(mount, join(checkout, 'vendor'), 'dir')
    writeFileSync(join(mount, 'PRESENT.env'), 'token=abc\n')
    const ask = async (name: string) =>
      WorkspaceFilesReplySchema.parse(
        await handlerFor(mount)('read', {
          op: 'read',
          root: checkout,
          req: { agentId: AGENT, path: `vendor/${name}`, offset: 0, limit: 10 }
        })
      )
    expect(await ask('PRESENT.env')).toEqual(await ask('ABSENT.env'))
  })

  // Worktree cleanup and workspace conversion delete the tree under a reader, and Windows resolves an
  // already-unlinked directory to a path OUTSIDE the root instead of failing with ENOENT — the realpath
  // stub stands in for that. A deletion race is absence, so both directions are pinned: only a path
  // that is still there is an escape.
  it('reads a dropped directory as absent, and still refuses one that resolves outside the checkout', async () => {
    const root = await fsp.realpath(volume().mount)
    const checkout = join(root, 'repo')
    const src = join(checkout, 'src')
    let dropOnResolve = false
    const realpath = fsp.realpath
    const spy = vi.spyOn(fsp, 'realpath').mockImplementation((async (target: string) => {
      if (target !== src) return realpath(target)
      if (dropOnResolve) rmSync(src, { recursive: true, force: true })
      return parse(src).root
    }) as unknown as typeof fsp.realpath)
    const listSrc = () => localWorkspaceFiles.list(checkout, { agentId: AGENT, path: 'src', limit: 50 })
    try {
      await expect(listSrc()).rejects.toMatchObject({ name: 'WorkspaceViolationError', reason: 'path-escape' })
      await expect(canonicalWorkspacePath(checkout, 'src')).rejects.toMatchObject({ reason: 'path-escape' })
      dropOnResolve = true
      await expect(listSrc()).resolves.toMatchObject({ exists: false, entries: [] })
      expect(await canonicalWorkspacePath(checkout, 'src')).toBeNull()
    } finally {
      spy.mockRestore()
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

  it('returns absence through missing ancestors and creates nested parents for an exclusive write', async () => {
    const { mount, checkout } = volume()
    const handle = handlerFor(mount)
    const missing = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'read',
        root: checkout,
        req: { agentId: AGENT, path: 'guides/setup/README.md', offset: 0, limit: 65_536 }
      })
    )
    expect(missing).toMatchObject({ ok: true, value: { exists: false } })

    const created = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: {
          agentId: AGENT,
          path: 'guides/setup/README.md',
          contentBase64: Buffer.from('nested\n').toString('base64')
        }
      })
    )
    expect(created.ok).toBe(true)
    expect(readFileSync(join(checkout, 'guides', 'setup', 'README.md'), 'utf8')).toBe('nested\n')
  })

  it('reports missing edit and delete ancestors as conflicts', async () => {
    const { mount, checkout } = volume()
    const handle = handlerFor(mount)
    const req = { agentId: AGENT, path: 'missing/file.md', ifMatchMtime: new Date(0).toISOString() }
    const edit = WorkspaceFilesReplySchema.parse(
      await handle('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: { ...req, contentBase64: Buffer.from('edit\n').toString('base64') }
      })
    )
    const deleted = WorkspaceFilesReplySchema.parse(
      await handle('read', { op: 'delete', root: checkout, scratch: true, req })
    )
    expect(edit).toMatchObject({ ok: false, refusal: { kind: 'conflict' } })
    expect(deleted).toMatchObject({ ok: false, refusal: { kind: 'conflict' } })
  })

  it('never creates nested parents through a symlinked component', async () => {
    const { mount, checkout } = volume()
    symlinkSync(mount, join(checkout, 'guides'), 'dir')
    const reply = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', {
        op: 'write',
        root: checkout,
        scratch: true,
        req: {
          agentId: AGENT,
          path: 'guides/setup/README.md',
          contentBase64: Buffer.from('escape\n').toString('base64')
        }
      })
    )
    expect(reply).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'path-escape' } })
    expect(() => readFileSync(join(mount, 'setup', 'README.md'))).toThrow()
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

    const reply = WorkspaceFilesReplySchema.parse(
      await handlerFor(mount)('read', { op: 'list', root: checkout, req: { agentId: AGENT, path: '', limit: 50 } })
    )
    // Not "resolved and then found to be outside" — the walk refuses to OPEN a symlinked component,
    // so the link's target is never reached at all.
    expect(reply).toMatchObject({ ok: false, refusal: { kind: 'violation', reason: 'path-escape' } })
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
        return applyWorkspaceFilesPayload(payload, mount)
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
