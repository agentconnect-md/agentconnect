/**
 * Symlink-safe path resolution for daemon-authority writes into trees an AGENT
 * can influence.
 *
 * The daemon runs OUTSIDE the agent's sandbox. Anywhere it writes using an
 * ordinary pathname — the memory dir, or a skill root inside the workspace — the
 * agent can replace a component with a symlink and redirect a daemon-privileged
 * `mkdir`/`copy`/`rm -rf` to an arbitrary host path. Node exposes no `openat`
 * family, so a path cannot be pinned to a descriptor; the containment we CAN get
 * is:
 *
 *   1. lexical containment (`boundary` ⊇ `root` ⊇ `destination`),
 *   2. a component-by-component walk that `lstat`s each step and REJECTS a
 *      symlink instead of following it, creating missing directories itself,
 *   3. `realpath` after each step, re-checking containment, so a component that
 *      resolves outside the boundary is caught even if it was a directory,
 *   4. handing back a target built from the REAL parent, so the caller's write
 *      cannot be re-pointed by swapping a parent afterwards.
 *
 * This is the discipline `agents/memory.ts` has shipped; it lives here so the
 * skill materializer uses the same one rather than a second, subtly-different
 * copy. It narrows the TOCTOU window rather than closing it — an attacker who
 * wins a race between the final `lstat` and the caller's `open` is still
 * possible in principle — so callers should also publish through an exclusive
 * temp file and rename where the content matters.
 */
import { promises as fsp, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Raised when a path escapes its boundary or traverses a symlink. */
export class ContainedPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContainedPathError'
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** Is `path` at or beneath `root`, lexically? */
export function under(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export interface ContainedTargetOptions {
  /** Create missing parent directories (write side). Off ⇒ a missing component
   *  yields `null`, which read callers treat as "nothing there". */
  create: boolean
  /** Message prefix so callers keep their own vocabulary in errors. */
  label?: string
}

/**
 * Resolve `destination` to a real, contained path, or `null` when a component is
 * missing and `create` is false.
 *
 * `boundary` is the trusted outer directory nothing may escape; `root` is the
 * subtree the destination must sit in (often a child of `boundary`).
 */
export async function containedTarget(
  boundary: string,
  root: string,
  destination: string,
  opts: ContainedTargetOptions
): Promise<string | null> {
  const label = opts.label ?? 'path'
  const lexicalBoundary = resolve(boundary)
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(destination)
  if (!under(lexicalBoundary, lexicalRoot) || !under(lexicalRoot, lexicalTarget)) {
    throw new ContainedPathError(`${label} escapes its root`)
  }

  let realBoundary: string
  try {
    realBoundary = await fsp.realpath(lexicalBoundary)
  } catch (err) {
    if (!opts.create && isErrno(err, 'ENOENT')) return null
    throw err
  }

  let parent = realBoundary
  for (const part of relative(lexicalBoundary, dirname(lexicalTarget)).split(sep).filter(Boolean)) {
    const candidate = join(parent, part)
    let stat: Stats
    try {
      stat = await fsp.lstat(candidate)
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
      if (!opts.create) return null
      try {
        await fsp.mkdir(candidate)
      } catch (mkdirErr) {
        if (!isErrno(mkdirErr, 'EEXIST')) throw mkdirErr
      }
      stat = await fsp.lstat(candidate)
    }
    // lstat never follows, so a symlink-to-directory reports isDirectory() ===
    // false here — which is exactly the escape we are refusing.
    if (!stat.isDirectory()) throw new ContainedPathError(`${label} contains a symlink or non-directory`)
    parent = await fsp.realpath(candidate)
    if (!under(realBoundary, parent)) throw new ContainedPathError(`${label} resolves outside its boundary`)
  }

  let realRoot: string
  try {
    realRoot = await fsp.realpath(lexicalRoot)
  } catch (err) {
    if (!opts.create && isErrno(err, 'ENOENT')) return null
    throw err
  }
  if (!under(realBoundary, realRoot) || !under(realRoot, parent)) {
    throw new ContainedPathError(`${label} resolves outside its root`)
  }
  return join(parent, basename(lexicalTarget))
}

/**
 * Remove `target` only if it is a real directory reached without traversing a
 * symlink. A plain `rm -rf` on an agent-influenced path is the escape this
 * exists to prevent: the agent points the name at an outside tree and the
 * daemon deletes it.
 */
export async function containedRemoveDir(boundary: string, root: string, target: string): Promise<void> {
  const resolved = await containedTarget(boundary, root, target, { create: false, label: 'skill path' })
  if (!resolved) return
  let stat: Stats
  try {
    stat = await fsp.lstat(resolved)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return
    throw err
  }
  // Refuse to delete through a link; an unexpected file type is equally suspect.
  if (!stat.isDirectory()) throw new ContainedPathError('skill path contains a symlink or non-directory')
  await fsp.rm(resolved, { recursive: true, force: true })
}
