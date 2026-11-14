'use strict'
// Drives VS Code from inside: sends each of AHP_DRIVER_PROMPTS on the remote agent host, then reads the host's files through VS Code's own filesystem, reporting to AHP_DRIVER_OUT.
const crypto = require('node:crypto')
const fs = require('node:fs')
const vscode = require('vscode')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** VS Code names a remote host by its address without a `ws://` prefix, hex-encoded. */
const authorityOf = (address) => `hex-${Buffer.from(address.replace(/^ws:\/\//, '')).toString('hex')}`
/** A host-side URI as VS Code's agent-host filesystem addresses it. */
function hostUri(authority, path, meta) {
  const query = `_ah=${Buffer.from(JSON.stringify(meta)).toString('base64url')}`
  return vscode.Uri.from({ scheme: 'vscode-agent-host', authority, path, query })
}
const text = async (uri) => Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')

exports.activate = async () => {
  const out = process.env.AHP_DRIVER_OUT
  // Adding a folder restarts the extension host; the run that added it is the one that counts.
  if (!out) return
  const report = (entry) => fs.appendFileSync(out, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  const mounted = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'vscode-agent-host')
  if (mounted)
    return process.env.AHP_DRIVER_SIGN_IN ? report({ step: 'workspace', folder: mounted.uri.toString() }) : undefined
  try {
    const [host] = vscode.workspace.getConfiguration().get('chat.workspaceRemoteAgentHosts') ?? []
    if (!host) return report({ step: 'failed', reason: 'no chat.workspaceRemoteAgentHosts entry in this workspace' })
    const authority = authorityOf(host.address)
    const type = `remote-${authority}-${new URL(host.address).pathname.split('/').pop()}`
    report({ step: 'session-type', sessionType: type })
    await sleep(Number(process.env.AHP_DRIVER_SETTLE_MS ?? 8000))
    if (process.env.AHP_DRIVER_SIGN_IN) {
      // The sign-in page is a redirect back to the extension's loopback listener, so fetching it is the whole browser step.
      await vscode.commands.executeCommand('agentconnect.signIn', undefined, (url) => fetch(url))
      report({ step: 'signed-in' })
      await sleep(3000)
    }
    const resource = vscode.Uri.from({ scheme: type, path: `/untitled-${crypto.randomUUID()}` })
    await vscode.commands.executeCommand('vscode.open', resource)
    await sleep(2000)
    report({ step: 'opened' })
    for (const [index, query] of JSON.parse(process.env.AHP_DRIVER_PROMPTS ?? '["hello"]').entries()) {
      if (index > 0) await sleep(Number(process.env.AHP_DRIVER_GAP_MS ?? 6000))
      await vscode.commands.executeCommand('workbench.action.chat.open', { query })
      report({ step: 'submitted', index })
    }
    report({ step: 'done' })
    if (process.env.AHP_DRIVER_SIGN_IN) {
      // The session has a workspace once its first turn has run.
      await sleep(Number(process.env.AHP_DRIVER_GAP_MS ?? 6000) + 6000)
      // Adding the folder restarts the extension host, and the next activation reports it.
      return void (await vscode.commands.executeCommand('agentconnect.openWorkspace'))
    }

    // The runner names what to read once the turns have produced it.
    const plan = process.env.AHP_DRIVER_BROWSE
    for (let waited = 0; plan && !fs.existsSync(plan) && waited < 90; waited++) await sleep(1000)
    if (!plan || !fs.existsSync(plan)) return
    const { workspace, file, contentRefs } = JSON.parse(fs.readFileSync(plan, 'utf8'))
    const at = (path) => hostUri(authority, path, { scheme: 'file' })
    const entries = await vscode.workspace.fs.readDirectory(at(workspace))
    const stat = await vscode.workspace.fs.stat(at(`${workspace}/${file}`))
    const document = await vscode.workspace.openTextDocument(at(`${workspace}/${file}`))
    await vscode.window.showTextDocument(document)
    const refs = {}
    for (const ref of contentRefs) {
      const url = new URL(ref)
      refs[ref] = await text(
        hostUri(authority, url.pathname, { scheme: 'session-db', authority: url.host, contentRef: true })
      )
    }
    report({ step: 'browsed', entries, size: stat.size, document: document.getText(), refs })
    // The runner now has the agent edit the open file; VS Code reloads it when the host reports the change.
    const opened = document.getText()
    for (let waited = 0; document.getText() === opened && waited < 40; waited++) await sleep(500)
    report({ step: 'refreshed', document: document.getText() })
    // Optional, for looking at the window: the agent's workspace as a folder in the Explorer.
    if (process.env.AHP_DRIVER_MOUNT) {
      const count = vscode.workspace.workspaceFolders?.length ?? 0
      const mounted = vscode.workspace.updateWorkspaceFolders(count, 0, { uri: at(workspace), name: 'Agent workspace' })
      report({ step: 'mounted', mounted })
    }
  } catch (error) {
    report({ step: 'error', message: String(error?.stack ?? error) })
  }
}
