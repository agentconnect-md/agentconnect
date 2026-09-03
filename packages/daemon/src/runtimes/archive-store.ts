import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import type { RuntimeDef } from '../config/config-schema.js'
import { runtimeStoreDir } from '../paths.js'
import type { ResolvedRuntimeEntry } from './registry.js'

// Some ACP agents ship as a signed vendor binary in a ZIP rather than an npm package, and the
// registry's `cmd` for those (`./agy_acp_server.par`) only means anything to a client that fetched
// the archive itself. This store is that client: one install per (id, version) under the daemon
// root, launched by absolute path, so no agent spawn downloads anything and no adapter loads its
// code out of a writable HOME. Presence on the host is a separate question — the probe answers it
// from the product's own state dir, exactly as it does for an `npx`-distributed adapter.

/** One archive-distributed launch: what to fetch, where its binary lands, and the args it gets. */
export interface ArchiveLaunch {
  id: string
  url: string
  version: string
  /** The archive member to launch, a flat file name. */
  bin: string
  args: string[]
}

/** One installed archive: the tree, the version it holds, and the absolute binary to launch. */
export interface StoredRuntimeArchive {
  tree: string
  version: string
  bin: string
}

// A registry answer becomes a directory name, so refuse anything that is not plainly a version.
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]*$/
// Archive members and store ids stay flat, printable, and free of any path or shell meaning.
const FLAT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MARKER_FILE = '.archive.json'
// A vendor agent binary is hundreds of megabytes; these bound a hostile archive, not a large one.
const MAX_FILES = 64
const MAX_EXPANDED_BYTES = 6 * 1024 * 1024 * 1024
// Bounded because a start-time install waits on it: a cold multi-hundred-megabyte fetch fits, a
// stalled CDN fails the install instead of parking the daemon forever.
const FETCH_TIMEOUT_MS = 30 * 60_000

export type ArchiveFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/** Decompose a resolved entry into the archive the store can install, or undefined when it is not one. */
export function parseArchiveLaunch(
  id: string,
  entry: Pick<ResolvedRuntimeEntry, 'runtime' | 'archive' | 'version'>
): ArchiveLaunch | undefined {
  if (!entry.archive || !FLAT_NAME_RE.test(id)) return undefined
  let url: URL
  try {
    url = new URL(entry.archive)
  } catch {
    return undefined
  }
  // No plaintext and no `file:`: the store's install is the runtime's parent process.
  if (url.protocol !== 'https:') return undefined
  // The registry writes the member as `./name` or `name`; anything with real path structure is not
  // a member of this archive, and taking its basename would launch something else under that name.
  const bin = entry.runtime.command.replace(/^\.[/\\]/, '')
  if (!FLAT_NAME_RE.test(bin)) return undefined
  // The registry version names the product, not the build; digest the URL when it cannot name a tree.
  const version = VERSION_RE.test(entry.version)
    ? entry.version
    : createHash('sha256').update(entry.archive).digest('hex').slice(0, 12)
  return { id, url: entry.archive, version, bin, args: entry.runtime.args }
}

/** `<root>/runtimes/<id>@<version>` — the tree one archive install owns outright. */
export function runtimeArchiveTree(root: string, id: string, version: string): string {
  return join(runtimeStoreDir(root), `${id}@${version}`)
}

/** Versions of `id` already installed in the store. */
export function installedArchiveVersions(root: string, id: string): string[] {
  try {
    return readdirSync(runtimeStoreDir(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}@`))
      .map((entry) => entry.name.slice(id.length + 1))
      .filter((version) => VERSION_RE.test(version) || /^[0-9a-f]{12}$/.test(version))
  } catch {
    return []
  }
}

/** The launchable binary inside an installed tree, or undefined when it is absent or holds another URL. */
export function installedArchiveBin(tree: string, launch: ArchiveLaunch): string | undefined {
  let marker: { url?: unknown }
  try {
    marker = JSON.parse(readFileSync(join(tree, MARKER_FILE), 'utf8')) as { url?: unknown }
  } catch {
    return undefined
  }
  // A vendor can move a build behind the same version; the URL is what the tree actually holds.
  if (marker.url !== launch.url) return undefined
  const bin = join(tree, launch.bin)
  return existsSync(bin) ? bin : undefined
}

/** Launch the store's own install by absolute path; the outer sandbox denies the daemon root, so carve the tree back. */
export function storedArchiveRuntimeDef(runtime: RuntimeDef, installed: StoredRuntimeArchive): RuntimeDef {
  return {
    ...runtime,
    command: installed.bin,
    readRoots: [...(runtime.readRoots ?? []), installed.tree]
  }
}

export interface ArchiveStoreOptions {
  root: string
  fetchImpl?: ArchiveFetch
  log?: { info(message: string): void; warn(message: string): void }
}

/** Installs archive-distributed ACP agents under the daemon root and reports where to launch them. */
export class ArchiveStore {
  private readonly inFlight = new Map<string, Promise<StoredRuntimeArchive>>()
  private readonly fetchImpl: ArchiveFetch

  constructor(private readonly opts: ArchiveStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  /** One install per archive for this daemon's lifetime: two hosts starting at once share this promise. */
  ensure(launch: ArchiveLaunch): Promise<StoredRuntimeArchive> {
    const key = `${launch.id}@${launch.version}:${launch.bin}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const run = this.install(launch)
    this.inFlight.set(key, run)
    void run.catch(() => {})
    return run
  }

  private async install(launch: ArchiveLaunch): Promise<StoredRuntimeArchive> {
    const tree = runtimeArchiveTree(this.opts.root, launch.id, launch.version)
    const present = installedArchiveBin(tree, launch)
    if (present) return { tree, version: launch.version, bin: present }
    // Extract into staging and rename, so a partial tree is never visible as an install.
    const staging = join(runtimeStoreDir(this.opts.root), `.staging-${randomUUID().slice(0, 8)}`)
    mkdirSync(staging, { recursive: true })
    try {
      this.opts.log?.info(`runtimes: fetching "${launch.id}" archive ${launch.url}`)
      const files = await this.extract(launch.url, staging)
      if (!files.includes(launch.bin)) {
        throw new Error(`archive for ${launch.id}@${launch.version} contains no "${launch.bin}"`)
      }
      writeFileSync(join(staging, MARKER_FILE), `${JSON.stringify({ url: launch.url, version: launch.version })}\n`)
      mkdirSync(dirname(tree), { recursive: true })
      rmSync(tree, { recursive: true, force: true })
      renameSync(staging, tree)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
    this.prune(launch.id, launch.version)
    return { tree, version: launch.version, bin: join(tree, launch.bin) }
  }

  /** Stream the ZIP straight into `dir` — the whole archive never lands on disk compressed as well. */
  private async extract(url: string, dir: string): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`archive fetch failed: HTTP ${res.status}`)
      if (!res.body) throw new Error('archive fetch returned no body')
      return await this.inflate(res.body, dir)
    } finally {
      clearTimeout(timer)
    }
  }

  private async inflate(body: ReadableStream<Uint8Array>, dir: string): Promise<string[]> {
    const written: string[] = []
    const open = new Map<string, number>()
    let expanded = 0
    let failure: Error | undefined
    const unzip = new Unzip()
    unzip.register(UnzipInflate)
    unzip.onfile = (file) => {
      // Directory entries carry no data, and a member the store cannot name flatly is refused outright.
      if (file.name.endsWith('/')) return
      if (!FLAT_NAME_RE.test(file.name)) {
        failure ??= new Error(`archive member is not a flat file name: ${file.name.slice(0, 64)}`)
        return
      }
      if (written.length >= MAX_FILES) {
        failure ??= new Error(`archive holds more than ${MAX_FILES} files`)
        return
      }
      written.push(file.name)
      const path = join(dir, file.name)
      file.ondata = (err, chunk, final) => {
        if (err) failure ??= err
        if (failure) return
        expanded += chunk.length
        if (expanded > MAX_EXPANDED_BYTES) {
          failure ??= new Error('archive expands beyond the daemon ceiling')
          return
        }
        let fd = open.get(path)
        if (fd === undefined) {
          // Every member is a vendor executable or its data; the launch needs the execute bit.
          fd = openSync(path, 'w', 0o755)
          open.set(path, fd)
        }
        if (chunk.length > 0) writeSync(fd, chunk)
        if (final) {
          closeSync(fd)
          open.delete(path)
          if (process.platform !== 'win32') chmodSync(path, 0o755)
        }
      }
      file.start()
    }
    try {
      for await (const chunk of body) {
        if (failure) break
        unzip.push(chunk)
      }
      if (!failure) unzip.push(new Uint8Array(0), true)
    } catch (err) {
      failure ??= err as Error
    } finally {
      for (const fd of open.values()) closeSync(fd)
    }
    if (failure) throw failure
    return written
  }

  /** Drop versions this daemon no longer launches; the store resolves before any host is running. */
  private prune(id: string, keep: string): void {
    for (const version of installedArchiveVersions(this.opts.root, id)) {
      if (version === keep) continue
      try {
        rmSync(runtimeArchiveTree(this.opts.root, id, version), { recursive: true, force: true })
      } catch (err) {
        this.opts.log?.warn(`runtimes: could not remove ${id}@${version} — ${(err as Error).message}`)
      }
    }
  }
}
