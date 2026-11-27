// The console side: embeds the shim, binds each port to the revision, answers from an in-memory manifest; --web runs web's port server.
const enc = (s) => new TextEncoder().encode(s)

function wav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 10) * 8000, true)
  return new Uint8Array(buf)
}

const page = (title, body) => enc(`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`)

const MAIN = {
  entry: '/index.html',
  files: {
    '/index.html': {
      type: 'text/html',
      body: page(
        'index',
        `
      <h1 id="h">index</h1>
      <a id="about" href="about.html">about</a>
      <a id="route" href="/app/settings">route</a>
      <a id="frames" href="frame-console.html">frames</a>
      <audio id="media" src="/media/tone.wav" preload="metadata"></audio>
      <script src="/assets/app.js"></script>
      <script type="module" src="./mod/main.js"></script>`
      )
    },
    '/about.html': {
      type: 'text/html',
      body: page('about', `<h1 id="h">about</h1><a id="home" href="/index.html">home</a>`)
    },
    '/frame-console.html': {
      type: 'text/html',
      body: page(
        'frames',
        `
      <iframe id="console" src="${location.origin}/"></iframe>
      <iframe id="control" src="${location.origin}/frameable"></iframe>`
      )
    },
    '/assets/app.js': {
      type: 'text/javascript',
      body: enc(`window.__classic = 'ok';
      fetch('./data.json').then(r => r.json()).then(d => { window.__data = d.value; });
      fetch('/missing.json').then(r => { window.__missing = r.status; });`)
    },
    '/mod/main.js': { type: 'text/javascript', body: enc(`import { v } from './util.js'; window.__module = v;`) },
    '/mod/util.js': { type: 'text/javascript', body: enc(`export const v = 'ok';`) },
    '/data.json': { type: 'application/json', body: enc(JSON.stringify({ value: 'ok' })) },
    '/media/tone.wav': { type: 'audio/wav', body: wav(90) }
  }
}

// Revision 2: what the hostile site in revision 1 tries to reach, by origin and over its own port.
const OTHER = {
  entry: '/index.html',
  files: {
    '/index.html': {
      type: 'text/html',
      body: page('b', `<h1 id="h">b-secret</h1><script>localStorage.setItem('b-secret', 'b-secret-value')</script>`)
    },
    '/b-secret.html': { type: 'text/html', body: page('b-secret', '<h1 id="h">b-secret</h1>') }
  }
}

// Web's port-server.ts and viewer-path.ts, bundled by server.mjs in --web mode; absent in prototype mode.
const product = window.AcProduct
const params = new URLSearchParams(location.search)
const P = product ? product.VIEWER_PATH_PARAM : 'p'
const label = params.get('a') || 'a0123456789abcdef0123456789abcdefr1'
const contentOrigin = `http://${label}.localhost:${location.port}`
const MANIFEST = label.endsWith('r2') ? OTHER : MAIN
const log = (window.__acLog = [])
window.__acPorts = 0
window.__acOpenPorts = 0
window.__acPathMsgs = 0
window.__acPathWrites = 0
// The signed-in console's bearer token, which no artifact may read.
localStorage.setItem('ac-token', '__TOKEN__')

const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')

// The hostile site joins revision 1 before the frame loads; its config names the origins it attacks.
async function start() {
  if (MANIFEST === MAIN) {
    for (const name of ['index.html', 'hostile.js', 'evil-sw.js']) {
      const type = name.endsWith('.html') ? 'text/html' : 'text/javascript'
      MAIN.files[`/hostile/${name}`] = { type, body: enc(await (await fetch(`/hostile/${name}`)).text()) }
    }
    const config = {
      console: location.origin,
      cp: '__CP_ORIGIN__',
      web: '__WEB_ORIGIN__' || null,
      evil: `http://evil.localhost:${location.port}`,
      other: contentOrigin.replace(/r1\./, 'r2.')
    }
    MAIN.files['/hostile/config.json'] = { type: 'application/json', body: enc(JSON.stringify(config)) }
  }
  if (product) productConsole()
  frame.src = `${contentOrigin}/__ac/shim`
  document.body.append(frame)
}
void start()

function writePath(path) {
  window.__acPathWrites++
  if (path === null) params.delete(P)
  else params.set(P, path)
  history.replaceState(null, '', `?${params}`)
}

const live = []
// Simulates a console that lost its ports without the shim noticing: the worker must time out and ask again.
if (!product) window.__acDropPorts = () => live.splice(0).forEach((p) => p.close())

function newPort() {
  const ch = new MessageChannel()
  live.push(ch.port1)
  window.__acPorts++
  // Bound to this revision: only its manifest is answered, whatever arrives.
  ch.port1.onmessage = (e) => {
    const { id, path, navigate, range } = e.data || {}
    log.push({ path, navigate, range })
    let f = MANIFEST.files[path]
    if (!f && navigate) f = MANIFEST.files[MANIFEST.entry]
    if (!f) return ch.port1.postMessage({ id, status: 404, type: 'text/plain', body: null })
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      const size = f.body.length
      const start = m[1] ? Number(m[1]) : size - Number(m[2])
      // Open-ended ranges get at most 256 KiB, so large media streams in pieces.
      const last = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      const end = Math.min(last, start + 256 * 1024 - 1)
      const body = f.body.slice(start, end + 1).buffer
      return ch.port1.postMessage({ id, status: 206, type: f.type, body, start, end, size }, [body])
    }
    const body = f.body.slice().buffer
    ch.port1.postMessage({ id, status: 200, type: f.type, body }, [body])
  }
  return ch.port2
}

// The prototype console's own message handling; --web uses productConsole's.
window.addEventListener('message', (e) => {
  if (product || e.source !== frame.contentWindow || e.origin !== contentOrigin) return
  const d = e.data || {}
  if (d.t === 'ready')
    frame.contentWindow.postMessage({ t: 'port', entry: params.get(P) || MANIFEST.entry }, contentOrigin, [newPort()])
  if (d.t === 'need-port') frame.contentWindow.postMessage({ t: 'port' }, contentOrigin, [newPort()])
  if (d.t === 'path' && typeof d.path === 'string' && d.path.startsWith('/') && !d.path.startsWith('/__ac/')) {
    window.__acPathMsgs++
    writePath(d.path)
  }
  if (d.t === 'error') log.push({ error: d.message })
  if (d.t === 'unsupported') log.push({ unsupported: d.reason })
})

// --web: web's port server and path logic, wired as ArtifactSite.tsx wires them; channels are counted and logged, not changed.
function productConsole() {
  const { createPortServer, servedPath, readShimMessage, readViewerPath, createPathSync, MAX_OPEN_PORTS } = product
  window.__acMaxPorts = MAX_OPEN_PORTS
  const Native = window.MessageChannel
  window.MessageChannel = class extends Native {
    constructor() {
      super()
      window.__acPorts++
      window.__acOpenPorts++
      const own = this.port1
      const close = own.close.bind(own)
      let open = true
      own.close = () => {
        if (open) window.__acOpenPorts--
        open = false
        close()
      }
      own.addEventListener('message', (e) => {
        const { path, navigate, range } = e.data || {}
        log.push({ path, navigate, range })
      })
    }
  }
  const files = Object.entries(MANIFEST.files).map(([path, f]) => ({
    path: path.slice(1),
    mediaType: f.type,
    bytes: f.body.length
  }))
  const entry = MANIFEST.entry.slice(1)
  const server = createPortServer({ files, entry, load: async (f) => MANIFEST.files[`/${f.path}`].body.slice().buffer })
  // Simulates a console that lost its ports without the shim noticing: the worker must time out and ask again.
  window.__acDropPorts = () => server.close()

  const entryPath = servedPath(entry)
  const opened = readViewerPath(params.get(P)) ?? entryPath
  let current = opened
  const sync = createPathSync(writePath, opened === entryPath ? null : opened)
  const send = (message) => frame.contentWindow?.postMessage(message, contentOrigin, [server.port()])
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== contentOrigin) return
    const message = readShimMessage(event.data)
    if (!message) return
    if (message.t === 'ready') send({ t: 'port', entry: current })
    else if (message.t === 'need-port') send({ t: 'port' })
    else if (message.t === 'unsupported') log.push({ unsupported: message.reason })
    else {
      window.__acPathMsgs++
      const next = readViewerPath(message.path)
      if (next === null) return
      current = next
      sync.push(next === entryPath ? null : next)
    }
  })
}
