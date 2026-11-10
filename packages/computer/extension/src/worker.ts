// The extension's service worker: connects to the desktop daemon and serves its discover and fill requests.
import { COMPUTER_FORM_FILL_ENDPOINT_KEY } from '@agentconnect.md/protocol/computer-form-fill'
import { FormFillBridge } from './bridge.js'
import { DaemonConnection, type SocketLike } from './connection.js'

// Compiled in by the bundle step: the daemon refuses a worker whose build differs from its own (§10).
declare const __AGENTCONNECT_FORM_FILL_BUILD_ID__: string

const connection = new DaemonConnection({
  bridge: new FormFillBridge(chrome),
  endpoint: async () =>
    (await chrome.storage.managed.get(COMPUTER_FORM_FILL_ENDPOINT_KEY))[COMPUTER_FORM_FILL_ENDPOINT_KEY],
  open: (url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike,
  buildId: __AGENTCONNECT_FORM_FILL_BUILD_ID__,
  version: chrome.runtime.getManifest().version,
  log: (line) => console.info(`agentconnect form fill: ${line}`)
})

// On first install the managed value can arrive after the worker starts, so a change redials.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'managed') void connection.restart()
})
// An alarm wakes a worker Chromium terminated, which then redials.
void chrome.alarms.create('agentconnect-form-fill', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void connection.ensure())
chrome.runtime.onStartup.addListener(() => void connection.ensure())
chrome.runtime.onInstalled.addListener(() => void connection.ensure())
void connection.ensure()
