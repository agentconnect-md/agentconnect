import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift'

// End to end on a real X server: the bundled daemon, the pinned Cua Driver and the pinned ffmpeg (design §14.3).
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'bundle', 'agentconnect-desktop.mjs')
const display = process.env.DISPLAY
// The Xvfb screen size, so pointer moves can be checked against X's own pointer query.
const screen = { width: 1600, height: 900 }

let home: string
let daemon: ChildProcess | undefined
let daemonLog = ''
let token: string
let base: string
let mcp: Client
let xterm: ChildProcess | undefined

const desktop = (args: string[]) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, AGENTCONNECT_DESKTOP_HOME: home },
    encoding: 'utf8',
    timeout: 300_000
  })
  if (result.status !== 0) throw new Error(`desktop ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const freePort = async (): Promise<number> => {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- daemon log ---\n${daemonLog}`)
    await sleep(200)
  }
}

const pointer = (): { x: number; y: number } => {
  const out = spawnSync('xdotool', ['getmouselocation', '--shell'], { encoding: 'utf8' }).stdout
  return { x: Number(/X=(\d+)/.exec(out)?.[1]), y: Number(/Y=(\d+)/.exec(out)?.[1]) }
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }
async function call(name: string, args: Record<string, unknown> = {}): Promise<Content[]> {
  const result = (await mcp.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean }
  if (result.isError) throw new Error(`${name}: ${result.content.map((block) => block.text).join(' ')}`)
  return result.content
}

const pngSize = (png: Buffer) => {
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe.skipIf(!display)('desktop daemon on Xvfb', () => {
  beforeAll(async () => {
    if (!existsSync(cli)) throw new Error(`build the bundle first: ${cli}`)
    home = mkdtempSync(join(tmpdir(), 'ac-desktop-xvfb-'))
    const port = await freePort()
    const init = desktop(['init', '--client', 'ci', '--port', String(port)])
    token = /\b(acd_[A-Za-z0-9_-]+)/.exec(init)?.[1] ?? ''
    expect(token).not.toBe('')
    desktop(['install-ffmpeg'])
    daemon = spawn(process.execPath, [cli, 'run'], {
      env: { ...process.env, AGENTCONNECT_DESKTOP_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon.stdout!.on('data', (chunk: Buffer) => (daemonLog += chunk.toString()))
    daemon.stderr!.on('data', (chunk: Buffer) => (daemonLog += chunk.toString()))
    await until('the daemon to listen', 60_000, () => (daemonLog.includes('MCP endpoint') ? true : undefined))
    base = `http://127.0.0.1:${port}`
    mcp = new Client({ name: 'xvfb-ci', version: '0' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )
  }, 600_000)

  afterAll(async () => {
    await mcp?.close().catch(() => undefined)
    xterm?.kill()
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => daemon!.once('exit', resolve)), sleep(10_000)])
    }
    if (process.env.DESKTOP_XVFB_LOG) console.log(daemonLog)
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('captures the display through the real driver', async () => {
    const content = await call('computer_screenshot')
    const image = content.find((block) => block.type === 'image')!
    expect(image.mimeType).toBe('image/png')
    // The long edge is scaled to maxImageDimension (1280).
    expect(pngSize(Buffer.from(image.data!, 'base64'))).toEqual({ width: 1280, height: 720 })
    const [info] = JSON.parse((await call('computer_list'))[0]!.text!) as { display: Record<string, number> }[]
    expect(info!.display).toMatchObject({ screenWidth: screen.width, screenHeight: screen.height })
  })

  it('moves the real X pointer, mapping screenshot pixels to screen pixels', async () => {
    await call('computer_move', { x: 640, y: 360 })
    expect(pointer()).toEqual({ x: 800, y: 450 })
    const position = JSON.parse((await call('computer_cursor_position'))[0]!.text!)
    expect(position).toEqual({ x: 640, y: 360 })
  })

  it('clicks into a window and types into it', async () => {
    const out = join(home, 'typed.txt')
    xterm = spawn(
      'xterm',
      ['-geometry', '60x8+0+0', '-e', 'sh', '-c', `IFS= read -r line; printf %s "$line" > ${out}`],
      {
        stdio: 'ignore'
      }
    )
    await until('the xterm window', 15_000, () => {
      const found = spawnSync('xdotool', ['search', '--onlyvisible', '--class', 'xterm'], { encoding: 'utf8' })
      return found.stdout.trim() ? true : undefined
    })
    await call('computer_click', { x: 40, y: 40 })
    await call('computer_type', { text: 'agentconnect xvfb ok' })
    await call('computer_key', { keys: ['enter'] })
    const typed = await until('the typed line', 15_000, () => (existsSync(out) ? readFileSync(out, 'utf8') : undefined))
    expect(typed).toBe('agentconnect xvfb ok')
    await call('computer_release')
  })

  it('serves a screenshot frame to the viewer', async () => {
    const response = await fetch(`${base}/view/api/frame`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual({ width: 1280, height: 720 })
  })

  it('streams a decodable H.264 frame to a WebRTC viewer', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await until('ffmpeg for the viewer', 60_000, async () => {
      const status = (await (await fetch(`${base}/view/api/status`, { headers })).json()) as {
        webrtc: { unavailable: string | null }
      }
      return status.webrtc.unavailable === null ? true : undefined
    })
    const offerResponse = await fetch(`${base}/view/api/rtc/offer`, { method: 'POST', headers })
    expect(offerResponse.status).toBe(200)
    const offer = (await offerResponse.json()) as { id: string; sdp: string }

    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/H264',
            clockRate: 90_000,
            parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1'
          })
        ]
      },
      iceServers: [],
      iceUseIpv6: false
    })
    const accessUnit = new Promise<Buffer>((resolve) => {
      const depacketizer = new H264Depacketizer()
      pc.onTrack.subscribe((track) =>
        track.onReceiveRtp.subscribe((rtp) => {
          const frame = depacketizer.push(rtp.payload, rtp.header.marker)
          if (frame) resolve(frame)
        })
      )
    })
    // The daemon closes a session that stays silent, as a browser that vanished would.
    pc.onDataChannel.subscribe((channel) => {
      const ping = setInterval(() => channel.send('ping'), 2000)
      channel.stateChanged.subscribe((state) => (state === 'closed' ? clearInterval(ping) : undefined))
    })
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      const answer = await fetch(`${base}/view/api/rtc/answer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: offer.id, sdp: pc.localDescription!.sdp })
      })
      expect(answer.status).toBe(200)
      const h264 = await Promise.race([
        accessUnit,
        sleep(30_000).then(() => {
          throw new Error(`no keyframe over WebRTC within 30 s\n--- daemon log ---\n${daemonLog}`)
        })
      ])
      // Decode it with the pinned ffmpeg the daemon installed: one real frame of the Xvfb screen.
      const ffmpeg = join(home, 'ffmpeg', readdirOne(join(home, 'ffmpeg')), 'ffmpeg')
      const probe = spawnSync(
        ffmpeg,
        ['-hide_banner', '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
        { input: h264, maxBuffer: 64 * 1024 * 1024 }
      )
      expect(probe.status, probe.stderr.toString()).toBe(0)
      expect(pngSize(probe.stdout)).toEqual(screen)
    } finally {
      await pc.close()
    }
  })
})

const readdirOne = (dir: string): string => readdirSync(dir).find((name) => !name.startsWith('.'))!

// RTP (RFC 6184) to Annex B; returns the first access unit that holds SPS, PPS and an IDR slice.
class H264Depacketizer {
  private unit: Buffer[] = []
  private fragment: Buffer[] | undefined
  private types = new Set<number>()

  push(payload: Buffer, marker: boolean): Buffer | undefined {
    const type = payload[0]! & 0x1f
    if (type === 24) {
      for (let offset = 1; offset + 2 <= payload.length;) {
        const size = payload.readUInt16BE(offset)
        this.nal(payload.subarray(offset + 2, offset + 2 + size))
        offset += 2 + size
      }
    } else if (type === 28) {
      const header = payload[1]!
      if (header & 0x80) this.fragment = [Buffer.from([(payload[0]! & 0xe0) | (header & 0x1f)])]
      this.fragment?.push(payload.subarray(2))
      if (header & 0x40 && this.fragment) {
        this.nal(Buffer.concat(this.fragment))
        this.fragment = undefined
      }
    } else {
      this.nal(payload)
    }
    if (!marker) return undefined
    const complete = this.types.has(7) && this.types.has(8) && this.types.has(5)
    const unit = Buffer.concat(this.unit)
    this.unit = []
    this.types = new Set()
    return complete ? unit : undefined
  }

  private nal(nal: Buffer): void {
    this.types.add(nal[0]! & 0x1f)
    this.unit.push(Buffer.from([0, 0, 0, 1]), nal)
  }
}
