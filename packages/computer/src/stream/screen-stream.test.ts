import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureInputs } from './ffmpeg.js'
import { ScreenStream } from './screen-stream.js'

const POINTER_OFF = /(draw_mouse=|draw_mouse |capture_cursor )0/
const POINTER_ON = /(draw_mouse=|draw_mouse |capture_cursor )1/

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'screen-stream-'))
  // Wayland captures through the portal helper instead of an ffmpeg grabber flag.
  vi.stubEnv('WAYLAND_DISPLAY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('captureInputs', () => {
  it('leaves the pointer out of every input when asked', () => {
    for (const input of captureInputs(10, dir, 0, false)) expect(input.args.join(' ')).toMatch(POINTER_OFF)
    for (const input of captureInputs(10, dir)) expect(input.args.join(' ')).toMatch(POINTER_ON)
  })
})

describe('ScreenStream', () => {
  it.skipIf(process.platform === 'win32')('restarts the capture at once when the pointer setting changes', async () => {
    // Stands in for ffmpeg: records each start's arguments, then idles until killed.
    const log = join(dir, 'starts.log')
    const ffmpeg = join(dir, 'ffmpeg')
    writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> '${log}'\nexec sleep 30\n`, { mode: 0o755 })
    const starts = (): string[] => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n')
      } catch {
        return []
      }
    }
    let cursor = true
    const stream = new ScreenStream({
      dataDir: dir,
      ffmpeg: () => ffmpeg,
      cursor: () => cursor,
      fps: 10,
      maxWidth: 1280,
      bitrateKbps: 1000,
      log: () => undefined
    })
    const unsubscribe = stream.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(starts()).toHaveLength(1))
      stream.refresh()
      cursor = false
      stream.refresh()
      // Well inside the 2 s crash-restart delay: a pointer swap is not a failure.
      await vi.waitFor(() => expect(starts()).toHaveLength(2), { timeout: 1500 })
      expect(starts()[0]).toMatch(POINTER_ON)
      expect(starts()[1]).toMatch(POINTER_OFF)
      expect(stream.lastError).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })
})
