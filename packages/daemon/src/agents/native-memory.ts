/**
 * Native-memory runtime levers + file surfacing.
 *
 * The `native` MemoryProvider (agents/memory-provider.ts) redirects the runtime's
 * OWN memory under the agent root — so each agent's native memory is isolated
 * instead of sharing the host's `~/.claude` / `~/.codex`. Two responsibilities:
 *
 *  1. `nativeRuntimeEnv` — the env delta that redirects (and, where needed, enables)
 *     the runtime's memory. The EXPLICIT per-runtime policy lives in
 *     `runtime-memory.ts`, shared with the managed/none off-switch path so the two
 *     registries cannot drift. A runtime without a native policy is unsupported.
 *
 *  2. `nativeMemoryList/Read/Write` — surface the runtime's memory files to the
 *     console from wherever the redirect points. Unlike managed's flat
 *     `<agent-root>/memory/`, the runtime dirs are nested (Claude keys memory by a
 *     sanitized-cwd subpath). Writes reject symlinked parents and publish through
 *     a random exclusive temp file.
 *
 * Levers verified 2026-07-08 (claude docs + binary strings; codex docs; and the
 * daemon's own `runtimes/probe.ts` home-override table):
 *  - claude → `CLAUDE_CONFIG_DIR=<root>/.claude`; auto-memory lands at
 *    `<root>/.claude/projects/<sanitized-cwd>/memory/`. Do NOT set the disable flag.
 *  - codex  → `CODEX_HOME=<root>/.codex`; memories at `<root>/.codex/memories/`.
 */
import { promises as fsp } from 'node:fs'
import { join, resolve, isAbsolute, sep, relative } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'
import type { MemoryEntry } from '@agentconnect.md/protocol'
import type { MemoryReadResult, MemoryWriteResult } from './memory-provider.js'
import {
  atomicWriteContainedMemoryFile,
  readContainedMemoryFile,
  MemoryPathError,
  MemoryTooLargeError,
  MAX_MEMORY_FILE_BYTES
} from './memory.js'
import { nativeRuntimeMemorySpecFor } from './runtime-memory.js'

/** Whether native memory is supported (env levers registered) for this runtime. */
export function isNativeRuntimeSupported(runtime: RuntimeDef, runtimeId?: string): boolean {
  return nativeRuntimeMemorySpecFor(runtime, runtimeId) !== undefined
}

/** The env delta redirecting the runtime's own memory under `agentRoot`. Empty for
 *  an unregistered runtime (callers should gate on `isNativeRuntimeSupported`). */
export function nativeRuntimeEnv(runtime: RuntimeDef, agentRoot: string, runtimeId?: string): Record<string, string> {
  return nativeRuntimeMemorySpecFor(runtime, runtimeId)?.env(agentRoot) ?? {}
}

/** Resolve a console-supplied relative path under `root`, allowing nested dirs but
 *  rejecting absolute paths and lexical `..` escapes. The write path separately
 *  canonicalises every parent and rejects symlinks. */
function resolveContained(root: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new MemoryPathError('absolute paths are not allowed')
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new MemoryPathError('path escapes the memory dir')
  if (abs === root) throw new MemoryPathError('a file name is required')
  return abs
}

/** Recursively list files under `dir` (relative names, posix-ish with `sep`), sorted.
 *  Empty when the dir is absent. Skips `.tmp` artifacts. */
async function listUnder(dir: string): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = []
  async function walk(cur: string): Promise<void> {
    let dirents
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const d of dirents) {
      const p = join(cur, d.name)
      if (d.isDirectory()) {
        await walk(p)
      } else if (d.isFile() && !d.name.endsWith('.tmp')) {
        try {
          const st = await fsp.stat(p)
          out.push({ name: relative(dir, p), size: st.size, mtime: st.mtime.toISOString() })
        } catch {
          // raced deletion — skip
        }
      }
    }
  }
  await walk(dir)
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** List the runtime's native memory files under the agent root. */
export async function nativeMemoryList(agentDir: string, runtime: RuntimeDef | undefined): Promise<MemoryEntry[]> {
  const spec = nativeRuntimeMemorySpecFor(runtime)
  if (!spec) return []
  return listUnder(spec.readRoot(agentDir))
}

/** Read one native memory file (relative to the runtime's read root); '' when absent. */
export async function nativeMemoryRead(
  agentDir: string,
  runtime: RuntimeDef | undefined,
  path: string
): Promise<MemoryReadResult> {
  const spec = nativeRuntimeMemorySpecFor(runtime)
  if (!spec) return { path, content: '' }
  const root = spec.readRoot(agentDir)
  const abs = resolveContained(root, path)
  return { path, content: await readContainedMemoryFile(agentDir, root, abs) }
}

/** Overwrite one native memory file (console edit). Atomic tmp+rename; size-capped. */
export async function nativeMemoryWrite(
  agentDir: string,
  runtime: RuntimeDef | undefined,
  path: string,
  content: string,
  ifMatch?: string
): Promise<MemoryWriteResult> {
  const spec = nativeRuntimeMemorySpecFor(runtime)
  if (!spec) throw new MemoryPathError('native memory is not supported for this runtime')
  if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryTooLargeError(`memory file exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
  }
  const root = spec.readRoot(agentDir)
  const abs = resolveContained(root, path)
  const { stat: st } = await atomicWriteContainedMemoryFile(agentDir, root, abs, content, ifMatch)
  return { ok: true, path, size: st.size, mtime: st.mtime.toISOString() }
}
