// Self-contained viewer page served at /view: WebRTC video with screenshot-polling fallback, input over a DataChannel.
export const VIEWER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentConnect Desktop</title>
<style>
  :root { color-scheme: dark; font: 13px/1.4 system-ui, sans-serif; }
  body { margin: 0; background: #111; color: #ddd; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: #1c1c1c; border-bottom: 1px solid #333; flex-wrap: wrap; }
  header .grow { flex: 1; }
  button, input { font: inherit; color: inherit; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; }
  button:hover { background: #333; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.danger { background: #b91c1c; border-color: #b91c1c; color: #fff; }
  button:disabled { opacity: .4; }
  #state { font-weight: 600; }
  #state.ctl { color: #4ade80; }
  #meta { color: #888; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  #screen { position: relative; line-height: 0; }
  #screen.ctl { outline: 2px solid #4ade80; }
  video, img { max-width: 100vw; max-height: calc(100vh - 48px); display: block; }
  #surface { position: absolute; inset: 0; outline: none; }
  #screen.ctl #surface { cursor: crosshair; }
  #login { display: none; gap: 8px; }
  #error { color: #f87171; }
</style>
</head>
<body>
<header>
  <span id="state">connecting…</span>
  <span id="meta"></span>
  <span id="error"></span>
  <span class="grow"></span>
  <form id="login"><input id="token" type="password" placeholder="acd_… token" size="40"><button class="primary">Connect</button></form>
  <span id="controls" hidden>
    <button id="take" class="primary">Take control</button>
    <button id="release" class="danger" hidden>Release</button>
    <button data-keys="win" data-os="windows" title="Windows key">Win</button>
    <button data-keys="escape">Esc</button>
    <button data-keys="ctrl,shift,escape" data-os="windows" title="Task Manager">Ctrl+Shift+Esc</button>
    <input id="text" placeholder="send text (IME / paste)" size="22"><button id="send">Send</button>
  </span>
</header>
<main>
  <div id="screen"><video id="video" autoplay muted playsinline hidden></video><img id="image" alt="" hidden><div id="surface" tabindex="0"></div></div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id)
  const video = $('video'), image = $('image'), surface = $('surface'), screenBox = $('screen')
  let token = new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('acd-viewer-token') || ''
  if (location.hash) history.replaceState(null, '', location.pathname)
  let status = null, channel = null, mode = 'none', seq = 0
  const pending = new Map()

  const api = async (method, path, body) => {
    const res = await fetch(path, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    if (res.status === 401) { showLogin(); throw new Error('unauthorized') }
    return res
  }
  const showError = (message) => { $('error').textContent = message || '' }
  const showLogin = () => { $('login').style.display = 'flex'; $('controls').hidden = true; $('state').textContent = 'token required' }

  $('login').onsubmit = (event) => { event.preventDefault(); token = $('token').value.trim(); localStorage.setItem('acd-viewer-token', token); $('login').style.display = 'none'; start() }

  async function refresh() {
    try {
      const res = await api('GET', '/view/api/status')
      status = await res.json()
      const ctl = status.inControl
      $('state').textContent = ctl ? 'You are in control — agents are blocked' : status.paused ? 'Paused: ' + status.paused.reason : status.lease ? 'Agent ' + status.lease.holder + ' is working' : 'Watching (agents allowed)'
      $('state').className = ctl ? 'ctl' : ''
      screenBox.className = ctl ? 'ctl' : ''
      $('take').hidden = ctl; $('release').hidden = !ctl
      $('controls').hidden = false
      for (const button of document.querySelectorAll('[data-os]')) button.hidden = button.dataset.os !== status.os
      $('meta').textContent = status.name + ' · ' + status.os + ' · ' + (mode === 'webrtc' ? 'WebRTC' : mode === 'poll' ? 'screenshots (fallback)' : '…') + (status.webrtc && status.webrtc.error ? ' · ' + status.webrtc.error : '')
    } catch (error) { if (error.message !== 'unauthorized') showError('status: ' + error.message) }
    // While on the fallback, retry WebRTC once the daemon says it can stream (e.g. its ffmpeg download finished).
    if (mode === 'poll' && status && status.webrtc.unavailable === null && Date.now() - lastRtcTry > 15000) {
      lastRtcTry = Date.now()
      startWebRtc().catch(() => undefined)
    }
  }
  let lastRtcTry = 0

  async function control(action) {
    const res = await api('POST', '/view/api/control', { action })
    const body = await res.json()
    showError(res.ok ? '' : body.message)
    await refresh()
    surface.focus()
  }
  $('take').onclick = () => control('take')
  $('release').onclick = () => control('release')

  // ---- video: WebRTC first, screenshot polling if it cannot start ----
  async function startWebRtc() {
    const offerRes = await api('POST', '/view/api/rtc/offer')
    if (!offerRes.ok) throw new Error((await offerRes.json()).message || 'webrtc unavailable')
    const offer = await offerRes.json()
    const pc = new RTCPeerConnection()
    pc.ontrack = (event) => { video.srcObject = event.streams[0] || new MediaStream([event.track]) }
    pc.ondatachannel = (event) => {
      channel = event.channel
      const ping = setInterval(() => { if (channel && channel.readyState === 'open') channel.send('ping') }, 2000)
      channel.onmessage = (message) => {
        if (message.data === 'pong') return
        const reply = JSON.parse(message.data)
        const done = pending.get(reply.seq)
        if (done) { pending.delete(reply.seq); done(reply) }
      }
      channel.onclose = () => { clearInterval(ping); channel = null }
    }
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { pc.close(); fallback('WebRTC ' + pc.connectionState) } }
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await api('POST', '/view/api/rtc/answer', { id: offer.id, sdp: pc.localDescription.sdp })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no video within 10s')), 10000)
        video.onloadeddata = () => { clearTimeout(timer); resolve() }
      })
    } catch (error) { pc.close(); throw error }
    video.hidden = false; image.hidden = true; mode = 'webrtc'; polling = false
    showError('')
    refresh()
  }

  let polling = false
  function fallback(reason) {
    if (polling) return
    polling = true; mode = 'poll'; video.hidden = true; image.hidden = false
    showError(reason ? 'WebRTC unavailable (' + reason + '), using screenshots' : '')
    refresh()
    ;(async () => {
      while (mode === 'poll') {
        if (document.hidden) { await sleep(500); continue }
        const started = performance.now()
        try {
          const res = await api('GET', '/view/api/frame')
          if (res.ok) {
            const url = URL.createObjectURL(await res.blob())
            const old = image.src
            image.src = url
            if (old) URL.revokeObjectURL(old)
          }
        } catch (error) { await sleep(1000) }
        await sleep(Math.max(0, 150 - (performance.now() - started)))
      }
    })()
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // ---- input ----
  let chain = Promise.resolve()
  function send(input) {
    if (!status || !status.inControl) return Promise.resolve()
    // Ordered: each input waits for the previous one to be applied.
    chain = chain.then(() => deliver(input)).catch((error) => showError(error.message))
    return chain
  }
  async function deliver(input) {
    if (channel && channel.readyState === 'open') {
      const id = ++seq
      const reply = await new Promise((resolve) => { pending.set(id, resolve); channel.send(JSON.stringify({ seq: id, input })) })
      if (!reply.ok) { showError(reply.error); if (/take control/.test(reply.error)) refresh() } else showError('')
      return
    }
    const res = await api('POST', '/view/api/input', input)
    if (!res.ok) showError((await res.json()).message); else showError('')
  }

  const point = (event) => {
    const rect = surface.getBoundingClientRect()
    return { x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1), y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1) }
  }
  const BUTTONS = ['left', 'middle', 'right']
  const modifiers = (event) => [event.ctrlKey && 'ctrl', event.shiftKey && 'shift', event.altKey && 'alt'].filter(Boolean)

  // Hover: only the latest position is sent, and never while one is in flight.
  let moveBusy = false, moveNext = null
  function queueMove(p) {
    moveNext = p
    if (moveBusy) return
    moveBusy = true
    const target = moveNext; moveNext = null
    send({ type: 'move', ...target }).finally(() => { moveBusy = false; if (moveNext) queueMove(moveNext) })
  }

  let down = null, lastClick = null, clickTimer = null
  surface.addEventListener('contextmenu', (event) => event.preventDefault())
  surface.addEventListener('mousemove', (event) => { if (!down) queueMove(point(event)) })
  surface.addEventListener('mousedown', (event) => { surface.focus(); event.preventDefault(); down = { ...point(event), button: BUTTONS[event.button] || 'left', at: event.timeStamp } })
  surface.addEventListener('mouseup', (event) => {
    if (!down) return
    const start = down; down = null
    const end = point(event)
    const rect = surface.getBoundingClientRect()
    const moved = Math.hypot((end.x - start.x) * rect.width, (end.y - start.y) * rect.height)
    if (moved > 5 && start.button === 'left') return send({ type: 'drag', from: { x: start.x, y: start.y }, to: end })
    const mods = modifiers(event)
    // Two quick clicks become one double click, so the remote OS sees them as a pair despite network latency.
    if (lastClick && event.timeStamp - lastClick.at < 350 && lastClick.button === start.button) {
      clearTimeout(clickTimer); lastClick = null
      return send({ type: 'click', x: start.x, y: start.y, button: start.button, count: 2, modifiers: mods })
    }
    lastClick = { at: event.timeStamp, button: start.button }
    clickTimer = setTimeout(() => { lastClick = null; send({ type: 'click', x: start.x, y: start.y, button: start.button, modifiers: mods }) }, 300)
  })
  let wheel = 0, wheelTimer = null, wheelAt = null
  surface.addEventListener('wheel', (event) => {
    event.preventDefault()
    wheel += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : 0
    wheelAt = point(event)
    if (wheelTimer) return
    wheelTimer = setTimeout(() => {
      wheelTimer = null
      const amount = Math.min(10, Math.max(1, Math.round(Math.abs(wheel) / 60)))
      if (wheel !== 0) send({ type: 'scroll', ...wheelAt, direction: wheel > 0 ? 'down' : 'up', amount })
      wheel = 0
    }, 120)
  }, { passive: false })

  const NAMED = { Enter: 'return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'space' }
  let textBuffer = '', textTimer = null
  const flushText = () => { clearTimeout(textTimer); textTimer = null; if (textBuffer) { send({ type: 'type', text: textBuffer }); textBuffer = '' } }
  surface.addEventListener('keydown', (event) => {
    if (!status || !status.inControl || event.isComposing) return
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return
    event.preventDefault()
    // A Mac's Cmd shortcuts map to Ctrl on Windows and Linux computers.
    const meta = event.metaKey ? [status.os === 'macos' ? 'cmd' : 'ctrl'] : []
    const mods = [...new Set([...meta, ...(event.ctrlKey ? ['ctrl'] : []), ...(event.altKey ? ['alt'] : [])])]
    if (event.key.length === 1 && mods.length === 0) {
      textBuffer += event.key
      if (!textTimer) textTimer = setTimeout(flushText, 40)
      return
    }
    flushText()
    let key = NAMED[event.key] || (/^F\\d{1,2}$/.test(event.key) ? event.key.toLowerCase() : null)
    if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase()
    if (!key && /^Digit\\d$/.test(event.code)) key = event.code.slice(5)
    if (!key && event.key.length === 1) key = event.key.toLowerCase()
    if (!key) return
    const shift = event.shiftKey && (mods.length > 0 || event.key.length !== 1) ? ['shift'] : []
    send({ type: 'key', keys: [...mods, ...shift, key] })
  })
  for (const button of document.querySelectorAll('[data-keys]')) button.onclick = () => { send({ type: 'key', keys: button.dataset.keys.split(',') }); surface.focus() }
  const sendText = () => { const text = $('text').value; if (text) { send({ type: 'type', text }); $('text').value = '' } surface.focus() }
  $('send').onclick = sendText
  $('text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendText() } })

  async function start() {
    if (!token) return showLogin()
    await refresh()
    if (!status) return
    setInterval(refresh, 2000)
    lastRtcTry = Date.now()
    try { await startWebRtc() } catch (error) { fallback(error.message) }
  }
  start()
})()
</script>
</body>
</html>
`
