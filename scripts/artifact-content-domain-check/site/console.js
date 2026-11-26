// The console side: embeds the shim, binds each port to the revision, answers from an in-memory manifest.
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

const MANIFEST = {
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

const params = new URLSearchParams(location.search)
const label = params.get('a') || 'a0123456789abcdef0123456789abcdefr1'
const contentOrigin = `http://${label}.localhost:${location.port}`
const log = (window.__acLog = [])
window.__acPorts = 0

const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
frame.src = `${contentOrigin}/__ac/shim`
document.body.append(frame)

const live = []
// Simulates a console that lost its ports without the shim noticing: the worker must time out and ask again.
window.__acDropPorts = () => live.splice(0).forEach((p) => p.close())

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

window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.origin !== contentOrigin) return
  const d = e.data || {}
  if (d.t === 'ready')
    frame.contentWindow.postMessage({ t: 'port', entry: params.get('p') || MANIFEST.entry }, contentOrigin, [newPort()])
  if (d.t === 'need-port') frame.contentWindow.postMessage({ t: 'port' }, contentOrigin, [newPort()])
  if (d.t === 'path' && typeof d.path === 'string' && d.path.startsWith('/') && !d.path.startsWith('/__ac/')) {
    params.set('p', d.path)
    history.replaceState(null, '', `?${params}`)
  }
  if (d.t === 'error') log.push({ error: d.message })
  if (d.t === 'unsupported') log.push({ unsupported: d.reason })
})
