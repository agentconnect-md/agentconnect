import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_READINESS_FILE,
  READINESS_HTTP_PATH,
  ReadinessGate,
  readinessSinksFromEnv,
  readinessState,
  type ReadinessState
} from '../src/readiness.js'

// Pool-member readiness (#1043): what the deployment side's probe is allowed to conclude from the
// two sinks, and the transitions it has to observe for a rollout barrier to be exact.

const silent = { info: () => {}, warn: () => {} }

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'ac-readiness-')), 'ready')
}

async function get(port: number, path = READINESS_HTTP_PATH): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: response.status, body: await response.text() }
}

describe('readinessState', () => {
  const up = { startupComplete: true, cpRegistered: true, runtimeProbed: true, draining: false }

  it('is ready once the member is registered and the runtime probe has returned', () => {
    expect(readinessState(up)).toEqual({ ready: true, reason: 'ready' })
  })

  it('is not ready while startup has not finished, whatever else already holds', () => {
    expect(readinessState({ ...up, startupComplete: false })).toEqual({ ready: false, reason: 'starting' })
  })

  it('is not ready while the control-plane registration is unacknowledged', () => {
    expect(readinessState({ ...up, cpRegistered: false })).toEqual({
      ready: false,
      reason: 'control-plane-unregistered'
    })
  })

  it('is not ready while the install-wide runtime probe is outstanding', () => {
    expect(readinessState({ ...up, runtimeProbed: false })).toEqual({ ready: false, reason: 'runtime-probe-pending' })
  })

  it('is not ready while draining, however registered and probed the member is', () => {
    expect(readinessState({ ...up, draining: true })).toEqual({ ready: false, reason: 'draining' })
  })
})

describe('readinessSinksFromEnv', () => {
  it('leaves the endpoint off and the file on its default path when nothing is configured', () => {
    expect(readinessSinksFromEnv({})).toEqual({ filePath: DEFAULT_READINESS_FILE })
  })

  it('takes the configured port and path', () => {
    expect(readinessSinksFromEnv({ AC_READINESS_PORT: '9099', AC_READINESS_FILE: '/run/ac/ready' })).toEqual({
      port: 9099,
      filePath: '/run/ac/ready'
    })
  })

  it('reports an unusable port instead of guessing at one, and an empty path disables the file', () => {
    const warnings: string[] = []
    expect(
      readinessSinksFromEnv({ AC_READINESS_PORT: 'http', AC_READINESS_FILE: '' }, (m) => warnings.push(m))
    ).toEqual({})
    expect(warnings).toHaveLength(1)
  })
})

describe('ReadinessGate', () => {
  it('answers 503 until the member is servable and 200 after, on its own path only', async () => {
    let state: ReadinessState = { ready: false, reason: 'control-plane-unregistered' }
    const gate = new ReadinessGate({ port: 0, state: () => state, host: '127.0.0.1', log: silent })
    await gate.start()
    const port = gate.listeningPort()!
    try {
      const pending = await get(port)
      expect(pending.status).toBe(503)
      expect(JSON.parse(pending.body)).toEqual({ ready: false, reason: 'control-plane-unregistered' })
      state = { ready: true, reason: 'ready' }
      expect((await get(port)).status).toBe(200)
      // The port serves readiness, not a general health surface.
      expect((await get(port, '/')).status).toBe(404)
    } finally {
      await gate.stop()
    }
  })

  it('writes the readiness file only while ready, and removes it when the member drains', async () => {
    const path = file()
    let state: ReadinessState = { ready: false, reason: 'runtime-probe-pending' }
    const gate = new ReadinessGate({ filePath: path, state: () => state, log: silent })
    await gate.start()
    try {
      expect(existsSync(path)).toBe(false)
      state = { ready: true, reason: 'ready' }
      gate.refresh()
      expect(existsSync(path)).toBe(true)
      state = { ready: false, reason: 'draining' }
      gate.refresh()
      expect(existsSync(path)).toBe(false)
    } finally {
      await gate.stop()
    }
  })

  it('clears a file left behind by an earlier container before it proves anything', async () => {
    const path = file()
    writeFileSync(path, 'ready\n')
    const gate = new ReadinessGate({
      filePath: path,
      state: () => ({ ready: false, reason: 'control-plane-unregistered' }),
      log: silent
    })
    await gate.start()
    try {
      expect(existsSync(path)).toBe(false)
    } finally {
      await gate.stop()
    }
  })

  it('removes the file on stop so an exited process never reads as servable', async () => {
    const path = file()
    const gate = new ReadinessGate({ filePath: path, state: () => ({ ready: true, reason: 'ready' }), log: silent })
    await gate.start()
    expect(existsSync(path)).toBe(true)
    await gate.stop()
    expect(existsSync(path)).toBe(false)
  })

  it('reconciles the file on its own tick, without an explicit refresh', async () => {
    const path = file()
    let state: ReadinessState = { ready: false, reason: 'runtime-probe-pending' }
    const gate = new ReadinessGate({ filePath: path, state: () => state, syncIntervalMs: 5, log: silent })
    await gate.start()
    try {
      state = { ready: true, reason: 'ready' }
      await expect.poll(() => existsSync(path)).toBe(true)
    } finally {
      await gate.stop()
    }
  })
})
