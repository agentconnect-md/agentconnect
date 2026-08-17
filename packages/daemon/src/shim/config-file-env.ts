/**
 * Config-file secrets — the CI-style `*_DATA` convention (GitLab's
 * `DOCKER_AUTH_CONFIG` lineage): the agent's secret carries the FULL CONTENT of
 * a tool config file, and the daemon materializes it on disk at host spawn,
 * pointing the tool's own env var at the result. The child process never sees
 * the raw value — only the pointer:
 *
 *   KUBECONFIG_DATA     → <agentDir>/run/config-files/kubeconfig        + KUBECONFIG=<file>
 *   DOCKER_CONFIG_DATA  → <agentDir>/run/config-files/docker/config.json + DOCKER_CONFIG=<dir>
 *
 * Materializing once per spawn (instead of the retired per-invocation
 * `run/bin/docker` shim) makes the pointer var work for EVERY consumer of the
 * ecosystem convention — kubectl, helm, helmfile, client-go/SDK programs the
 * agent writes — not just the binaries we remembered to wrap.
 *
 * Placement: files live under the TRUSTED agent dir, never $TMPDIR. The Linux
 * SRT policy explicitly re-allows this directory for reads beneath the otherwise
 * hidden agent root, but never grants writes, so a confined runtime cannot
 * tamper with its own materialized config.
 *
 * Precedence: an explicitly configured pointer var wins. When the merged env
 * already sets e.g. `KUBECONFIG`, the `KUBECONFIG_DATA` secret is NOT
 * materialized (and not stripped) — the conflict is reported as a notice the
 * daemon surfaces into the session.
 *
 * This is distribution, not a same-host security boundary: the value already
 * rests in `agent.json` beside the materialized file, and same-user processes
 * can read both. Cluster/registry-side scoping (per-agent ServiceAccounts,
 * least-privilege tokens) remains the real permission boundary.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { FileSink } from './file-sink.js'
import { dirname, join, resolve } from 'node:path'

export interface ConfigFileConvention {
  /** Secret env var carrying the file CONTENT. */
  dataVar: string
  /** Legacy names still honored (first present of [dataVar, ...aliases] wins). */
  aliases?: string[]
  /** Tool-native env var the daemon points at the materialized result. */
  pointerVar: string
  /** Path of the materialized file under the config-files dir. */
  relPath: string[]
  /** What `pointerVar` must reference: the file itself, or its directory. */
  pointerTo: 'file' | 'dir'
}

export const CONFIG_FILE_CONVENTIONS: ConfigFileConvention[] = [
  {
    dataVar: 'KUBECONFIG_DATA',
    pointerVar: 'KUBECONFIG',
    relPath: ['kubeconfig'],
    pointerTo: 'file'
  },
  {
    dataVar: 'DOCKER_CONFIG_DATA',
    // Pre-rename secret name (docs/config-file-secrets.md, ex-shim era).
    aliases: ['DOCKER_AUTH_CONFIG'],
    pointerVar: 'DOCKER_CONFIG',
    relPath: ['docker', 'config.json'],
    pointerTo: 'dir'
  }
]

/** Where an agent's materialized config files live. */
export function configFilesDir(agentDir: string): string {
  return join(resolve(agentDir), 'run', 'config-files')
}

export interface ConfigFilePlanEntry {
  convention: ConfigFileConvention
  /** The env var the content actually came from (dataVar or a legacy alias). */
  sourceVar: string
  value: string
}

export interface ConfigFilePlan {
  materialize: ConfigFilePlanEntry[]
  /** Human-actionable conflict/skip messages (user-visible; no secret values). */
  notices: string[]
}

/**
 * Decide which conventions apply to a merged child env. Pure — shared by the
 * spawn path and the standing-context notice so both describe the same outcome.
 */
export function planConfigFiles(env: Record<string, string | undefined>): ConfigFilePlan {
  const materialize: ConfigFilePlanEntry[] = []
  const notices: string[] = []
  for (const convention of CONFIG_FILE_CONVENTIONS) {
    const names = [convention.dataVar, ...(convention.aliases ?? [])]
    const sourceVar = names.find((n) => env[n])
    if (!sourceVar) continue
    if (env[convention.pointerVar]) {
      notices.push(
        `${convention.pointerVar} is set explicitly, so the ${sourceVar} secret was not materialized — ` +
          `unset one of them (the explicit ${convention.pointerVar} wins).`
      )
      continue
    }
    materialize.push({ convention, sourceVar, value: env[sourceVar]! })
  }
  return { materialize, notices }
}

export interface MaterializeResult {
  /** Pointer vars to merge into the child env (they win over nothing — no collision by construction). */
  env: Record<string, string>
  /** Data vars (incl. aliases) consumed by materialization — remove from the child env. */
  strip: string[]
  /** planConfigFiles notices plus any write-failure messages. */
  notices: string[]
}

/**
 * Materialize the planned config files under `configFilesDir(agentDir)`.
 *
 * Existing contents are replaced every call, so a removed/renamed secret
 * converges to file deletion on the next host spawn. The root directory itself
 * is retained when it already exists: a warm Linux sandbox bind-mounts that
 * directory inode, so replacing it would strand the child on the removed mount.
 * A write failure keeps that convention's env untouched (the raw data var stays
 * visible to the child — degraded, but strictly more usable than losing both)
 * and reports a notice.
 */
export function materializeConfigFiles(agentDir: string, env: Record<string, string | undefined>): MaterializeResult {
  const plan = planConfigFiles(env)
  const out: MaterializeResult = { env: {}, strip: [], notices: [...plan.notices] }
  const dir = configFilesDir(agentDir)
  const clearError = clearConfigFiles(agentDir)
  if (clearError) {
    if (plan.materialize.length === 0) return out
    out.notices.push(`${clearError} — secrets left as env vars.`)
    return out
  }
  try {
    if (plan.materialize.length > 0) mkdirPrivate(dir)
  } catch (err) {
    out.notices.push(`config-files dir could not be prepared (${(err as Error).message}) — secrets left as env vars.`)
    return out
  }
  for (const entry of plan.materialize) {
    const file = join(dir, ...entry.convention.relPath)
    try {
      if (dirname(file) !== dir) mkdirPrivate(dirname(file))
      writeFileSync(file, entry.value, { mode: 0o600 })
      try {
        chmodSync(file, 0o600) // defeat a loose umask; best-effort on non-POSIX
      } catch {
        /* best-effort */
      }
    } catch (err) {
      out.notices.push(
        `${entry.sourceVar} could not be materialized to a file (${(err as Error).message}) — left as an env var.`
      )
      continue
    }
    out.env[entry.convention.pointerVar] = entry.convention.pointerTo === 'dir' ? dirname(file) : file
    // Strip every name that carries this content, not just the winning source —
    // a legacy alias must not survive alongside the materialized new name.
    for (const name of [entry.convention.dataVar, ...(entry.convention.aliases ?? [])]) {
      if (env[name]) out.strip.push(name)
    }
  }
  return out
}

/**
 * Materialize the planned config files through a {@link FileSink}, so the same policy runs
 * whether the files land on this daemon's disk or inside a sandbox pod.
 *
 * The plan is identical either way — which secrets become files is the daemon's decision.
 * Only the writing moves, because only the driver knows whose filesystem the runtime reads.
 * Failure handling matches the synchronous path: a write failure leaves that convention's
 * env untouched (the raw data var stays visible — degraded, but strictly more usable than
 * losing both) and reports a notice.
 */
export async function materializeConfigFilesThrough(
  agentDir: string,
  env: Record<string, string | undefined>,
  sink: FileSink
): Promise<MaterializeResult> {
  const plan = planConfigFiles(env)
  const out: MaterializeResult = { env: {}, strip: [], notices: [...plan.notices] }
  const dir = configFilesDir(agentDir)
  const clearError = await sink.clear(dir)
  if (clearError) {
    if (plan.materialize.length === 0) return out
    out.notices.push(`${clearError} — secrets left as env vars.`)
    return out
  }
  for (const entry of plan.materialize) {
    const file = join(dir, ...entry.convention.relPath)
    try {
      await sink.write(dir, entry.convention.relPath, entry.value)
    } catch (err) {
      out.notices.push(
        `${entry.sourceVar} could not be materialized to a file (${(err as Error).message}) — left as an env var.`
      )
      continue
    }
    out.env[entry.convention.pointerVar] = entry.convention.pointerTo === 'dir' ? dirname(file) : file
    // Strip every name that carries this content, not just the winning source —
    // a legacy alias must not survive alongside the materialized new name.
    for (const name of [entry.convention.dataVar, ...(entry.convention.aliases ?? [])]) {
      if (env[name]) out.strip.push(name)
    }
  }
  return out
}

/**
 * Remove materialized files while retaining the root directory inode. A live
 * sandbox may have that directory bind-mounted read-only; keeping it in place
 * lets a later materialization become visible inside the same warm child.
 */
export function clearConfigFiles(agentDir: string): string | undefined {
  const dir = configFilesDir(agentDir)
  try {
    for (const entry of readdirSync(dir)) {
      rmSync(join(dir, entry), { recursive: true, force: true })
    }
    return undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return `config-files contents could not be removed (${(err as Error).message})`
  }
}

/**
 * Remove an agent's materialized config-file directory after its host stops,
 * and during the boot sweep after a non-graceful exit. With no live bind mount,
 * teardown can remove the root too. Never throws: a problem comes back as a
 * message for the caller to log.
 */
export function cleanupConfigFiles(agentDir: string): string | undefined {
  try {
    rmSync(configFilesDir(agentDir), { recursive: true, force: true })
    return undefined
  } catch (err) {
    return `config-files dir could not be removed (${(err as Error).message})`
  }
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    chmodSync(path, 0o700)
  } catch {
    /* best-effort on non-POSIX */
  }
}
