'use strict'
const vscode = require('vscode')
const ahp = require('./lib/ahp')
const oauth = require('./lib/oauth')

const PROVIDER_ID = 'agentconnect'
const SESSIONS_KEY = 'agentconnect.sessions'
const CLIENTS_KEY = 'agentconnect.clients'
const HOST_SETTINGS = ['chat.remoteAgentHosts', 'chat.workspaceRemoteAgentHosts']
const REFRESH_BEFORE_MS = 5 * 60_000

const sameServer = (a, b) => String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '')
const agentLabel = (resource) => `AgentConnect agent ${new URL(resource).pathname.split('/').pop().slice(0, 8)}`

/** Agent hosts the user configured, each with the address as written, which is what VS Code derives its authority from. */
function configuredHosts() {
  const hosts = new Map()
  for (const setting of HOST_SETTINGS)
    for (const entry of vscode.workspace.getConfiguration().get(setting) ?? []) {
      const endpoint = oauth.agentEndpoint(entry?.address ?? '')
      if (endpoint && !hosts.has(endpoint)) hosts.set(endpoint, { endpoint, address: entry.address, name: entry.name })
    }
  return [...hosts.values()]
}
const configuredEndpoints = () => configuredHosts().map((host) => host.endpoint)

function activate(context) {
  const changed = new vscode.EventEmitter()
  const log = vscode.window.createOutputChannel('AgentConnect', { log: true })
  const refreshing = new Map()
  const known = new Set()
  let registration
  let refreshTimer

  // One stored record per agent endpoint: the CP binds each grant to the resource the relay advertised.
  const load = async () => JSON.parse((await context.secrets.get(SESSIONS_KEY)) ?? '[]')
  const save = (records) => context.secrets.store(SESSIONS_KEY, JSON.stringify(records))
  const toSession = (record) => ({
    id: record.resource,
    accessToken: record.accessToken,
    account: { id: record.resource, label: agentLabel(record.resource) },
    scopes: record.scopes,
    authorizationServer: vscode.Uri.parse(record.authorizationServer)
  })

  /** VS Code only asks a provider that declares the advertised authorization server; the set only grows. */
  const register = (servers) => {
    const before = known.size
    for (const server of servers) known.add(server.replace(/\/$/, ''))
    if (registration && known.size === before) return
    registration?.dispose()
    registration = vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'AgentConnect', provider, {
      supportsMultipleAccounts: true,
      supportedAuthorizationServers: [...known].map((server) => vscode.Uri.parse(server))
    })
    log.info(`Registered for sign-in servers: ${[...known].join(' ') || '(none)'}`)
  }

  const scheduleRefresh = (records) => {
    clearTimeout(refreshTimer)
    const next = Math.min(...records.filter((record) => record.refreshToken).map((record) => record.expiresAt))
    if (!Number.isFinite(next)) return
    refreshTimer = setTimeout(
      () => void current().catch((error) => log.error(error)),
      Math.max(next - Date.now() - REFRESH_BEFORE_MS, 1000)
    )
  }

  /** Rotates one record's token; another window may have rotated it first, so the store is re-read. */
  const refreshOne = (resource) => {
    if (!refreshing.has(resource))
      refreshing.set(
        resource,
        (async () => {
          const record = (await load()).find((entry) => entry.resource === resource)
          if (!record || record.expiresAt - Date.now() > REFRESH_BEFORE_MS) return
          try {
            const metadata = await oauth.discover(record.authorizationServer)
            const tokens = await oauth.refresh({
              metadata,
              clientId: record.clientId,
              refreshToken: record.refreshToken
            })
            const updated = {
              ...record,
              ...tokens,
              refreshToken: tokens.refreshToken ?? record.refreshToken,
              scopes: record.scopes
            }
            await save((await load()).map((entry) => (entry.resource === resource ? updated : entry)))
            changed.fire({ added: [], removed: [], changed: [toSession(updated)] })
            log.info(`Refreshed the token for ${resource}`)
          } catch (error) {
            await save((await load()).filter((entry) => entry.resource !== resource))
            changed.fire({ added: [], removed: [toSession(record)], changed: [] })
            log.warn(`Signed out of ${resource}: ${error.message}`)
            void vscode.window
              .showWarningMessage(`AgentConnect sign-in expired for ${agentLabel(resource)}.`, 'Sign In')
              .then((choice) => choice && vscode.commands.executeCommand('agentconnect.signIn'))
          }
        })().finally(() => refreshing.delete(resource))
      )
    return refreshing.get(resource)
  }

  /** Stored records with any token near expiry rotated first. */
  const current = async () => {
    const due = (await load()).filter(
      (record) => record.refreshToken && record.expiresAt - Date.now() <= REFRESH_BEFORE_MS
    )
    await Promise.all(due.map((record) => refreshOne(record.resource)))
    const records = (await load()).filter((record) => record.expiresAt > Date.now())
    scheduleRefresh(records)
    return records
  }

  /** `open` shows the sign-in page; a caller in this extension host may pass its own in place of the browser. */
  const signIn = async (endpoint, open) => {
    endpoint ??= await pickEndpoint()
    if (!endpoint) return undefined
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in to AgentConnect in your browser…',
        cancellable: true
      },
      async (_progress, token) => {
        const abort = new AbortController()
        token.onCancellationRequested(() => abort.abort())
        const required = await oauth.probeProtectedResource(endpoint)
        const metadata = await oauth.discover(required.authorizationServer)
        const clients = context.globalState.get(CLIENTS_KEY) ?? {}
        const clientId = clients[required.authorizationServer] ?? (await oauth.registerClient(metadata))
        await context.globalState.update(CLIENTS_KEY, { ...clients, [required.authorizationServer]: clientId })
        const tokens = await oauth.authorize({
          metadata,
          clientId,
          resource: required.resource,
          scopes: required.scopes,
          signal: abort.signal,
          openUrl: typeof open === 'function' ? open : (url) => vscode.env.openExternal(vscode.Uri.parse(url))
        })
        const record = {
          resource: required.resource,
          authorizationServer: required.authorizationServer,
          clientId,
          ...tokens,
          scopes: tokens.scopes?.length ? tokens.scopes : required.scopes
        }
        // Newest first: VS Code takes the first session whose scopes match.
        const records = [record, ...(await load()).filter((entry) => entry.resource !== record.resource)]
        await save(records)
        register(records.map((entry) => entry.authorizationServer))
        scheduleRefresh(records)
        changed.fire({ added: [toSession(record)], removed: [], changed: [] })
        log.info(`Signed in to ${record.resource}`)
        return toSession(record)
      }
    )
  }

  const pickEndpoint = async () => {
    const endpoints = configuredEndpoints()
    if (endpoints.length === 1) return endpoints[0]
    if (endpoints.length > 1) return vscode.window.showQuickPick(endpoints, { placeHolder: 'Agent host to sign in to' })
    const typed = await vscode.window.showInputBox({
      prompt: 'AgentConnect agent endpoint (add it with "Add Remote Agent Host..." to connect)',
      placeHolder: 'wss://relay.example.test/ahp/agents/<agent-id>'
    })
    return typed ? oauth.agentEndpoint(typed.trim()) : undefined
  }

  /** Adds a session's working directory on the agent's machine to the Explorer, served by VS Code's agent-host filesystem. */
  const openWorkspace = async () => {
    const hosts = configuredHosts()
    if (!hosts.length) throw new Error('No AgentConnect agent host is configured.')
    const host =
      hosts.length === 1
        ? hosts[0]
        : (
            await vscode.window.showQuickPick(
              hosts.map((entry) => ({ label: entry.name ?? entry.endpoint, description: entry.endpoint, entry })),
              { placeHolder: 'Agent host' }
            )
          )?.entry
    if (!host) return
    // The endpoint names its own protected resource; one that advertises none takes no token.
    const required = await oauth.probeProtectedResource(host.endpoint).catch(() => undefined)
    const record = required && (await current()).find((entry) => entry.resource === required.resource)
    if (required && !record) throw new Error('Sign in to this agent first.')
    const sessions = await ahp.sessionWorkspaces({
      endpoint: host.endpoint,
      resource: record?.resource,
      token: record?.accessToken
    })
    const choices = sessions.flatMap((session) =>
      session.directories.map((directory) => ({ label: session.title, description: directory, directory }))
    )
    if (!choices.length)
      return void vscode.window.showInformationMessage(
        'No session of this agent has a workspace yet. Start a chat first.'
      )
    const choice =
      choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: 'Session' })
    if (!choice) return
    const uri = vscode.Uri.from(ahp.hostFolder(host.address, choice.directory))
    const count = vscode.workspace.workspaceFolders?.length ?? 0
    if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name: `${choice.label} (agent)` }))
      throw new Error('VS Code refused to add the folder.')
  }

  const provider = {
    onDidChangeSessions: changed.event,
    async getSessions(scopes, options) {
      const records = await current()
      return records
        .filter(
          (record) =>
            !options?.authorizationServer ||
            sameServer(options.authorizationServer.toString(true), record.authorizationServer)
        )
        .filter((record) => !options?.resource || options.resource === record.resource)
        .filter((record) => !scopes || scopes.every((scope) => record.scopes.includes(scope)))
        .map(toSession)
    },
    async createSession() {
      const session = await signIn()
      if (!session) throw new Error('Sign-in cancelled')
      return session
    },
    async removeSession(id) {
      const records = await load()
      const removed = records.find((record) => record.resource === id)
      if (!removed) return
      await save(records.filter((record) => record.resource !== id))
      changed.fire({ added: [], removed: [toSession(removed)], changed: [] })
    }
  }

  /** Learns each configured endpoint's sign-in server, so the provider is registered before VS Code asks. */
  const discoverServers = async () => {
    const stored = (await load()).map((record) => record.authorizationServer)
    register(stored)
    const probed = await Promise.allSettled(
      configuredEndpoints().map((endpoint) => oauth.probeProtectedResource(endpoint))
    )
    for (const result of probed) if (result.status === 'rejected') log.warn(result.reason.message)
    register([
      ...stored,
      ...probed.flatMap((result) => (result.status === 'fulfilled' ? [result.value.authorizationServer] : []))
    ])
  }

  const report =
    (work) =>
    async (...args) => {
      try {
        await work(...args)
      } catch (error) {
        log.error(error)
        void vscode.window.showErrorMessage(`AgentConnect: ${error.message}`)
      }
    }

  context.subscriptions.push(
    changed,
    log,
    { dispose: () => registration?.dispose() },
    { dispose: () => clearTimeout(refreshTimer) },
    vscode.commands.registerCommand(
      'agentconnect.signIn',
      report((endpoint, open) => signIn(typeof endpoint === 'string' ? endpoint : undefined, open))
    ),
    vscode.commands.registerCommand('agentconnect.openWorkspace', report(openWorkspace)),
    vscode.commands.registerCommand(
      'agentconnect.signOut',
      report(async () => {
        for (const record of await load()) await provider.removeSession(record.resource)
      })
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (HOST_SETTINGS.some((setting) => event.affectsConfiguration(setting)))
        void discoverServers().catch((error) => log.error(error))
    }),
    // Another window signed in, out, or rotated a token.
    context.secrets.onDidChange((event) => {
      if (event.key === SESSIONS_KEY)
        void load().then((records) => (register(records.map((r) => r.authorizationServer)), scheduleRefresh(records)))
    })
  )
  return discoverServers().then(() => current())
}

module.exports = { activate, deactivate() {} }
