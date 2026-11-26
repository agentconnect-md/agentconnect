// Answers the nested frame's requests by asking the console over a port; keeps no bytes.
// Pages render only inside the console's frame, whether or not the browser partitions workers.
const ANCESTORS = __ANCESTORS__
const INSTANCE = Math.random().toString(36).slice(2, 10)
const ports = new Map() // shim client id -> MessagePort
const replies = new Map() // request id -> resolve
let waiters = []
let seq = 0
const navs = [] // probe: what a navigation's fetch event says about its initiator

self.addEventListener('install', () => self.skipWaiting())

const isShim = (c) => c && new URL(c.url).pathname === '/__ac/shim' && c.frameType === 'nested'

self.addEventListener('message', (e) => {
  const src = e.source
  if (e.data?.t === 'port' && isShim(src) && e.ports[0]) {
    const port = e.ports[0]
    port.onmessage = (m) => replies.get(m.data.id)?.(m.data)
    ports.set(src.id, port)
    src.postMessage({ t: 'port-ok', instance: INSTANCE })
    const w = waiters
    waiters = []
    w.forEach((r) => r(port))
  } else if (e.data?.t === 'debug-state') {
    src.postMessage({ t: 'state', instance: INSTANCE, ports: ports.size, navs })
  } else if (e.data?.t === 'debug-forget') {
    ports.clear()
  }
})

async function getPort() {
  for (const [id, p] of ports) {
    if (await self.clients.get(id)) return p
    ports.delete(id)
  }
  // Lost every port (restart, or the console reloaded): ask each live shim for a new one.
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  const shims = all.filter(isShim)
  if (!shims.length) return null
  const got = new Promise((r) => {
    waiters.push(r)
    setTimeout(() => r(null), 5000)
  })
  shims.forEach((c) => c.postMessage({ t: 'need-port' }))
  return got
}

function ask(port, msg) {
  const id = ++seq
  return new Promise((resolve) => {
    const t = setTimeout(() => (replies.delete(id), resolve(null)), 3000)
    replies.set(id, (d) => (clearTimeout(t), replies.delete(id), resolve(d)))
    port.postMessage({ id, ...msg })
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/__ac/')) return
  // Top-level navigations are never answered: an address opened in its own tab gets the server's 404.
  if (req.mode === 'navigate' && req.destination !== 'iframe' && req.destination !== 'frame') return
  if (req.mode === 'navigate')
    navs.push({
      path: url.pathname,
      dest: req.destination,
      clientId: e.clientId || '',
      resulting: e.resultingClientId ? 'set' : '',
      replaces: e.replacesClientId ? 'set' : ''
    })
  e.respondWith(handle(e, url))
})

async function handle(e, url) {
  const req = e.request
  if (req.mode !== 'navigate') {
    const client = e.clientId ? await self.clients.get(e.clientId) : null
    if (!client || client.frameType === 'top-level') return fetch(req)
  }
  const range = req.headers.get('range')
  const msg = { path: url.pathname, navigate: req.mode === 'navigate', range }
  let port = await getPort()
  let res = port && (await ask(port, msg))
  if (!res && port) {
    // A dead port never errors; drop it and retry once with a fresh one.
    for (const [id, p] of ports) if (p === port) ports.delete(id)
    port = await getPort()
    res = port && (await ask(port, msg))
  }
  if (!res) return fetch(req)
  const headers = { 'Content-Type': res.type, 'X-AC-SW': INSTANCE, 'Accept-Ranges': 'bytes' }
  if (req.mode === 'navigate' && ANCESTORS) headers['Content-Security-Policy'] = ANCESTORS
  if (res.status === 206) headers['Content-Range'] = `bytes ${res.start}-${res.end}/${res.size}`
  return new Response(res.body, { status: res.status, headers })
}
