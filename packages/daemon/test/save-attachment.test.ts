import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PinnedDir, saveAttachmentTo, saveInto } from '../src/mcp/ops/save-attachment.js'
import { DirHandle } from '../src/shim/safe-descent.js'
import { canonicalWorkspacePath } from '../src/workspace/workspace-files.js'
import { LocalWorkspaceFs, WorkspaceFileExistsError } from '../src/workspace/workspace-fs.js'

// The two PR-review findings on the attachment saver, exercised against the REAL local seam
// (the pod arm shares the helper; only the containment supplier differs).
describe('saveAttachmentTo (workspace-fs arm, realpath fallback)', () => {
  let base: string
  let root: string
  let outside: string
  const fs = new LocalWorkspaceFs()
  const local = () => ({ kind: 'workspace-fs' as const, fs, root, canonicalDir: canonicalWorkspacePath })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ac-save-attachment-')))
    root = join(base, 'workspace')
    outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('lands a file under uploads/ and reports the workspace-relative path', async () => {
    const res = await saveAttachmentTo(local(), 'report.pdf', Buffer.from('%PDF-1'))
    expect(res).toEqual({ ok: true, path: 'uploads/report.pdf' })
    expect(await readFile(join(root, 'uploads', 'report.pdf'), 'utf8')).toBe('%PDF-1')
  })

  it('P1: refuses to write through a symlinked uploads/ that escapes the workspace', async () => {
    await symlink(outside, join(root, 'uploads'))
    const res = await saveAttachmentTo(local(), 'report.pdf', Buffer.from('%PDF-1'))
    expect(res).toEqual({ ok: false, reason: 'escape' })
    await expect(readFile(join(outside, 'report.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('P1: refuses a symlinked uploads/ even when it points inside the workspace', async () => {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'uploads'))
    const res = await saveAttachmentTo(local(), 'report.pdf', Buffer.from('%PDF-1'))
    expect(res).toEqual({ ok: false, reason: 'escape' })
  })

  it('P1: a symlink planted at the target file name is not followed', async () => {
    await mkdir(join(root, 'uploads'))
    await symlink(join(outside, 'victim'), join(root, 'uploads', 'report.pdf'))
    const res = await saveAttachmentTo(local(), 'report.pdf', Buffer.from('%PDF-1'))
    // The dangling symlink occupies the name; the digest sibling takes the bytes.
    expect(res).toMatchObject({ ok: true, path: expect.stringMatching(/^uploads\/report-[0-9a-f]{8}\.pdf$/) })
    await expect(readFile(join(outside, 'victim'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('P2: two concurrent saves of DIFFERENT bytes under one name both survive at distinct paths', async () => {
    const a = Buffer.from('first document')
    const b = Buffer.from('second document')
    const [ra, rb] = await Promise.all([
      saveAttachmentTo(local(), 'report.pdf', a),
      saveAttachmentTo(local(), 'report.pdf', b)
    ])
    expect(ra.ok && rb.ok).toBe(true)
    if (!ra.ok || !rb.ok) return
    expect(ra.path).not.toBe(rb.path)
    expect(await readFile(join(root, ra.path))).toEqual(a)
    expect(await readFile(join(root, rb.path))).toEqual(b)
  })

  it('reuses the existing file when the same bytes arrive under the same name', async () => {
    const bytes = Buffer.from('same')
    expect(await saveAttachmentTo(local(), 'a.zip', bytes)).toEqual({ ok: true, path: 'uploads/a.zip' })
    expect(await saveAttachmentTo(local(), 'a.zip', bytes)).toEqual({ ok: true, path: 'uploads/a.zip' })
  })

  it('different bytes under a taken name go to the digest-suffixed sibling', async () => {
    await mkdir(join(root, 'uploads'))
    await writeFile(join(root, 'uploads', 'a.zip'), 'old')
    const res = await saveAttachmentTo(local(), 'a.zip', Buffer.from('new'))
    expect(res).toMatchObject({ ok: true, path: expect.stringMatching(/^uploads\/a-[0-9a-f]{8}\.zip$/) })
    expect(await readFile(join(root, 'uploads', 'a.zip'), 'utf8')).toBe('old')
  })
})

// The Linux local arm: the directory is held open, so a swap AFTER validation cannot redirect
// the write (the review's remaining P1). /proc/self/fd is Linux-only, like the sandbox it protects.
describe.skipIf(process.platform !== 'linux')('saveAttachmentTo (pinned arm, Linux)', () => {
  let base: string
  let root: string
  let outside: string
  const pinned = () => ({ kind: 'pinned' as const, root })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ac-save-pinned-')))
    root = join(base, 'workspace')
    outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('creates uploads/ from the root descriptor and lands the file', async () => {
    expect(await saveAttachmentTo(pinned(), 'report.pdf', Buffer.from('%PDF-1'))).toEqual({
      ok: true,
      path: 'uploads/report.pdf'
    })
    expect(await readFile(join(root, 'uploads', 'report.pdf'), 'utf8')).toBe('%PDF-1')
  })

  it('refuses a symlinked uploads/ up front', async () => {
    await symlink(outside, join(root, 'uploads'))
    expect(await saveAttachmentTo(pinned(), 'report.pdf', Buffer.from('x'))).toEqual({ ok: false, reason: 'escape' })
    expect(await readdir(outside)).toEqual([])
  })

  it('P1: a directory swap AFTER validation cannot redirect the write outside the workspace', async () => {
    await mkdir(join(root, 'uploads'))
    const anchor = await DirHandle.openAnchor(root)
    const dir = await anchor.childDir('uploads')
    try {
      // The agent swaps the validated directory for a symlink to an outside directory, between
      // the daemon's check and its write.
      await rename(join(root, 'uploads'), join(root, 'uploads.moved'))
      await symlink(outside, join(root, 'uploads'))
      const res = await saveInto(new PinnedDir(dir), 'report.pdf', Buffer.from('%PDF-1'))
      expect(res).toEqual({ ok: true, path: 'uploads/report.pdf' })
      // The bytes went to the inode we held (now `uploads.moved`), and NOTHING reached `outside`.
      expect(await readFile(join(root, 'uploads.moved', 'report.pdf'), 'utf8')).toBe('%PDF-1')
      expect(await readdir(outside)).toEqual([])
    } finally {
      await dir.close()
      await anchor.close()
    }
  })

  it('P1: a symlink planted at the leaf name is neither followed for reading nor for publishing', async () => {
    await mkdir(join(root, 'uploads'))
    await writeFile(join(outside, 'victim'), 'untouched')
    await symlink(join(outside, 'victim'), join(root, 'uploads', 'report.pdf'))
    const res = await saveAttachmentTo(pinned(), 'report.pdf', Buffer.from('%PDF-1'))
    expect(res).toMatchObject({ ok: true, path: expect.stringMatching(/^uploads\/report-[0-9a-f]{8}\.pdf$/) })
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('untouched')
  })

  it('P2: concurrent different-bytes saves both survive at distinct paths', async () => {
    const a = Buffer.from('first')
    const b = Buffer.from('second')
    const [ra, rb] = await Promise.all([
      saveAttachmentTo(pinned(), 'report.pdf', a),
      saveAttachmentTo(pinned(), 'report.pdf', b)
    ])
    expect(ra.ok && rb.ok).toBe(true)
    if (!ra.ok || !rb.ok) return
    expect(ra.path).not.toBe(rb.path)
    expect(await readFile(join(root, ra.path))).toEqual(a)
    expect(await readFile(join(root, rb.path))).toEqual(b)
  })

  it('reuses identical bytes and leaves no staging files behind', async () => {
    const bytes = Buffer.from('same')
    expect(await saveAttachmentTo(pinned(), 'a.zip', bytes)).toEqual({ ok: true, path: 'uploads/a.zip' })
    expect(await saveAttachmentTo(pinned(), 'a.zip', bytes)).toEqual({ ok: true, path: 'uploads/a.zip' })
    expect(await readdir(join(root, 'uploads'))).toEqual(['a.zip'])
  })
})

describe('LocalWorkspaceFs.writeFile ifAbsent', () => {
  it('publishes exclusively and reports a taken name without replacing it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ac-wfs-'))
    try {
      const fs = new LocalWorkspaceFs()
      const target = join(base, 'x.bin')
      await fs.writeFile(target, Buffer.from([1]), { ifAbsent: true })
      await expect(fs.writeFile(target, Buffer.from([2]), { ifAbsent: true })).rejects.toBeInstanceOf(
        WorkspaceFileExistsError
      )
      expect(await readFile(target)).toEqual(Buffer.from([1]))
      // Without the flag the replacing rename still wins, as every marker writer expects.
      await fs.writeFile(target, 'text')
      expect(await readFile(target, 'utf8')).toBe('text')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
