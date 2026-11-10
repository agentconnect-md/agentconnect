// Fixture websites for the form-fill image suite: plain, React 19, Vue 3, cross-origin frame, slow and self-submitting forms.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

/** What a page reported: its form state after each change, as the website's own script saw it. */
export interface Report {
  page: string
  desk: string
  values: Record<string, unknown>
}

// Every page posts its state to its own origin's /report, one after another so the last report is the latest state.
const REPORT = `<script>
const desk = new URLSearchParams(location.search).get('desk') || ''
let sent = Promise.resolve()
window.report = (page, values) => {
  const body = JSON.stringify({ page, desk, values })
  sent = sent.then(() => fetch('/report', { method: 'POST', body })).catch(() => undefined)
}
</script>`

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${REPORT}</head><body>${body}</body></html>`

const vanilla = page(
  'Create account',
  `<form id="signup" onsubmit="event.preventDefault(); report('vanilla', { submitted: true })">
  <label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" maxlength="64"></label>
  <label>Full name <input name="full_name"></label>
  <label>Country <select name="country"><option value="">Choose</option><option value="DE">Germany</option><option value="JP">Japan</option></select></label>
  <label><input type="checkbox" name="terms"> I agree</label>
  <button>Create</button>
</form>
<script>
const form = document.getElementById('signup')
const state = () => ({ username: form.username.value, password: form.password.value, full_name: form.full_name.value, country: form.country.value, terms: form.terms.checked })
form.addEventListener('change', () => report('vanilla', state()))
</script>`
)

const react = page('React sign in', `<div id="root"></div><script src="/react-app.js"></script>`)

const REACT_APP = `
import { createElement as h, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [plan, setPlan] = useState('free')
  useEffect(() => { report('react', { email, password, plan }) }, [email, password, plan])
  return h('form', { onSubmit: (e) => { e.preventDefault(); report('react', { submitted: true }) } },
    h('label', null, 'Email ', h('input', { type: 'email', name: 'email', autoComplete: 'username', value: email, onChange: (e) => setEmail(e.target.value) })),
    h('label', null, 'Password ', h('input', { type: 'password', name: 'password', autoComplete: 'current-password', value: password, onChange: (e) => setPassword(e.target.value) })),
    h('label', null, 'Plan ', h('select', { name: 'plan', value: plan, onChange: (e) => setPlan(e.target.value) }, h('option', { value: 'free' }, 'Free'), h('option', { value: 'pro' }, 'Pro'))),
    h('button', { type: 'submit' }, 'Sign in'))
}
createRoot(document.getElementById('root')).render(h(App))
`

const vue = page(
  'Vue profile',
  `<div id="app"><form @submit.prevent="submitted">
  <label>First name <input name="first_name" autocomplete="given-name" v-model="first"></label>
  <label>Last name <input name="last_name" autocomplete="family-name" v-model="last"></label>
  <label>Country <select name="country" v-model="country"><option value="">-</option><option value="DE">Germany</option><option value="JP">Japan</option></select></label>
</form></div>
<script src="/vue.js"></script>
<script>
Vue.createApp({
  data: () => ({ first: '', last: '', country: '' }),
  created() { this.$watch(() => [this.first, this.last, this.country], ([first, last, country]) => report('vue', { first, last, country })) },
  methods: { submitted() { report('vue', { submitted: true }) } }
}).mount('#app')
</script>`
)

// The top page on one origin, its sign-in form in a frame from the other.
const framed = (frameOrigin: string) =>
  page(
    'Partner portal',
    `<h1>Partner portal</h1><iframe src="${frameOrigin}/login-frame.html?desk=__DESK__" width="600" height="300"></iframe>`
  )

const loginFrame = page(
  'Sign in',
  `<form id="login"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>
<script>
const form = document.getElementById('login')
form.addEventListener('change', () => report('frame', { email: form.email.value, password: form.password.value }))
</script>`
)

// A handler that blocks the page longer than the extension waits: the fill's outcome is unknown when it gives up.
const slow = page(
  'Slow',
  `<form><label>Verification code <input name="code" autocomplete="one-time-code"></label></form>
<script>
document.querySelector('input').addEventListener('input', (event) => {
  const until = Date.now() + 20000
  while (Date.now() < until) {}
  report('slow', { code: event.target.value })
})
</script>`
)

// A site that submits by itself once the code is complete.
const autoSubmit = page(
  'Confirm',
  `<form action="/done.html" method="get"><label>Code <input name="code" autocomplete="one-time-code"></label></form>
<script>
document.querySelector('input').addEventListener('input', (event) => { if (event.target.value.length === 6) event.target.form.submit() })
</script>`
)

export interface Fixtures {
  /** Origins as the container's browser reaches them. */
  origins: [string, string]
  reports: Report[]
  close(): Promise<void>
}

/** Serves the pages on two ports (two origins) of this host, reachable from containers as `host`. */
export async function startFixtures(host: string): Promise<Fixtures> {
  const require = createRequire(import.meta.url)
  const reactApp = (
    await build({
      stdin: { contents: REACT_APP, resolveDir: new URL('..', import.meta.url).pathname, loader: 'js' },
      bundle: true,
      write: false,
      format: 'iife',
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent'
    })
  ).outputFiles[0]!.text
  const vueJs = readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
  const reports: Report[] = []
  const servers: Server[] = []
  const ports: number[] = []
  const origins = () => ports.map((port) => `http://${host}:${port}`) as [string, string]
  for (let i = 0; i < 2; i++) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture')
      if (req.method === 'POST' && url.pathname === '/report') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          reports.push(JSON.parse(body) as Report)
          res.writeHead(204).end()
        })
        return
      }
      const html: Record<string, string> = {
        '/vanilla.html': vanilla,
        '/react.html': react,
        '/vue.html': vue,
        '/framed.html': framed(origins()[1]).replace('__DESK__', url.searchParams.get('desk') ?? ''),
        '/login-frame.html': loginFrame,
        '/slow.html': slow,
        '/auto-submit.html': autoSubmit,
        '/done.html': page('Done', '<p>Done</p>')
      }
      const scripts: Record<string, string> = { '/react-app.js': reactApp, '/vue.js': vueJs }
      if (html[url.pathname])
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html[url.pathname])
      if (scripts[url.pathname])
        return res.writeHead(200, { 'content-type': 'text/javascript' }).end(scripts[url.pathname])
      res.writeHead(404).end()
    })
    server.listen(0, '0.0.0.0')
    await new Promise((resolve) => server.once('listening', resolve))
    servers.push(server)
    ports.push((server.address() as AddressInfo).port)
  }
  return {
    origins: origins(),
    reports,
    close: () =>
      Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))).then(() => undefined)
  }
}
