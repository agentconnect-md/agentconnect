// Browser check for docs/designs/artifacts.md §5.5; usage: npm install --no-package-lock && npx playwright install && node run.mjs <chromium|firefox|webkit> [--no-partition] [--no-ancestors]
// WebKit needs Playwright's system libraries: run it in mcr.microsoft.com/playwright:v1.65.1-noble with --add-host a1r1.localhost:127.0.0.1 --add-host evil.localhost:127.0.0.1
import { chromium, firefox, webkit } from 'playwright'
import { startServer } from './server.mjs'

const name = process.argv[2] || 'chromium'
const noPartition = process.argv.includes('--no-partition')
const noAncestors = process.argv.includes('--no-ancestors')
const engine = { chromium, firefox, webkit }[name]
const results = []
// Playwright 1.65.1's default --disable-features switch, which includes ThirdPartyStoragePartitioning.
const DISABLED =
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'
const record = (id, ok, note = '') => {
  results.push({ id, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${note ? ' — ' + note : ''}`)
}
const step = async (id, fn) => {
  try {
    const r = await fn()
    record(id, r?.ok ?? true, r?.note ?? '')
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

const { server, log, port } = await startServer({ ancestors: !noAncestors })
const consoleUrl = `http://127.0.0.1:${port}/`
const content = `http://a1r1.localhost:${port}`
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

const serverHits = () => log.filter((e) => e.host.startsWith('a1r1.') && !e.path.startsWith('/__ac/'))
const nested = () =>
  page
    .frames()
    .find(
      (f) => f.url().startsWith(content) && !f.url().includes('/__ac/') && f.parentFrame()?.url().includes('/__ac/shim')
    )
const shim = () => page.frames().find((f) => f.url().startsWith(`${content}/__ac/shim`))
const waitNested = async (path, timeout = 10000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const f = nested()
    if (f && new URL(f.url()).pathname === path) {
      try {
        if (await f.evaluate(() => document.readyState === 'complete')) return f
      } catch {}
    }
    await sleep(100)
  }
  throw new Error(`nested frame never reached ${path}; at ${nested()?.url()}`)
}
const consoleLog = () => page.evaluate(() => window.__acLog)
const h = (f) => f.evaluate(() => document.getElementById('h')?.textContent)
const swInstance = (f) => f.evaluate(() => fetch('/data.json').then((r) => r.headers.get('X-AC-SW')))

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

await step('probe: what a navigation fetch event says about its initiator', async () => {
  const st = await shim().evaluate(
    () =>
      new Promise(async (res) => {
        const r = await navigator.serviceWorker.getRegistration('/')
        navigator.serviceWorker.addEventListener('message', (e) => e.data?.t === 'state' && res(e.data))
        r.active.postMessage({ t: 'debug-state' })
      })
  )
  return { ok: true, note: JSON.stringify(st.navs) }
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
  await shim().evaluate(() =>
    navigator.serviceWorker.getRegistration('/').then((r) => r.active.postMessage({ t: 'debug-forget' }))
  )
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
  const i1 = await swInstance(f)
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
  const i2 = await within(swInstance(f), 60000)
  how += `, next fetch after ${Math.round((Date.now() - t0) / 1000)} s`
  const v = await f.evaluate(() =>
    fetch('/data.json')
      .then((r) => r.json())
      .then((d) => d.value)
  )
  const portsAfter = await page.evaluate(() => window.__acPorts)
  const restarted = i1 !== i2
  // WebKit keeps a worker with live clients running, so there may be no restart to recover from.
  return {
    ok: v === 'ok' && (restarted ? portsAfter > portsBefore : name === 'webkit'),
    note: `${how}; instance ${i1} -> ${i2}; ports ${portsBefore} -> ${portsAfter}`
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
    ok: res.status() === 404 && body.includes('content 404') && partitionOk,
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
  const sawServer = log.some((e) => e.host.startsWith('a1r1.') && e.path === '/about.html')
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

console.log(JSON.stringify({ engine: name, version: browser.version(), noPartition, noAncestors, results }))
await within(browser.close(), 10000).catch(() => {})
server.closeAllConnections()
server.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
