// Prototype of artifacts.md §5.5: console on 127.0.0.1, content on <label>.localhost, one port.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(here, 'site', f))

export function startServer({ port = 0, ancestors = true } = {}) {
  const log = []
  const server = createServer((req, res) => {
    const host = (req.headers.host || '').toLowerCase()
    const url = new URL(req.url, `http://${host}`)
    const entry = {
      host,
      path: url.pathname,
      dest: req.headers['sec-fetch-dest'] || '',
      site: req.headers['sec-fetch-site'] || '',
      mode: req.headers['sec-fetch-mode'] || ''
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
      if (url.pathname === '/console.js') return send(200, 'text/javascript', read('console.js'))
      if (url.pathname === '/frameable') return send(200, 'text/html', '<p id="frameable">frameable control</p>')
      return send(404, 'text/plain', 'console 404')
    }
    if (host.startsWith('evil.localhost:')) {
      // A foreign top-level page that frames a content-domain address.
      const target = url.searchParams.get('t') || '/about.html'
      return send(
        200,
        'text/html',
        `<iframe id="x" src="http://a1r1.localhost:${server.address().port}${target}"></iframe>`
      )
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
    server.listen(port, '127.0.0.1', () => resolve({ server, log, port: server.address().port }))
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({ port: Number(process.env.PORT || 8765) })
  console.log(`console http://127.0.0.1:${port}/  content http://a1r1.localhost:${port}/__ac/shim`)
}
