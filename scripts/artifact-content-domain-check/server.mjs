// Prototype of artifacts.md §5.5: console on 127.0.0.1, content on <label>.localhost, one port; `web` forwards content to the real web service.
import { createServer, request } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(here, 'site', f))

export const LABEL = 'a0123456789abcdef0123456789abcdefr1'
// Revision 2 of the same artifact, whose origin and manifest the hostile site must not reach.
export const OTHER_LABEL = LABEL.replace(/r1$/, 'r2')
// What a signed-in console holds; no hostile check may read any of them.
export const SECRETS = { token: 'console-token-7f3a', console: 'console-secret', cp: 'cp-secret' }

export function startServer({ port = 0, ancestors = true, web } = {}) {
  const log = []
  // A CP stand-in on its own origin: bearer auth only and CORS reflecting any origin without credentials, as the CP does.
  const cp = createServer((req, res) => {
    const auth = req.headers.authorization || ''
    log.push({ host: req.headers.host || '', path: req.url, cookie: req.headers.cookie || '', auth })
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', Vary: 'Origin' }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Headers': 'authorization' })
      return res.end()
    }
    const ok = auth === `Bearer ${SECRETS.token}`
    res.writeHead(ok ? 200 : 401, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(ok ? { secret: SECRETS.cp } : { error: 'unauthorized' }))
  })
  const server = createServer((req, res) => {
    const host = (req.headers.host || '').toLowerCase()
    const url = new URL(req.url, `http://${host}`)
    const entry = {
      host,
      path: url.pathname,
      dest: req.headers['sec-fetch-dest'] || '',
      site: req.headers['sec-fetch-site'] || '',
      mode: req.headers['sec-fetch-mode'] || '',
      cookie: req.headers.cookie || ''
    }
    log.push(entry)
    const consoleOrigin = `http://127.0.0.1:${server.address().port}`
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra })
      res.end(body)
    }
    if (host.startsWith('127.0.0.1:')) {
      // The console refuses to be framed by anything but itself.
      const noFrame = {
        'Content-Security-Policy': "frame-ancestors 'self'",
        'X-Frame-Options': 'SAMEORIGIN'
      }
      if (url.pathname === '/') return send(200, 'text/html', read('console.html'), noFrame)
      if (url.pathname === '/console.js')
        return send(
          200,
          'text/javascript',
          read('console.js')
            .toString()
            .replace('__CP_ORIGIN__', `http://127.0.0.1:${cp.address().port}`)
            .replace('__WEB_ORIGIN__', web || '')
            .replace('__TOKEN__', SECRETS.token)
        )
      // The hostile site's files, which the console puts into revision 1's manifest.
      if (/^\/hostile\/[a-z-]+\.(html|js)$/.test(url.pathname))
        return send(200, 'text/plain', read(url.pathname.slice(1)))
      // Console data a page could only read with the console's own credentials; no CORS headers.
      if (url.pathname === '/secret') return send(200, 'application/json', JSON.stringify({ secret: SECRETS.console }))
      if (url.pathname === '/frameable') return send(200, 'text/html', '<p id="frameable">frameable control</p>')
      return send(404, 'text/plain', 'console 404')
    }
    if (host.startsWith('evil.localhost:')) {
      // Where a hostile page tries to send the console tab, a popup or a form; any hit here is an escape.
      if (url.pathname !== '/') return send(200, 'text/html', '<p>escaped</p>')
      // A foreign top-level page that frames a content-domain address.
      const target = url.searchParams.get('t') || '/about.html'
      return send(
        200,
        'text/html',
        `<iframe id="x" src="http://${LABEL}.localhost:${server.address().port}${target}"></iframe>`
      )
    }
    if (web && host.endsWith(`.localhost:${server.address().port}`)) {
      // The real web service answers the content domain; Host passes through unchanged.
      const upstream = request(new URL(req.url, web), { method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers)
        up.pipe(res)
      })
      upstream.on('error', (e) => send(502, 'text/plain', String(e)))
      return req.pipe(upstream)
    }
    if (/^a[0-9a-f]+r\d+\.localhost:\d+$/.test(host)) {
      const strict = { 'Content-Security-Policy': 'frame-ancestors ' + consoleOrigin, 'Referrer-Policy': 'no-referrer' }
      if (url.pathname === '/__ac/shim') {
        const html = read('shim.html').toString().replace('__CONSOLE_ORIGIN__', consoleOrigin)
        return send(200, 'text/html', html, strict)
      }
      if (url.pathname === '/__ac/sw.js') {
        // The script lives under /__ac/, so scope / needs Service-Worker-Allowed.
        const js = read('sw.js')
          .toString()
          .replace('__ANCESTORS__', ancestors ? JSON.stringify(`frame-ancestors 'self' ${consoleOrigin}`) : 'null')
        return send(200, 'text/javascript', js, { 'Service-Worker-Allowed': '/' })
      }
      return send(404, 'text/plain', 'content 404')
    }
    return send(404, 'text/plain', 'unknown host')
  })
  return new Promise((resolve) =>
    cp.listen(0, '127.0.0.1', () =>
      server.listen(port, '127.0.0.1', () => resolve({ server, cp, log, port: server.address().port }))
    )
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({ port: Number(process.env.PORT || 8765) })
  console.log(`console http://127.0.0.1:${port}/  content http://${LABEL}.localhost:${port}/__ac/shim`)
}
