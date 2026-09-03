import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import {
  ArchiveStore,
  installedArchiveBin,
  installedArchiveVersions,
  parseArchiveLaunch,
  runtimeArchiveTree,
  storedArchiveRuntimeDef,
  type ArchiveFetch,
  type ArchiveLaunch
} from '../src/runtimes/archive-store.js'
import { runtimeStoreDir } from '../src/paths.js'
import type { ResolvedRuntimeEntry } from '../src/runtimes/registry.js'

const URL_A = 'https://dl.example.test/agy-acp-server-RC01-linux-x86_64.zip'
const URL_B = 'https://dl.example.test/agy-acp-server-RC02-linux-x86_64.zip'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ac-archive-'))
}

/** The resolved entry the ACP registry produces for a binary distribution with an archive. */
function entry(overrides: Partial<ResolvedRuntimeEntry> = {}): ResolvedRuntimeEntry {
  return {
    runtime: { command: './agy_acp_server.par', args: ['--uid='], env: [] },
    source: 'registry',
    name: 'Google Antigravity',
    version: '1.0.0',
    skillsAgentId: null,
    archive: URL_A,
    ...overrides
  }
}

/** A fetch that answers with a real ZIP of `files`, and records every URL it was asked for. */
function fakeFetch(files: Record<string, string>, calls: string[] = []): { fetchImpl: ArchiveFetch; calls: string[] } {
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([n, c]) => [n, Buffer.from(c)])))
  const fetchImpl: ArchiveFetch = async (url) => {
    calls.push(url)
    return new Response(new Uint8Array(zipped), { status: 200 })
  }
  return { fetchImpl, calls }
}

const PAR = { 'agy_acp_server.par': '#!par\n', localharness_external: 'data' }

const launch = (): ArchiveLaunch => parseArchiveLaunch('antigravity-acp', entry())!

describe('parseArchiveLaunch', () => {
  it('decomposes the antigravity registry entry', () => {
    expect(parseArchiveLaunch('antigravity-acp', entry())).toEqual({
      id: 'antigravity-acp',
      url: URL_A,
      version: '1.0.0',
      bin: 'agy_acp_server.par',
      args: ['--uid=']
    })
  })

  it('digests the URL when the entry version cannot name a tree', () => {
    const launch = parseArchiveLaunch('antigravity-acp', entry({ version: '' }))
    expect(launch?.version).toMatch(/^[0-9a-f]{12}$/)
    // A moved build must not land in the tree the previous one owns.
    const moved = parseArchiveLaunch('antigravity-acp', entry({ version: '', archive: URL_B }))
    expect(moved?.version).not.toEqual(launch?.version)
  })

  it('refuses an entry that is not an https archive of one flat binary', () => {
    expect(parseArchiveLaunch('antigravity-acp', entry({ archive: undefined }))).toBeUndefined()
    expect(parseArchiveLaunch('antigravity-acp', entry({ archive: 'http://dl.example.test/a.zip' }))).toBeUndefined()
    expect(parseArchiveLaunch('antigravity-acp', entry({ archive: 'file:///tmp/a.zip' }))).toBeUndefined()
    expect(parseArchiveLaunch('../escape', entry())).toBeUndefined()
    const nested = { command: './nested/../../etc/passwd', args: [], env: [] }
    expect(parseArchiveLaunch('antigravity-acp', entry({ runtime: nested }))).toBeUndefined()
  })
})

describe('ArchiveStore', () => {
  it('extracts the archive into the store and launches the binary by absolute path', async () => {
    const dir = root()
    const { fetchImpl, calls } = fakeFetch(PAR)
    const installed = await new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())

    const tree = runtimeArchiveTree(dir, 'antigravity-acp', '1.0.0')
    expect(installed).toEqual({ tree, version: '1.0.0', bin: join(tree, 'agy_acp_server.par') })
    expect(readFileSync(installed.bin, 'utf8')).toBe('#!par\n')
    expect(existsSync(join(tree, 'localharness_external'))).toBe(true)
    expect(calls).toEqual([URL_A])
    // No staging directory survives a successful install.
    expect(existsSync(join(runtimeStoreDir(dir), '.staging'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('gives every extracted member the execute bit', async () => {
    const dir = root()
    const { fetchImpl } = fakeFetch(PAR)
    const installed = await new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())
    expect(statSync(installed.bin).mode & 0o111).toBe(0o111)
  })

  it('fetches once per archive and reuses the install across stores', async () => {
    const dir = root()
    const { fetchImpl, calls } = fakeFetch(PAR)
    const store = new ArchiveStore({ root: dir, fetchImpl })
    const [a, b] = await Promise.all([store.ensure(launch()), store.ensure(launch())])
    expect(a).toEqual(b)
    // A restarted daemon finds the tree the last one left and never fetches again.
    await new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())
    expect(calls).toEqual([URL_A])
  })

  it('reinstalls when the vendor moves the build behind the same version', async () => {
    const dir = root()
    const first = fakeFetch(PAR)
    await new ArchiveStore({ root: dir, fetchImpl: first.fetchImpl }).ensure(launch())
    const moved = parseArchiveLaunch('antigravity-acp', entry({ archive: URL_B }))!
    const second = fakeFetch({ 'agy_acp_server.par': '#!rc02\n' })
    const installed = await new ArchiveStore({ root: dir, fetchImpl: second.fetchImpl }).ensure(moved)
    expect(readFileSync(installed.bin, 'utf8')).toBe('#!rc02\n')
    expect(second.calls).toEqual([URL_B])
  })

  it('drops the versions this daemon no longer launches', async () => {
    const dir = root()
    const stale = runtimeArchiveTree(dir, 'antigravity-acp', '0.9.0')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'agy_acp_server.par'), 'old')
    const { fetchImpl } = fakeFetch(PAR)
    await new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())
    expect(installedArchiveVersions(dir, 'antigravity-acp')).toEqual(['1.0.0'])
    expect(existsSync(stale)).toBe(false)
  })

  it('leaves no install when the archive lacks the binary the registry named', async () => {
    const dir = root()
    const { fetchImpl } = fakeFetch({ readme: 'nothing to launch' })
    await expect(new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())).rejects.toThrow(
      /contains no "agy_acp_server\.par"/
    )
    expect(installedArchiveVersions(dir, 'antigravity-acp')).toEqual([])
  })

  it('refuses an archive member that is not a flat file name', async () => {
    const dir = root()
    const { fetchImpl } = fakeFetch({ '../escape.par': 'x' })
    await expect(new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())).rejects.toThrow(/flat file name/)
    expect(existsSync(runtimeArchiveTree(dir, 'antigravity-acp', '1.0.0'))).toBe(false)
  })

  it('leaves no install when the fetch fails', async () => {
    const dir = root()
    const fetchImpl: ArchiveFetch = async () => new Response(null, { status: 404 })
    await expect(new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())).rejects.toThrow(/HTTP 404/)
    expect(installedArchiveVersions(dir, 'antigravity-acp')).toEqual([])
  })
})

describe('installedArchiveBin', () => {
  it('reports nothing for a tree with no marker, a foreign URL, or a missing binary', async () => {
    const dir = root()
    const { fetchImpl } = fakeFetch(PAR)
    await new ArchiveStore({ root: dir, fetchImpl }).ensure(launch())
    const tree = runtimeArchiveTree(dir, 'antigravity-acp', '1.0.0')
    expect(installedArchiveBin(tree, launch())).toBe(join(tree, 'agy_acp_server.par'))
    expect(installedArchiveBin(tree, parseArchiveLaunch('antigravity-acp', entry({ archive: URL_B }))!)).toBeUndefined()
    expect(installedArchiveBin(join(dir, 'absent'), launch())).toBeUndefined()
  })
})

describe('storedArchiveRuntimeDef', () => {
  it('launches the stored binary and carves its tree back into the sandbox', () => {
    const runtime = { command: './agy_acp_server.par', args: ['--uid='], env: [] }
    const installed = {
      tree: '/root/runtimes/antigravity-acp@1.0.0',
      version: '1.0.0',
      bin: '/root/runtimes/antigravity-acp@1.0.0/agy_acp_server.par'
    }
    expect(storedArchiveRuntimeDef(runtime, installed)).toEqual({
      command: installed.bin,
      args: ['--uid='],
      env: [],
      readRoots: [installed.tree]
    })
  })
})
