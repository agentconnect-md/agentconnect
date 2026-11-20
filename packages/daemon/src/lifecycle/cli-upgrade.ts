import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_KEEP_VERSIONS, DeferredVersionPrune, VERSION_PRUNE_DEFERRED_FILE } from '@agentconnect.md/protocol'
import { cliEntryPointer } from '../paths.js'
import { MICROSANDBOX_IN_USE_ENV } from '../microsandbox/prepull.js'

export interface UpgradeLog {
  info(message: string): void
  error(message: string): void
}

/** Resolve the stable CLI entry that owns the daemon version store. */
export function readCliEntry(root: string): string | undefined {
  try {
    const entry = readFileSync(cliEntryPointer(root), 'utf8').trim()
    return entry && existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** The version `<root>/current` selects, or undefined without a version store. */
export function readCurrentVersion(root: string): string | undefined {
  try {
    return basename(readlinkSync(join(root, 'current')).replace(/[\\/]+$/, '')) || undefined
  } catch {
    return undefined
  }
}

/** The deferred prune on disk; undefined when absent or unreadable. */
export function readDeferredPrune(root: string): DeferredVersionPrune | undefined {
  try {
    const parsed = DeferredVersionPrune.safeParse(
      JSON.parse(readFileSync(join(root, VERSION_PRUNE_DEFERRED_FILE), 'utf8'))
    )
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** A CLI older than the deferral record keeps every version a live upgrade replaced, so the daemon records the prune itself. */
export function recordUpgradePrune(root: string, targetVersion: string, log: UpgradeLog): void {
  const file = join(root, VERSION_PRUNE_DEFERRED_FILE)
  if (existsSync(file)) return
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ keep: DEFAULT_KEEP_VERSIONS, protect: [targetVersion] }, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    log.error(`cp: could not record the version prune: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Install and atomically activate one CP-selected daemon version. */
export async function runCliUpgrade(
  cliEntry: string,
  targetVersion: string,
  root: string,
  log: UpgradeLog,
  configPath?: string,
  opts: { microsandboxInUse?: boolean } = {}
): Promise<boolean> {
  log.info(`cp: installing daemon ${targetVersion} via ${cliEntry}`)
  return await new Promise<boolean>((resolve) => {
    const args = [cliEntry, 'upgrade', '--to', targetVersion, '--root', root]
    if (configPath) args.push('--config', configPath)
    // The target's prepare-upgrade reads it to skip the image pre-pull where no agent runs in microsandbox.
    const env =
      opts.microsandboxInUse === undefined
        ? process.env
        : { ...process.env, [MICROSANDBOX_IN_USE_ENV]: opts.microsandboxInUse ? '1' : '0' }
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('exit', (code) => {
      if (code === 0) {
        log.info(`cp: daemon ${targetVersion} installed and activated`)
        recordUpgradePrune(root, targetVersion, log)
      } else log.error(`cp: CLI upgrade exited ${code ?? 'via signal'}`)
      resolve(code === 0)
    })
    child.on('error', (err) => {
      log.error(`cp: could not launch CLI upgrade: ${err.message}`)
      resolve(false)
    })
  })
}

/** Run `agentconnect <args> --root <root>`, forwarding its stderr while keeping a bounded tail for failure classification. */
export async function runCliCommand(
  cliEntry: string,
  args: string[],
  root: string
): Promise<{ ok: boolean; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args, '--root', root], { stdio: ['ignore', 'inherit', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
    })
    child.on('close', (code) => resolve({ ok: code === 0, stderr }))
    child.on('error', (err) => resolve({ ok: false, stderr: err.message }))
  })
}
