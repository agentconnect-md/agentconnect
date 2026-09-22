import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSpawnDirs } from '../src/acp/spawn-driver.js'
import { configFilesDir, configFilesForLaunch, materializeConfigFiles } from '../src/shim/config-file-env.js'
import { LocalFileSink, applyFileSinkPayload, resolveSinkPath, FileSinkPayloadSchema } from '../src/shim/file-sink.js'
import { ShimChannel, ShimFileSink } from '../src/shim/channels.js'
import { SANDBOX_TUNNEL_PATHS, TunnelPayloadSchema } from '../src/shim/tunnel.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'
import type { ShimCapability, ShimFrame } from '../src/shim/protocol.js'
import { shimFixtures } from './fakes/shim-sandbox.js'

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-sink-'))
}

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout)
}

/** A bound connection whose frames a test can inspect and answer. */
function fakeConnection(generation = 3): { connection: ShimConnection; sent: ShimFrame[] } {
  const sent: ShimFrame[] = []
  const connection: ShimConnection = {
    binding: {
      agentId: 'agent-a',
      sandboxUid: 'sandbox-uid-1',
      generation,
      grants: ['materialize'],
      podName: 'p',
      podUid: 'u',
      expiresAtMs: Number.MAX_SAFE_INTEGER
    },
    issuedCredential: 'cred-1',
    send: (frame) => sent.push(frame),
    onFrame: () => {},
    close: () => {}
  }
  return { connection, sent }
}

afterEach(() => {})

describe('file sink', () => {
  /** Write a launch's config files the way a driver does, through a sink over the target's own disk. */
  async function writeLaunchFiles(planned: ReturnType<typeof configFilesForLaunch>): Promise<void> {
    const sink = new LocalFileSink()
    await clearSpawnDirs(sink, [planned.dir])
    for (const file of planned.files) await sink.write(file.root, file.relPath, file.content)
  }

  it('plans the same env for a launch elsewhere as for this disk, with the pointers in the runtime filesystem', async () => {
    // Parity is the point: which secrets become files is one policy, and only where they are written moves.
    const env = { KUBECONFIG_DATA: 'apiVersion: v1\n', DOCKER_AUTH_CONFIG: '{"auths":{}}' }
    const local = agentDir()
    const target = join(agentDir(), 'config-files')
    const before = materializeConfigFiles(local, env)
    const after = configFilesForLaunch(target, env)

    const normalize = (result: typeof before, dir: string) => ({
      env: Object.fromEntries(Object.entries(result.env).map(([k, v]) => [k, v.replace(dir, '<dir>')])),
      strip: [...result.strip].sort(),
      notices: result.notices
    })
    expect(normalize(after, target)).toEqual(normalize(before, configFilesDir(local)))
    expect(after.env).toEqual({ KUBECONFIG: `${target}/kubeconfig`, DOCKER_CONFIG: `${target}/docker` })
    // Only planned: the files are the launch's to write, so nothing lands anywhere yet.
    expect(existsSync(target)).toBe(false)
    await writeLaunchFiles(after)
    expect(readFileSync(join(target, 'kubeconfig'), 'utf8')).toBe('apiVersion: v1\n')
    expect(readFileSync(join(target, 'docker', 'config.json'), 'utf8')).toBe('{"auths":{}}')
  })

  it("names POSIX paths whatever this daemon runs on, since they are the runtime filesystem's", () => {
    const planned = configFilesForLaunch('/run/agentconnect/config-files', { DOCKER_CONFIG_DATA: '{}' })
    expect(planned.env.DOCKER_CONFIG).toBe('/run/agentconnect/config-files/docker')
    expect(planned.files).toEqual([
      { root: '/run/agentconnect/config-files', relPath: ['docker', 'config.json'], content: '{}' }
    ])
    expect(planned.strip).toEqual(['DOCKER_CONFIG_DATA'])
  })

  it('leaves an explicitly set pointer alone and says so, carrying no file for it', () => {
    const planned = configFilesForLaunch('/rt/config-files', { KUBECONFIG_DATA: 'x', KUBECONFIG: '/mine' })
    expect(planned.files).toEqual([])
    expect(planned.env).toEqual({})
    expect(planned.strip).toEqual([])
    expect(planned.notices.join(' ')).toMatch(/KUBECONFIG is set explicitly/)
  })

  it('writes secrets 0600 and their directories 0700', async () => {
    const target = join(agentDir(), 'config-files')
    await writeLaunchFiles(configFilesForLaunch(target, { KUBECONFIG_DATA: 'x' }))
    expect(statSync(join(target, 'kubeconfig')).mode & 0o777).toBe(0o600)
    expect(statSync(target).mode & 0o777).toBe(0o700)
  })

  it('empties the directory first, so a secret removed since the last launch goes with it', async () => {
    const target = join(agentDir(), 'config-files')
    await writeLaunchFiles(configFilesForLaunch(target, { KUBECONFIG_DATA: 'first', DOCKER_CONFIG_DATA: '{}' }))
    await writeLaunchFiles(configFilesForLaunch(target, { KUBECONFIG_DATA: 'second' }))
    expect(readFileSync(join(target, 'kubeconfig'), 'utf8')).toBe('second')
    expect(existsSync(join(target, 'docker'))).toBe(false)
    await writeLaunchFiles(configFilesForLaunch(target, {}))
    expect(readdirSync(target)).toEqual([])
  })

  it('fails the launch when the directory cannot be emptied', async () => {
    const refusing = { clear: async () => 'config files could not be cleared (read-only filesystem)' }
    await expect(clearSpawnDirs(refusing, ['/rt/config-files'])).rejects.toThrow(/read-only filesystem/)
  })

  it('refuses a path that would escape its root, on whichever side runs it', () => {
    expect(() => resolveSinkPath('/tmp/root', ['ok', 'file'])).not.toThrow()
    // The schema stops the obvious traversal, and resolveSinkPath stops anything that
    // survives it — the shim re-checks because a daemon-side check is not a check here.
    expect(
      FileSinkPayloadSchema.safeParse({ op: 'write', root: '/r', relPath: ['..', 'x'], content: '' }).success
    ).toBe(false)
    expect(FileSinkPayloadSchema.safeParse({ op: 'write', root: '/r', relPath: ['a/b'], content: '' }).success).toBe(
      false
    )
    expect(() => resolveSinkPath('relative/root', ['x'])).toThrow(/absolute/)
  })

  it('applies a payload inside the sandbox after validating it again', async () => {
    const dir = agentDir()
    await applyFileSinkPayload({ op: 'write', root: dir, relPath: ['nested', 'secret'], content: 'v' })
    expect(readFileSync(join(dir, 'nested', 'secret'), 'utf8')).toBe('v')
    await applyFileSinkPayload({ op: 'clear', root: dir })
    expect(() => readFileSync(join(dir, 'nested', 'secret'), 'utf8')).toThrow()
    await expect(applyFileSinkPayload({ op: 'write', root: dir, relPath: [], content: 'v' })).rejects.toThrow()
  })
})

describe('shim channel', () => {
  it('carries the credential and generation on every request, not just at binding', async () => {
    const { connection, sent } = fakeConnection(7)
    const channel = new ShimChannel(connection, 'cred-1', timers)
    const inflight = channel.request('materialize', { op: 'clear', root: '/agent' })
    expect(sent).toHaveLength(1)
    const frame = sent[0] as Extract<ShimFrame, { type: 'shim/request' }>
    expect(frame.sessionCredential).toBe('cred-1')
    // The generation travels per frame so a renewal or relaunch cannot be silently
    // straddled: the shim refuses a frame that is not for its own incarnation.
    expect(frame.generation).toBe(7)
    channel.accept(JSON.stringify({ type: 'shim/response', id: frame.id, ok: true, payload: null }))
    await expect(inflight).resolves.toBeNull()
  })

  it('rejects the caller when the shim refuses, and ignores replies it is not awaiting', async () => {
    const { connection, sent } = fakeConnection()
    const channel = new ShimChannel(connection, 'cred-1', timers)
    const inflight = channel.request('materialize', {})
    const frame = sent[0] as Extract<ShimFrame, { type: 'shim/request' }>
    expect(
      channel.accept(JSON.stringify({ type: 'shim/response', id: frame.id, ok: false, error: 'not granted' }))
    ).toBe(true)
    await expect(inflight).rejects.toThrow(/not granted/)
    // A stray or duplicate reply is not an error path; it simply is not ours.
    expect(channel.accept(JSON.stringify({ type: 'shim/response', id: frame.id, ok: true }))).toBe(false)
    expect(channel.accept('{"nonsense": true}')).toBe(false)
  })

  it('fails in-flight requests when the channel goes away instead of hanging a turn', async () => {
    const { connection } = fakeConnection()
    const channel = new ShimChannel(connection, 'cred-1', timers)
    const inflight = channel.request('materialize', {})
    expect(channel.pendingCount()).toBe(1)
    channel.abort('channel lost')
    await expect(inflight).rejects.toThrow(/channel lost/)
    expect(channel.pendingCount()).toBe(0)
  })

  it('times out a request rather than leaving a turn parked forever', async () => {
    const { connection } = fakeConnection()
    const channel = new ShimChannel(connection, 'cred-1', timers)
    await expect(channel.request('materialize', {}, { timeoutMs: 10 })).rejects.toThrow(/timed out/)
    expect(channel.pendingCount()).toBe(0)
  })

  it('routes materialization through the channel with the daemon still deciding content', async () => {
    const { connection, sent } = fakeConnection()
    const channel = new ShimChannel(connection, 'cred-1', timers)
    const sink = new ShimFileSink(channel)
    // Answer each request as the shim would.
    const answer = () => {
      const frame = sent.at(-1) as Extract<ShimFrame, { type: 'shim/request' }>
      channel.accept(JSON.stringify({ type: 'shim/response', id: frame.id, ok: true }))
    }
    const planned = configFilesForLaunch('/rt/config-files', { KUBECONFIG_DATA: 'apiVersion: v1\n' })
    const done = (async () => {
      await clearSpawnDirs(sink, [planned.dir])
      for (const file of planned.files) await sink.write(file.root, file.relPath, file.content)
    })()
    await new Promise((resolve) => setTimeout(resolve, 5))
    answer() // clear
    await new Promise((resolve) => setTimeout(resolve, 5))
    answer() // write
    await done
    expect(planned.env.KUBECONFIG).toBe('/rt/config-files/kubeconfig')
    expect(planned.strip).toEqual(['KUBECONFIG_DATA'])
    const payloads = sent.map((frame) => (frame as Extract<ShimFrame, { type: 'shim/request' }>).payload)
    expect(payloads[0]).toMatchObject({ op: 'clear' })
    // The content crosses the channel because the daemon decided it; the shim only writes.
    expect(payloads[1]).toMatchObject({ op: 'write', relPath: ['kubeconfig'], content: 'apiVersion: v1\n' })
  })
})

describe('tunnels', () => {
  it('names a closed set of sockets rather than allowing any path', () => {
    // One entry per server the daemon actually runs. `gh`'s token helper shares gitcred.sock, so a
    // third name would have been a second in-pod path onto the same socket.
    expect(Object.keys(SANDBOX_TUNNEL_PATHS).sort()).toEqual(['gitcred', 'mcp'])
    // A generic "tunnel any socket" grant would let a compromised runtime reach whatever
    // the daemon happens to be listening on.
    expect(TunnelPayloadSchema.safeParse({ op: 'listen', tunnel: 'anything' }).success).toBe(false)
  })

  it('validates stream framing', () => {
    const streamId = '11111111-1111-4111-8111-111111111111'
    expect(TunnelPayloadSchema.safeParse({ op: 'listen', tunnel: 'gitcred' }).success).toBe(true)
    // The path is NOT a field: both sides know the map, so a daemon-supplied path would carry no
    // information while widening what the shim can be told to create.
    expect(TunnelPayloadSchema.safeParse({ op: 'listen', tunnel: 'gitcred', socketPath: '/s' }).success).toBe(true)
    expect(TunnelPayloadSchema.safeParse({ op: 'data', streamId, chunk: 'aGk=' }).success).toBe(true)
    expect(TunnelPayloadSchema.safeParse({ op: 'close', streamId }).success).toBe(true)
    expect(TunnelPayloadSchema.safeParse({ op: 'data', streamId: 'not-a-uuid', chunk: '' }).success).toBe(false)
    // A chunk that could not fit one frame is refused at the schema, not after assembling it.
    expect(TunnelPayloadSchema.safeParse({ op: 'data', streamId, chunk: 'a'.repeat(300 * 1024) }).success).toBe(false)
  })
})

describe('materialization over a real daemon-and-shim pair', () => {
  const fixtures = shimFixtures()
  afterEach(async () => {
    await fixtures.cleanup()
  })

  // The production shape: the daemon dials into the pod, and the pod's ShimServer accepts.
  async function pair(grants: ShimCapability[]): Promise<{
    channel: ShimChannel
    handled: Array<{ capability: ShimCapability; payload: unknown }>
    sandboxRoot: string
  }> {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'ac-sandbox-'))
    const handled: Array<{ capability: ShimCapability; payload: unknown }> = []
    const { endpoint } = await fixtures.sandbox({
      workspaceRoot: sandboxRoot,
      handle: async (capability, payload) => {
        handled.push({ capability, payload })
        // The shim performs the write itself, re-validating the path on its own side.
        await applyFileSinkPayload(payload)
        return null
      }
    })
    const dialer = fixtures.dialer({
      verifier: { reviewToken: async () => ({ authenticated: true, podName: 'sandbox-pod-1', podUid: 'u' }) },
      log: { info: () => {}, warn: () => {} }
    })
    const record: SpawnRecord = {
      agentId: 'agent-a',
      sandboxUid: 'sandbox-1',
      generation: 3,
      grants,
      podName: 'sandbox-pod-1'
    }
    const connection = await dialer.connect(endpoint, record, 5_000)
    const channel = new ShimChannel(connection, connection.issuedCredential, timers)
    connection.onFrame((text) => channel.accept(text))
    return { channel, handled, sandboxRoot }
  }

  it('writes a secret into the sandbox filesystem, decided by the daemon', async () => {
    const { channel, handled, sandboxRoot } = await pair(['materialize'])
    const planned = configFilesForLaunch(join(sandboxRoot, 'config-files'), { KUBECONFIG_DATA: 'apiVersion: v1\n' })
    const sink = new ShimFileSink(channel)
    await clearSpawnDirs(sink, [planned.dir])
    for (const file of planned.files) await sink.write(file.root, file.relPath, file.content)
    expect(planned.env.KUBECONFIG).toBe(join(sandboxRoot, 'config-files', 'kubeconfig'))
    // The file exists because the SHIM wrote it, over a real socket, after its own
    // validation — neither half of this is stubbed.
    expect(readFileSync(planned.env.KUBECONFIG!, 'utf8')).toBe('apiVersion: v1\n')
    expect(handled.map((entry) => entry.capability)).toEqual(['materialize', 'materialize'])
  })

  it('is refused by the shim when the launch never received the capability', async () => {
    // The grant list is enforced on both sides deliberately. Here the binding carries only
    // `exec`, so the shim refuses a materialize request even though the daemon asked.
    const { channel, handled } = await pair(['exec'])
    await expect(channel.request('materialize', { op: 'clear', root: '/tmp' })).rejects.toThrow(/not granted/)
    expect(handled).toEqual([])
  })
})
