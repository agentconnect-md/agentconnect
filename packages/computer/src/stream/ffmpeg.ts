import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { screencastTokenPath, waylandSession, writeCaptureHelper } from './wayland-capture.js'

// Pinned per-platform ffmpeg builds (GPL, with libx264); downloaded separately and sha256-checked, never bundled.
interface FfmpegBuild {
  version: string
  url: string
  sha256: string
  // Zip member holding the binary; absent for a gzip of the bare binary.
  member?: string
}
const GYAN = '9.0.2'
const STATIC = 'b6.1.1'
const FFMPEG_BUILDS: Record<string, FfmpegBuild> = {
  // gyan.dev essentials (has ddagrab); Windows on Arm runs the x64 build emulated.
  win32: {
    version: GYAN,
    url: `https://github.com/GyanD/codexffmpeg/releases/download/${GYAN}/ffmpeg-${GYAN}-essentials_build.zip`,
    member: `ffmpeg-${GYAN}-essentials_build/bin/ffmpeg.exe`,
    sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
  },
  // eugeneware/ffmpeg-static: static ffmpeg 6.0 linked only against system frameworks (has avfoundation).
  'darwin-arm64': {
    version: STATIC,
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${STATIC}/ffmpeg-darwin-arm64.gz`,
    sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa'
  },
  'darwin-x64': {
    version: STATIC,
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${STATIC}/ffmpeg-darwin-x64.gz`,
    sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106'
  },
  // Linux distros often lack libx264 (and sudo), so the static build is pinned there too.
  'linux-arm64': {
    version: STATIC,
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${STATIC}/ffmpeg-linux-arm64.gz`,
    sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0'
  },
  'linux-x64': {
    version: STATIC,
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${STATIC}/ffmpeg-linux-x64.gz`,
    sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa'
  }
}

const pinnedBuild = (): FfmpegBuild | undefined =>
  FFMPEG_BUILDS[process.platform] ?? FFMPEG_BUILDS[`${process.platform}-${process.arch}`]

export const FFMPEG_VERSION = pinnedBuild()?.version ?? 'system'

const binaryName = (): string => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

export const installedFfmpegPath = (dataDir: string): string => join(dataDir, 'ffmpeg', FFMPEG_VERSION, binaryName())

// Explicit path, then the pinned install, then whatever `ffmpeg` resolves to on PATH.
export function resolveFfmpegPath(dataDir: string, explicit?: string): string {
  if (explicit) return explicit
  const installed = installedFfmpegPath(dataDir)
  return existsSync(installed) ? installed : binaryName()
}

export function ffmpegAvailable(command: string): boolean {
  const probe = spawnSync(command, ['-hide_banner', '-version'], { stdio: 'ignore', windowsHide: true })
  return probe.status === 0
}

// Whether `run` should fetch the pinned build when no ffmpeg is found.
export const canInstallFfmpeg = (): boolean => pinnedBuild() !== undefined

export async function installFfmpeg(dataDir: string, log: (line: string) => void = console.log): Promise<string> {
  const target = installedFfmpegPath(dataDir)
  if (existsSync(target)) return target
  const build = pinnedBuild()
  if (!build) throw new Error('no pinned ffmpeg for this platform; install it with your package manager')
  log(`Downloading ${build.url} (for the WebRTC viewer)`)
  const response = await fetch(build.url)
  if (!response.ok) throw new Error(`ffmpeg download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== build.sha256) throw new Error(`checksum mismatch for ffmpeg ${build.version}: ${digest}`)

  const parent = join(dataDir, 'ffmpeg')
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.staging-'))
  try {
    const extracted = join(staging, binaryName())
    if (build.member) {
      const archivePath = join(staging, 'ffmpeg.zip')
      writeFileSync(archivePath, bytes)
      // Windows' own bsdtar reads zip; a Git-for-Windows GNU tar earlier on PATH would not.
      const tarCommand = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      const tar = spawnSync(tarCommand, ['-xf', archivePath, '-C', staging, build.member], {
        stdio: 'inherit',
        windowsHide: true
      })
      if (tar.status !== 0) throw new Error('tar failed to extract ffmpeg')
      renameSync(join(staging, ...build.member.split('/')), extracted)
    } else {
      writeFileSync(extracted, gunzipSync(bytes), { mode: 0o755 })
    }
    mkdirSync(join(parent, build.version), { recursive: true })
    renameSync(extracted, target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  log(`Installed ffmpeg ${build.version} at ${target}`)
  return target
}

export interface StreamSettings {
  fps: number
  maxWidth: number
  bitrateKbps: number
}

export interface CaptureInput {
  name: string
  args: string[]
  filters: string[]
  // A process whose stdout feeds ffmpeg's stdin (Wayland: the portal ScreenCast helper).
  producer?: { command: string; args: string[] }
}

// Capture inputs to try in order; the first that keeps running wins (ddagrab needs a GPU path that RDP sessions may lack).
export function captureInputs(fps: number, dataDir: string, frames = 0): CaptureInput[] {
  const override = process.env.AGENTCONNECT_COMPUTER_CAPTURE
  if (override) return [{ name: 'override', args: override.split(' ').filter(Boolean), filters: [] }]
  if (process.platform === 'win32') {
    return [
      {
        name: 'ddagrab',
        args: ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=1`],
        filters: ['hwdownload', 'format=bgra']
      },
      {
        name: 'gdigrab',
        args: ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', 'desktop'],
        filters: []
      }
    ]
  }
  if (process.platform === 'darwin') {
    return [
      {
        name: 'avfoundation',
        args: ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps), '-i', 'Capture screen 0:none'],
        filters: []
      }
    ]
  }
  if (waylandSession()) {
    const helper = writeCaptureHelper(dataDir)
    return [
      {
        name: 'pipewire',
        producer: {
          command: 'python3',
          args: [helper, screencastTokenPath(dataDir), String(fps), ...(frames ? [String(frames)] : [])]
        },
        args: ['-f', 'yuv4mpegpipe', '-i', 'pipe:0'],
        filters: []
      }
    ]
  }
  return [
    {
      name: 'x11grab',
      args: ['-f', 'x11grab', '-framerate', String(fps), '-i', process.env.DISPLAY ?? ':0'],
      filters: []
    }
  ]
}

// Grabs one frame with each capture input in turn; on macOS this also raises the screen-capture consent.
export function probeCapture(
  ffmpeg: string,
  fps: number,
  timeoutMs: number,
  dataDir: string
): { ok: true; input: string } | { ok: false; error: string } {
  const errors: string[] = []
  for (const input of captureInputs(fps, dataDir, 3)) {
    let stdin: Buffer | undefined
    if (input.producer) {
      const produced = spawnSync(input.producer.command, input.producer.args, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 512 * 1024 * 1024
      })
      if (produced.status !== 0 || !produced.stdout?.length) {
        const reason =
          (produced.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
            ? `no frame within ${Math.round(timeoutMs / 1000)}s (waiting for the screen-sharing dialog?)`
            : produced.stderr?.toString().trim().split('\n').at(-1) || `exit ${produced.status}`
        errors.push(`${input.name}: ${reason}`)
        continue
      }
      stdin = produced.stdout
    }
    const result = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...input.args,
        '-frames:v',
        '1',
        '-vf',
        [...input.filters, 'format=yuv420p'].join(','),
        '-f',
        'null',
        '-'
      ],
      // avfoundation ignores SIGTERM while it waits on a capture permission.
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(stdin ? { input: stdin } : {})
      }
    )
    if (result.status === 0) return { ok: true, input: input.name }
    const reason =
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
        ? `no frame within ${Math.round(timeoutMs / 1000)}s (waiting for a permission prompt?)`
        : (result.stderr ?? '').trim().split('\n').at(-1) || `exit ${result.status}`
    errors.push(`${input.name}: ${reason}`)
  }
  return { ok: false, error: errors.join('; ').slice(0, 300) }
}

// H.264 constrained baseline over RTP: what every browser decodes, no B-frames, SPS/PPS repeated on each keyframe.
export function encodeArgs(settings: StreamSettings, filters: string[], rtpPort: number): string[] {
  const scale = `scale='trunc(min(${settings.maxWidth},iw)/2)*2':-2:flags=fast_bilinear`
  return [
    '-an',
    '-vf',
    // fps= caps the rate: some inputs (avfoundation) deliver far more frames than -framerate asks for.
    [...filters, `fps=${settings.fps}`, scale, 'format=yuv420p'].join(','),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-profile:v',
    'baseline',
    '-bf',
    '0',
    '-g',
    String(settings.fps),
    '-b:v',
    `${settings.bitrateKbps}k`,
    '-maxrate',
    `${settings.bitrateKbps}k`,
    // A small VBV buffer caps keyframes (~bitrate/32 bytes) so one lost burst costs little.
    '-bufsize',
    `${Math.round(settings.bitrateKbps / 4)}k`,
    '-payload_type',
    '96',
    '-f',
    'rtp',
    // Plain udp:// bound to loopback: rtp:// would also open RTCP ports on every interface and trip the firewall.
    `udp://127.0.0.1:${rtpPort}?pkt_size=1200&localaddr=127.0.0.1&buffer_size=4194304`
  ]
}
