// Browser check for docs/designs/artifacts.md §5.5; usage: npm install --no-package-lock && npx playwright install && node run.mjs <chromium|firefox|webkit> [--no-partition] [--no-ancestors] [--web, after `pnpm --filter @agentconnect.md/web build`]
// WebKit needs Playwright's system libraries: run it in mcr.microsoft.com/playwright:v1.65.1-noble with --add-host for <label>r1.localhost, <label>r2.localhost and evil.localhost, each 127.0.0.1
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'
import { LABEL, OTHER_LABEL, SECRETS, startServer } from './server.mjs'

const name = process.argv[2] || 'chromium'
const noPartition = process.argv.includes('--no-partition')
const noAncestors = process.argv.includes('--no-ancestors')
const useWeb = process.argv.includes('--web')
const engine = { chromium, firefox, webkit }[name]
const results = []
// Playwright 1.65.1's default --disable-features switch, which includes ThirdPartyStoragePartitioning.
const DISABLED =
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'
// A pending check is one whose control another PR adds; it is reported, not failed.
const record = (id, ok, note = '', pending = false) => {
  results.push({ id, ok, note, ...(pending ? { pending } : {}) })
  console.log(`${pending ? 'PEND' : ok ? 'PASS' : 'FAIL'} ${id}${note ? ' — ' + note : ''}`)
}
const step = async (id, fn) => {
  try {
    const r = await fn()
    record(id, r?.ok ?? true, r?.note ?? '', r?.pending)
  } catch (e) {
    record(id, false, String(e?.message || e).split('\n')[0])
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms = 3000) =>
  Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error('evaluate timed out')
    })
  ])

const webPort = Number(process.env.WEB_PORT || 3917)
const { server, cp, log, port } = await startServer({
  ancestors: !noAncestors,
  web: useWeb ? `http://127.0.0.1:${webPort}` : undefined
})
const consoleUrl = `http://127.0.0.1:${port}/`
const content = `http://${LABEL}.localhost:${port}`
let web
if (useWeb) {
  // The content domain is `localhost` and the console this server's origin, as web reads them from its environment.
  const cwd = fileURLToPath(new URL('../../packages/web/', import.meta.url))
  const env = { ...process.env, ARTIFACTS_CONTENT_DOMAIN: 'localhost', PUBLIC_WEB_URL: consoleUrl.slice(0, -1) }
  web = spawn('node_modules/.bin/next', ['start', '-p', String(webPort), '-H', '127.0.0.1'], {
    cwd,
    env,
    stdio: 'ignore',
    detached: true
  })
  for (let i = 0; ; i++) {
    const up = await fetch(`http://127.0.0.1:${webPort}/__ac/shim`).then(
      () => true,
      () => false
    )
    if (up) break
    if (i > 100) throw new Error('next start did not come up')
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(`web next start on ${webPort}`)
}
const launch = {}
if (name === 'chromium' && !noPartition) {
  // Playwright disables storage partitioning by default; drop that switch to match Chrome.
  launch.ignoreDefaultArgs = [DISABLED]
  launch.args = [DISABLED.replace('ThirdPartyStoragePartitioning,', '')]
}
if (name === 'firefox' && !noPartition) {
  // Playwright's Firefox ships cookieBehavior 4; Firefox's default is 5 (Total Cookie Protection).
  launch.firefoxUserPrefs = { 'network.cookie.cookieBehavior': 5 }
}
if (name === 'firefox') {
  launch.firefoxUserPrefs = {
    ...launch.firefoxUserPrefs,
    'dom.serviceWorkers.idle_timeout': 4000,
    'dom.serviceWorkers.idle_extended_timeout': 4000,
    ...(noPartition ? { 'privacy.partition.serviceWorkers': false } : {})
  }
}
const browser = await engine.launch(launch)
console.log(`engine ${name} ${browser.version()}${noPartition ? ' (partitioning off)' : ''}`)
const context = await browser.newContext()
const page = await context.newPage()
page.on('console', (m) => process.env.VERBOSE && console.log('  [console]', m.text()))

const serverHits = () => log.filter((e) => e.host.startsWith(`${LABEL}.`) && !e.path.startsWith('/__ac/'))
const nested = (p = page, origin = content) =>
  p
    .frames()
    .find(
      (f) => f.url().startsWith(origin) && !f.url().includes('/__ac/') && f.parentFrame()?.url().includes('/__ac/shim')
    )
const shim = () => page.frames().find((f) => f.url().startsWith(`${content}/__ac/shim`))
const waitNested = async (path, timeout = 10000, p = page, origin = content) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const f = nested(p, origin)
    if (f && new URL(f.url()).pathname === path) {
      try {
        if (await f.evaluate(() => document.readyState === 'complete')) return f
      } catch {}
    }
    await sleep(100)
  }
  throw new Error(`nested frame never reached ${path}; at ${nested(p, origin)?.url()}`)
}
const consoleLog = () => page.evaluate(() => window.__acLog)
const h = (f) => f.evaluate(() => document.getElementById('h')?.textContent)

await page.goto(consoleUrl)

await step('0 cross-site and secure', async () => {
  await sleep(500)
  const shimReq = log.find((e) => e.path === '/__ac/shim')
  const secure = await shim().evaluate(() => isSecureContext)
  return {
    ok: shimReq?.site === 'cross-site' && secure,
    note: `Sec-Fetch-Site=${shimReq?.site || 'none'}, isSecureContext=${secure}`
  }
})

await step('1 worker registers in the sandboxed cross-site frame', async () => {
  const f = await waitNested('/index.html')
  const state = await shim().evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => r?.active?.state))
  const controlled = await f.evaluate(() => !!navigator.serviceWorker.controller)
  return { ok: state === 'activated' && controlled, note: `active=${state}, nested controlled=${controlled}` }
})

await step('2 subresources and navigations through the worker', async () => {
  const f = await waitNested('/index.html')
  await f.waitForFunction(() => window.__classic && window.__module && window.__data && window.__missing, null, {
    timeout: 5000
  })
  await f.click('#about')
  const a = await waitNested('/about.html')
  const paths = (await consoleLog()).map((e) => e.path)
  const want = ['/index.html', '/assets/app.js', '/mod/main.js', '/mod/util.js', '/data.json', '/about.html']
  const missing = want.filter((p) => !paths.includes(p))
  const hits = serverHits().filter((e) => e.path !== '/missing.json')
  return {
    ok: (await h(a)) === 'about' && !missing.length && !hits.length,
    note: `missing via port: [${missing}], server hits: [${hits.map((e) => e.path)}]`
  }
})

await step('3 history-route fallback; 404 for a missing subresource', async () => {
  await nested().click('#home')
  const f = await waitNested('/index.html')
  const missing = await f.evaluate(() => window.__missing)
  await f.click('#route')
  const r = await waitNested('/app/settings')
  return {
    ok: (await h(r)) === 'index' && missing === 404,
    note: `/app/settings -> ${await h(r)}, /missing.json -> ${missing}`
  }
})

// The prototype shim reports on load only; the web shim also reports history changes.
if (useWeb)
  await step('3b history.pushState in the nested frame reaches the console URL', async () => {
    await nested().evaluate(() => history.pushState(null, '', '/app/pushed?tab=2'))
    await sleep(500)
    const p = new URL(page.url()).searchParams.get('p')
    return { ok: p === '/app/pushed?tab=2', note: `console p=${p}` }
  })

const go = (path) => nested().evaluate((p) => (location.href = p), path)

await step('4a console reload restores the frame through the worker', async () => {
  await go('/index.html')
  await waitNested('/index.html')
  await nested().click('#about')
  await waitNested('/about.html')
  await sleep(300)
  const before = serverHits().length
  const url = page.url()
  await page.reload()
  const f = await waitNested('/about.html')
  const ports = await page.evaluate(() => window.__acPorts)
  const newHits = serverHits()
    .slice(before)
    .filter((e) => e.path !== '/missing.json')
  return {
    ok: (await h(f)) === 'about' && !newHits.length,
    note: `console url ${new URL(url).search}, ports after reload=${ports}`
  }
})

await step('4b nested frame reload', async () => {
  const before = serverHits().length
  await nested().evaluate(() => location.reload())
  await sleep(300)
  const f = await waitNested('/about.html')
  return { ok: (await h(f)) === 'about' && serverHits().length === before }
})

await step('5a port lost without a restart (simulated)', async () => {
  const f = nested()
  await page.evaluate(() => window.__acDropPorts())
  const portsBefore = await page.evaluate(() => window.__acPorts)
  const v = await f.evaluate(() =>
    fetch('/data.json')
      .then((r) => r.json())
      .then((d) => d.value)
  )
  const portsAfter = await page.evaluate(() => window.__acPorts)
  return { ok: v === 'ok' && portsAfter === portsBefore + 1, note: `ports ${portsBefore} -> ${portsAfter}` }
})

await step('5b worker restart recovers', async () => {
  const f = nested()
  const portsBefore = await page.evaluate(() => window.__acPorts)
  let how
  if (name === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('ServiceWorker.enable')
    await cdp.send('ServiceWorker.stopAllWorkers')
    how = 'CDP ServiceWorker.stopAllWorkers'
    await sleep(500)
  } else if (name === 'firefox') {
    await sleep(9000)
    how = 'idle timeout 4 s, waited 9 s'
  } else {
    const wait = Number(process.env.IDLE_WAIT || 75000)
    await sleep(wait)
    how = `waited ${wait / 1000} s idle`
  }
  const t0 = Date.now()
  const v = await within(
    f.evaluate(() =>
      fetch('/data.json')
        .then((r) => r.json())
        .then((d) => d.value)
    ),
    60000
  )
  how += `, next fetch after ${Math.round((Date.now() - t0) / 1000)} s`
  const portsAfter = await page.evaluate(() => window.__acPorts)
  // A restarted worker holds no port, so it asks the console for one.
  const restarted = portsAfter > portsBefore
  // WebKit keeps a worker with live clients running, so there may be no restart to recover from.
  return {
    ok: v === 'ok' && (restarted ? portsAfter > portsBefore : name === 'webkit'),
    note: `${how}; ports ${portsBefore} -> ${portsAfter}`
  }
})

await step('6 Range requests for media', async () => {
  await go('/index.html')
  const f = await waitNested('/index.html')
  const r = await f.evaluate(
    () =>
      new Promise((resolve) => {
        const m = document.getElementById('media')
        const done = (ok, why) => resolve({ ok, why, d: m.duration, t: m.currentTime })
        m.addEventListener('error', () => done(false, 'error ' + m.error?.code))
        m.addEventListener(
          'loadedmetadata',
          () => {
            m.addEventListener('seeked', () => done(true, 'seeked'), { once: true })
            m.currentTime = 80
          },
          { once: true }
        )
        m.preload = 'auto'
        m.load()
        setTimeout(() => done(false, 'timeout rs=' + m.readyState), 15000)
      })
  )
  const ranges = (await consoleLog()).filter((e) => e.path === '/media/tone.wav').map((e) => e.range || 'none')
  const media = serverHits().filter((e) => e.path.startsWith('/media/'))
  return {
    ok: r.ok && Math.round(r.d) === 90 && ranges.some((x) => x !== 'none') && !media.length,
    note: `${r.why}, duration=${r.d?.toFixed?.(1)}, ranges=[${ranges.join(' ')}]`
  }
})

await step('7a content address opened in its own tab is the server 404', async () => {
  const tab = await context.newPage()
  const res = await tab.goto(`${content}/about.html`)
  const body = await tab.evaluate(() => document.body.innerText)
  const first = await context.newPage()
  await first.goto(`${content}/__ac/shim`)
  const regs = await first.evaluate(() => navigator.serviceWorker.getRegistrations().then((x) => x.length))
  // With partitioning on, the worker registered under the console is invisible to a first-party page.
  const partitionOk = noPartition || regs === 0
  return {
    ok: res.status() === 404 && body.includes(useWeb ? 'Not found' : 'content 404') && partitionOk,
    note: `status ${res.status()}; registrations visible first-party=${regs}`
  }
})

await step('7b foreign top-level framing a content address', async () => {
  // Without partitioning the console's worker would see this request; frame-ancestors still blocks it.
  const tab = await context.newPage()
  await tab.goto(`http://evil.localhost:${port}/?t=/about.html`)
  await sleep(1500)
  const fr = tab.frames().find((f) => f !== tab.mainFrame())
  let text = null
  try {
    text = await within(fr.evaluate(() => document.body?.innerText ?? ''))
  } catch (e) {
    text = 'inaccessible: ' + String(e.message).slice(0, 40)
  }
  const rendered = typeof text === 'string' && text.includes('about') && !text.includes('404')
  const sawServer = log.some((e) => e.host.startsWith(`${LABEL}.`) && e.path === '/about.html')
  return {
    ok: !rendered,
    note: `frame url=${fr?.url()}, rendered artifact=${rendered}, reached server=${sawServer}, text=${JSON.stringify(text).slice(0, 60)}`
  }
})

await step('8 artifact page cannot frame the console', async () => {
  await go('/frame-console.html')
  await waitNested('/frame-console.html')
  await sleep(1500)
  const inner = nested().childFrames()
  const res = {}
  for (const fr of inner) {
    const key = fr.url().endsWith('/frameable') ? 'control' : 'console'
    try {
      res[key] = await within(fr.evaluate(() => document.body?.innerText?.slice(0, 20) ?? ''))
    } catch (e) {
      res[key] = 'no document: ' + String(e.message).slice(0, 30)
    }
    res[key + 'Url'] = fr.url()
  }
  const consoleLoaded = typeof res.console === 'string' && res.console.startsWith('console')
  const controlLoaded = typeof res.control === 'string' && res.control.includes('frameable')
  const consoleScripts = log.filter((e) => e.host.startsWith('127.0.0.1') && e.path === '/console.js').length
  return {
    ok: !consoleLoaded && controlLoaded && consoleScripts === 2,
    note: `console.js loads=${consoleScripts} (2 = no framed copy ran); console frame: ${JSON.stringify(res.console)} @ ${res.consoleUrl}; control: ${JSON.stringify(res.control)}`
  }
})

// Hostile artifact (artifacts.md §5.5, threat_model.md): revision 1 carries site/hostile/, each check opens it in its own console tab.
const consoleOrigin = consoleUrl.slice(0, -1)
const other = `http://${OTHER_LABEL}.localhost:${port}`
const escapes = () => log.filter((e) => e.host.startsWith('evil.') && e.path !== '/')
const leaks = (value) =>
  [...Object.values(SECRETS), 'b-secret-value', '<h1 id="h">b-secret', 'pwned'].filter((s) =>
    JSON.stringify(value).includes(s)
  )
const brief = (r) => JSON.stringify(r).slice(0, 700)
let popups = 0
context.on('page', () => popups++)
try {
  await context.addCookies([
    { name: 'ac_session', value: SECRETS.console, domain: '127.0.0.1', path: '/', sameSite: 'None', secure: true }
  ])
} catch (e) {
  console.log(`  (could not seed a SameSite=None console cookie: ${String(e.message).split('\n')[0]})`)
}
const hostile = async () => {
  const tab = await context.newPage()
  tab.on('console', (m) => process.env.VERBOSE && console.log('  [hostile]', m.text()))
  await tab.goto(`${consoleUrl}?p=/hostile/index.html`)
  const f = await waitNested('/hostile/index.html', 15000, tab)
  await f.waitForFunction(() => window.attack?.ready, null, { timeout: 5000 })
  return { tab, f }
}
const attack = (f, name) =>
  within(
    f.evaluate((n) => window.attack[n](), name),
    20000
  ).catch((e) => ({ error: String(e.message).split('\n')[0] }))
const stillConsole = (tab) => new URL(tab.url()).origin === consoleOrigin
const portsOf = (tab) => tab.evaluate(() => window.__acPorts)

await step('H1 hostile page cannot navigate the console tab', async () => {
  const { tab, f } = await hostile()
  const before = escapes().length
  const r = await attack(f, 'navigateTop')
  // A real click carries user activation; the sandbox withholds allow-top-navigation-by-user-activation too.
  r['real click a[target=_top]'] = await f.click('#top-link', { timeout: 3000, noWaitAfter: true }).then(
    () => 'clicked',
    (e) => 'click failed: ' + String(e.message).split('\n')[0]
  )
  await sleep(1500)
  const hits = escapes().slice(before)
  return {
    ok: stillConsole(tab) && !hits.length && nested(tab)?.url().endsWith('/hostile/index.html'),
    note: `console tab at ${new URL(tab.url()).origin}, evil hits [${hits.map((e) => e.path)}]; ${brief(r)}`
  }
})

await step('H2 hostile page cannot open a popup', async () => {
  const { f } = await hostile()
  const [before, opened] = [escapes().length, popups]
  const r = await attack(f, 'popups')
  await f.click('#popup-btn', { timeout: 3000 })
  await f.click('#blank-link', { timeout: 3000, noWaitAfter: true })
  await sleep(1500)
  r['real click window.open'] = await f.evaluate(() => window.__popup)
  const hits = escapes().slice(before)
  return {
    ok: popups === opened && !hits.length,
    note: `new pages ${popups - opened}, evil hits [${hits.map((e) => e.path)}]; ${brief(r)}`
  }
})

await step('H3 hostile page cannot submit a form', async () => {
  const { tab, f } = await hostile()
  const before = escapes().length
  const r = await attack(f, 'forms')
  await f.click('#submit', { timeout: 3000, noWaitAfter: true })
  await sleep(1500)
  const hits = escapes().slice(before)
  return {
    ok: !hits.length && stillConsole(tab) && nested(tab)?.url().endsWith('/hostile/index.html'),
    note: `evil hits [${hits.map((e) => e.path)}]; ${brief(r)}`
  }
})

await step("H4 hostile page cannot read the console's DOM or storage", async () => {
  const { f } = await hostile()
  const r = await attack(f, 'readConsole')
  const reached = Object.entries(r).filter(([k, v]) => k.startsWith('top.') && v.startsWith('got'))
  return { ok: !reached.length && !leaks(r).length, note: brief(r) }
})

await step('H5 credentialed requests to the console and a CP origin read nothing', async () => {
  const { f } = await hostile()
  const before = log.length
  const r = await attack(f, 'credentialed')
  const sent = log.slice(before)
  const consoleCookie = sent.some((e) => e.path === '/secret' && e.cookie.includes('ac_session'))
  const cpCookie = sent.some((e) => e.path === '/api/v1/me' && e.cookie.includes('ac_session'))
  const cpAuth = sent.some((e) => e.path === '/api/v1/me' && e.auth)
  return {
    ok: !leaks(r).length && !cpAuth,
    note: `cookie reached console=${consoleCookie} cp=${cpCookie}, bearer reached cp=${cpAuth}; ${brief(r)}`
  }
})

await step("H6 hostile page cannot reach another revision's origin", async () => {
  // Revision 2 is open in its own console tab, so its worker is registered in the console's partition and its shim is live.
  const b = await context.newPage()
  await b.goto(`${consoleUrl}?a=${OTHER_LABEL}`)
  const bf = await waitNested('/index.html', 15000, b, other)
  const stored = await bf.evaluate(() => localStorage.getItem('b-secret'))
  const bAsked = (await b.evaluate(() => window.__acLog.length)) || 0
  const { tab, f } = await hostile()
  const r = await attack(f, 'frames')
  // A blocked frame may lose its name, so frames are listed, not keyed.
  const rendered = []
  for (const fr of nested(tab).childFrames()) {
    const text = await within(
      fr.evaluate(() => document.body?.innerText ?? ''),
      2000
    ).catch(() => '(no document)')
    rendered.push([fr.name(), text.slice(0, 40)])
  }
  const otherRendered = rendered.filter(([id, t]) => id !== 'webConsole' && t.includes('b-secret'))
  const servedForA = (await b.evaluate(() => window.__acLog.length)) - bAsked
  return {
    ok: stored === 'b-secret-value' && !otherRendered.length && !leaks(r).length,
    note: `revision 2's console answered ${servedForA} request(s) for those frames; frames ${JSON.stringify(rendered)}; ${brief(r)}`
  }
})

if (useWeb)
  await step("H7 web's console refuses framing by an artifact", async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/-/home`)
    const csp = res.headers.get('content-security-policy') || ''
    const xfo = res.headers.get('x-frame-options') || ''
    const guarded = /frame-ancestors/.test(csp) || /deny|sameorigin/i.test(xfo)
    const { tab, f } = await hostile()
    await attack(f, 'frames')
    const fr = nested(tab)
      .childFrames()
      .find((x) => x.name() === 'webConsole')
    const text = await within(
      fr.evaluate(() => document.body?.innerText ?? ''),
      2000
    ).catch(() => null)
    const loaded = typeof text === 'string' && text.length > 0
    // frame-ancestors on the console is 2d's; until it lands this reports what web sends today.
    return {
      ok: guarded ? !loaded : false,
      pending: !guarded,
      note: `CSP=${JSON.stringify(csp.slice(0, 60))} XFO=${JSON.stringify(xfo)}; framed console rendered=${loaded}`
    }
  })

await step('H8 spoofed shim messages from the nested frame are ignored', async () => {
  const { tab, f } = await hostile()
  await sleep(500)
  const [ports, url] = [await portsOf(tab), tab.url()]
  const r = await attack(f, 'spoof')
  const [portsAfter, urlAfter] = [await portsOf(tab), tab.url()]
  return {
    ok: portsAfter === ports && urlAfter === url && !urlAfter.includes('spoofed'),
    note: `ports ${ports} -> ${portsAfter}, console p=${new URL(urlAfter).searchParams.get('p')}; ${brief(r)}`
  }
})

await step('H9 the console answers only revision 1 manifest paths, even on a stolen port', async () => {
  const { tab, f } = await hostile()
  const r = await attack(f, 'outsideManifest')
  const fetched = Object.entries(r).filter(([k]) => k.startsWith('fetch '))
  const asked = Object.entries(r).filter(([k]) => k.startsWith('port ') && !k.includes('control'))
  const fetchOk = fetched.every(([, v]) => v.startsWith('got 404'))
  // A navigation outside the manifest gets revision 1's entry, the history-route fallback.
  const portOk = asked.every(([k, v]) =>
    k.includes('navigate') ? v.startsWith('200') && v.includes('<title>index') : v.startsWith('404')
  )
  const control = r['port /index.html (control)'] || ''
  const log1 = await tab.evaluate(() => window.__acLog.map((e) => e.path))
  return {
    ok: fetchOk && (r.stolen !== 'yes' || (portOk && control.startsWith('200'))) && !leaks(r).length,
    note: `port stolen=${r.stolen}; console was asked [${log1.filter((p) => !String(p).startsWith('/hostile/')).join(' ')}]; ${brief(r)}`
  }
})

await step('H10 hostile page cannot install another service worker', async () => {
  const { tab, f } = await hostile()
  const r = await attack(f, 'registerWorker')
  const foreign = Object.entries(r).filter(([k, v]) => k !== 'registrations' && !v.startsWith('threw'))
  const regs = (r.registrations || '').split(', ').filter(Boolean)
  const onlyShimWorker = regs.length > 0 && regs.every((x) => x.includes('/__ac/sw.js '))
  const viaPort = (await tab.evaluate(() => window.__acLog.map((e) => e.path))).includes('/hostile/evil-sw.js')
  return {
    ok: !foreign.length && onlyShimWorker && !viaPort,
    note: `evil-sw.js asked of the console=${viaPort}; ${brief(r)}`
  }
})

await step('H11 a flood of path reports and port requests stays bounded', async () => {
  const { tab, f } = await hostile()
  await sleep(500)
  const [paths, ports] = await tab.evaluate(() => [window.__acPathMsgs, window.__acPorts])
  const r = await attack(f, 'flood')
  const [pathsAfter, portsAfter] = await tab.evaluate(() => [window.__acPathMsgs, window.__acPorts])
  // The web shim coalesces reports; the prototype shim reports loads only. Port requests are the console's to bound (2d).
  return {
    ok: pathsAfter - paths <= 5 && stillConsole(tab),
    note: `path reports for a pushState burst: ${pathsAfter - paths}; ports issued for 100 need-port: ${portsAfter - ports}; console p=${new URL(tab.url()).searchParams.get('p')}; ${brief(r)}`
  }
})

console.log(JSON.stringify({ engine: name, version: browser.version(), noPartition, noAncestors, results }))
await within(browser.close(), 10000).catch(() => {})
// next start forks next-server, so the whole process group goes.
if (web) process.kill(-web.pid)
server.closeAllConnections()
server.close()
cp.closeAllConnections()
cp.close()
process.exit(results.every((r) => r.ok || r.pending) ? 0 : 1)
