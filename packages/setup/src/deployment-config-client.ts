/** Typed deployment mutations used by the Setup Server provider workflows. */
import {
  DeploymentConfigValuesV1Schema,
  DeploymentSecretPatchSchema,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { z } from 'zod'

export const DeploymentConfigPutSchema = z.strictObject({
  values: DeploymentConfigValuesV1Schema,
  secrets: DeploymentSecretPatchSchema.optional()
})
export type DeploymentConfigPut = z.infer<typeof DeploymentConfigPutSchema>

export interface GithubDeploymentCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKeyBase64: string
  webhookSecret?: string
}

type CurrentDeploymentConfig = { values: DeploymentConfigValuesV1 }

type LogtoValues = NonNullable<DeploymentConfigValuesV1['logto']>
type SsoConnectorValues = NonNullable<LogtoValues['ssoConnector']>

/** An SSO connector counts as a sign-in method once it has its identity provider. */
function ssoReady(logto: LogtoValues): boolean {
  const sso = logto.ssoConnector
  return Boolean(sso && (sso.oidc || sso.saml))
}

/** The connector Logto just minted, before the operator has the IdP details. */
export function logtoSsoConnectorCreatedPut(
  current: CurrentDeploymentConfig,
  created: { connectorId: string; protocol: 'oidc' | 'saml'; name: string }
): DeploymentConfigPut {
  const logto = current.values.logto
  if (!logto?.browser) throw new Error('save Logto browser configuration first')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: { ...logto, ssoConnector: { ...created, domains: [], oidc: null, saml: null } }
    },
    secrets: { 'logto.ssoConnectorClientSecret': null }
  })
}

export interface LogtoSsoConnectorSettings {
  name: string
  domains: string[]
  oidc?: { issuer: string; clientId: string; clientSecret?: string; scope: string; trustUnverifiedEmail: boolean }
  saml?: {
    metadataUrl?: string
    metadata?: string
    attributeMapping?: { id?: string; email?: string; name?: string }
  }
}

/** The IdP details for the created connector; null removes SSO sign-in. */
export function logtoSsoConnectorPut(
  current: CurrentDeploymentConfig,
  settings: LogtoSsoConnectorSettings | null
): DeploymentConfigPut {
  const logto = current.values.logto
  if (!logto?.browser) throw new Error('save Logto browser configuration first')
  if (!settings) {
    if (logto.browser.socialProviders.length === 0) throw new Error('keep at least one sign-in provider configured')
    return DeploymentConfigPutSchema.parse({
      values: { ...current.values, logto: { ...logto, ssoConnector: null } },
      secrets: { 'logto.ssoConnectorClientSecret': null }
    })
  }
  const existing = logto.ssoConnector
  if (!existing) throw new Error('create the SSO connector first')
  const { oidc, saml } = settings
  if (existing.protocol === 'oidc' ? !oidc || saml : !saml || oidc) {
    throw new Error(`this connector uses ${existing.protocol.toUpperCase()}; send its settings only`)
  }
  let next: SsoConnectorValues
  if (oidc) {
    const sameClient = existing.oidc?.issuer === oidc.issuer && existing.oidc.clientId === oidc.clientId
    if (!oidc.clientSecret && !sameClient) throw new Error('a new OIDC client requires its client secret')
    const { clientSecret: _secret, ...stored } = oidc
    next = { ...existing, name: settings.name, domains: settings.domains, oidc: stored, saml: null }
  } else {
    next = {
      ...existing,
      name: settings.name,
      domains: settings.domains,
      oidc: null,
      saml: {
        metadataUrl: saml?.metadataUrl ?? null,
        metadata: saml?.metadata ?? null,
        attributeMapping: saml?.attributeMapping ?? {}
      }
    }
  }
  return DeploymentConfigPutSchema.parse({
    values: { ...current.values, logto: { ...logto, ssoConnector: next } },
    ...(oidc?.clientSecret ? { secrets: { 'logto.ssoConnectorClientSecret': oidc.clientSecret } } : {})
  })
}

export function githubDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: GithubDeploymentCredentials,
  options: { webhookEnabled?: boolean; connectLogto?: boolean } = {}
): DeploymentConfigPut {
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  const connectLogto = options.connectLogto && current.values.logto
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      github: {
        appId,
        slug: credentials.slug,
        clientId: credentials.clientId,
        webhookEnabled: options.webhookEnabled ?? true
      },
      ...(connectLogto
        ? {
            logto: {
              ...connectLogto,
              browser: connectLogto.browser
                ? {
                    ...connectLogto.browser,
                    socialProviders: [...new Set([...connectLogto.browser.socialProviders, 'github'])]
                  }
                : connectLogto.browser,
              githubConnector: {
                appId,
                slug: credentials.slug,
                clientId: credentials.clientId
              }
            }
          }
        : {})
    },
    secrets: {
      'github.privateKeyB64': credentials.privateKeyBase64,
      ...(credentials.webhookSecret ? { 'github.webhookSecret': credentials.webhookSecret } : {}),
      'github.clientSecret': credentials.clientSecret,
      ...(connectLogto ? { 'logto.githubConnectorClientSecret': credentials.clientSecret } : {})
    }
  })
}

export interface GitlabDeploymentCredentials {
  clientId: string
  /** Omitted keeps the sealed secret; GitLab shows it only once at registration. */
  clientSecret?: string
  /** The instance base URL (§24.1); null or omitted means GitLab.com. */
  baseUrl?: string | null
}

/** Null clears the application. GitLab OAuth applications are registered by hand (§18.3). */
export function gitlabDeploymentPut(
  current: CurrentDeploymentConfig,
  application: GitlabDeploymentCredentials | null
): DeploymentConfigPut {
  if (!application && current.values.logto?.browser?.socialProviders.includes('gitlab')) {
    throw new Error('disable GitLab sign-in before clearing its OAuth application')
  }
  // A different instance is a different application, so its secret is required
  // whenever either half of the identity moves (§24.1).
  const baseUrl = application?.baseUrl ?? null
  const identityChanged =
    application !== null &&
    (current.values.gitlab?.clientId !== application.clientId || (current.values.gitlab?.baseUrl ?? null) !== baseUrl)
  if (application && !application.clientSecret && identityChanged) {
    throw new Error('the GitLab OAuth application secret is required for a new application id or instance')
  }
  const secret = application ? application.clientSecret : null
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      gitlab: application ? { clientId: application.clientId, baseUrl } : null
    },
    ...(secret === undefined ? {} : { secrets: { 'gitlab.clientSecret': secret } })
  })
}

export interface GiteaDeploymentInstance {
  /** The instance base URL (gitea-integration.md §3); null or omitted means gitea.com. */
  baseUrl?: string | null
}

export function logtoGitlabSignInPut(current: CurrentDeploymentConfig, enabled: boolean): DeploymentConfigPut {
  const logto = current.values.logto
  if (!logto?.browser || (enabled && !current.values.gitlab)) {
    throw new Error('save the GitLab application and Logto browser configuration first')
  }
  const socialProviders = enabled
    ? [...new Set([...logto.browser.socialProviders, 'gitlab'])]
    : logto.browser.socialProviders.filter((target) => target !== 'gitlab')
  if (!socialProviders.length && !ssoReady(logto)) throw new Error('keep at least one sign-in provider configured')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: { ...logto, browser: { ...logto.browser, socialProviders } }
    }
  })
}

/** Null clears the entry. Gitea registers no application, so the instance address is the whole
 *  entry and nothing here is a secret (§3). */
export function giteaDeploymentPut(
  current: CurrentDeploymentConfig,
  instance: GiteaDeploymentInstance | null
): DeploymentConfigPut {
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      gitea: instance ? { baseUrl: instance.baseUrl ?? null } : null
    }
  })
}

export interface LogtoGithubConnectorCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
}

export interface LocalAuthLogtoBootstrap {
  managementAppId?: string
  managementAppSecret?: string
  managementResource?: string
  socialProvider?: 'github' | 'google' | 'slack'
}

/** Fill the local Logto defaults without replacing existing provider state. */
export function localAuthLogtoPut(
  current: CurrentDeploymentConfig,
  bootstrap: LocalAuthLogtoBootstrap
): DeploymentConfigPut {
  const existing = current.values.logto
  const managementAppId = bootstrap.managementAppId ?? existing?.managementAppId
  if (!managementAppId) throw new Error('Logto Management API application id is required')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...existing,
        managementAppId,
        managementResource:
          bootstrap.managementResource ?? existing?.managementResource ?? 'https://default.logto.app/api',
        browser:
          existing?.browser ??
          ({
            applicationName: 'AgentConnect',
            apiResource: null,
            socialProviders: bootstrap.socialProvider ? [bootstrap.socialProvider] : []
          } as const),
        githubConnector: existing?.githubConnector ?? null,
        ...(existing?.googleConnector ? { googleConnector: existing.googleConnector } : {}),
        ...(existing?.slackConnector ? { slackConnector: existing.slackConnector } : {})
      }
    },
    ...(bootstrap.managementAppSecret
      ? { secrets: { 'logto.managementAppSecret': bootstrap.managementAppSecret } }
      : {})
  })
}

export function logtoGithubConnectorPut(
  current: CurrentDeploymentConfig,
  credentials: LogtoGithubConnectorCredentials
): DeploymentConfigPut {
  if (!current.values.logto) throw new Error('save Logto configuration before creating its GitHub connector App')
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...current.values.logto,
        browser: current.values.logto.browser
          ? {
              ...current.values.logto.browser,
              socialProviders: [...new Set([...current.values.logto.browser.socialProviders, 'github'])]
            }
          : current.values.logto.browser,
        githubConnector: {
          appId,
          slug: credentials.slug,
          clientId: credentials.clientId
        }
      }
    },
    secrets: { 'logto.githubConnectorClientSecret': credentials.clientSecret }
  })
}

export interface SlackDeploymentCredentials {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

export function slackDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: SlackDeploymentCredentials,
  connectLogto = false
): DeploymentConfigPut {
  const logto = connectLogto && current.values.logto
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      slack: {
        appId: credentials.appId,
        clientId: credentials.clientId
      },
      ...(logto
        ? {
            logto: {
              ...logto,
              browser: logto.browser
                ? {
                    ...logto.browser,
                    socialProviders: [...new Set([...logto.browser.socialProviders, 'slack'])]
                  }
                : logto.browser,
              slackConnector: {
                appId: credentials.appId,
                clientId: credentials.clientId
              }
            }
          }
        : {})
    },
    secrets: {
      'slack.clientSecret': credentials.clientSecret,
      'slack.signingSecret': credentials.signingSecret
    }
  })
}

export interface LinearDeploymentCredentials {
  clientId: string
  /** Omitted keeps the sealed secret; Linear shows each value only once. */
  clientSecret?: string
  signingSecret?: string
}

/** Null clears the application. Linear OAuth applications are registered by hand (§7.1). */
export function linearDeploymentPut(
  current: CurrentDeploymentConfig,
  application: LinearDeploymentCredentials | null
): DeploymentConfigPut {
  // A different client id is a different application, so both of its write-only
  // secrets must arrive with it — the store would otherwise keep the old app's.
  const identityChanged = application !== null && current.values.linear?.clientId !== application.clientId
  if (application && identityChanged && !(application.clientSecret && application.signingSecret)) {
    throw new Error('a new Linear application id requires both its client secret and its webhook signing secret')
  }
  const secrets = application
    ? {
        ...(application.clientSecret ? { 'linear.clientSecret': application.clientSecret } : {}),
        ...(application.signingSecret ? { 'linear.signingSecret': application.signingSecret } : {})
      }
    : { 'linear.clientSecret': null, 'linear.signingSecret': null }
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      linear: application ? { clientId: application.clientId } : null
    },
    ...(Object.keys(secrets).length > 0 ? { secrets } : {})
  })
}

export interface GoogleChatDeploymentApp {
  projectId: string
  projectNumber: string
  /** Validated key JSON; omitted keeps the sealed key, which only the same project may reuse. */
  serviceAccountKey?: string
}

/** Null clears the app. Google Chat apps are configured by hand in Google Cloud Console (google-chat-integration.md §3). */
export function googleChatDeploymentPut(
  current: CurrentDeploymentConfig,
  app: GoogleChatDeploymentApp | null
): DeploymentConfigPut {
  if (app && !app.serviceAccountKey && current.values.googleChat?.projectId !== app.projectId) {
    throw new Error('a new Google Cloud project requires its service-account key')
  }
  const secret = app ? app.serviceAccountKey : null
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      googleChat: app ? { projectId: app.projectId, projectNumber: app.projectNumber } : null
    },
    ...(secret === undefined ? {} : { secrets: { 'googleChat.serviceAccountKey': secret } })
  })
}

export interface LogtoOAuthClientCredentials {
  clientId: string
  clientSecret?: string
}

/** `teamsTenantId` is Microsoft's alone: a home tenant makes the sign-in app the Teams app too, null turns that off, omitted keeps it. */
export function logtoLoginAppPut(
  current: CurrentDeploymentConfig,
  provider: 'telegram' | 'discord' | 'azuread',
  credentials: LogtoOAuthClientCredentials | null,
  teamsTenantId?: string | null
): DeploymentConfigPut {
  const logto = current.values.logto
  if (!logto?.browser) throw new Error('save Logto browser configuration first')
  const key = `${provider}Connector` as const
  if (credentials && !credentials.clientSecret && logto[key]?.clientId !== credentials.clientId) {
    throw new Error('a new login application requires its client secret')
  }
  const socialProviders = credentials
    ? [...new Set([...logto.browser.socialProviders, provider])]
    : logto.browser.socialProviders.filter((target) => target !== provider)
  if (!credentials && socialProviders.length === 0 && !ssoReady(logto)) {
    throw new Error('keep at least one sign-in provider configured')
  }
  const secret = credentials ? credentials.clientSecret : null
  // Clearing Microsoft sign-in also stops the Teams app it is.
  const teams = provider !== 'azuread' ? undefined : credentials ? teamsTenantId : null
  // Agent bots belong to one app in one home tenant: they stay while both do, and go with either.
  const previous = current.values.msTeams
  const sameApp = Boolean(credentials) && logto[key]?.clientId === credentials?.clientId
  const agentBots = teams && sameApp && previous?.tenantId === teams.toLowerCase() ? previous.agentBots : undefined
  const dropsAgentBots = teams !== undefined && Boolean(previous?.agentBots) && !agentBots
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      ...(teams === undefined
        ? {}
        : { msTeams: teams ? { tenantId: teams, ...(agentBots ? { agentBots } : {}) } : null }),
      logto: {
        ...logto,
        browser: { ...logto.browser, socialProviders },
        [key]: credentials ? { clientId: credentials.clientId } : null
      }
    },
    ...(secret === undefined && !dropsAgentBots
      ? {}
      : {
          secrets: {
            ...(secret === undefined ? {} : { [`logto.${provider}ConnectorClientSecret`]: secret }),
            ...(dropsAgentBots ? { 'msTeams.blueprintClientSecret': null } : {})
          }
        })
  })
}

export interface MsTeamsAgentBotsInput {
  blueprintId: string
  subscriptionId: string
  resourceGroup: string
  /** Omitted keeps the stored secret, which only the same blueprint may. */
  clientSecret?: string
}

/** Null turns agent bots off and clears the blueprint's secret; they exist only beside the Teams app (teams-integration.md §8.6.3). */
export function msTeamsAgentBotsPut(
  current: CurrentDeploymentConfig,
  agentBots: MsTeamsAgentBotsInput | null
): DeploymentConfigPut {
  const teams = current.values.msTeams
  if (!teams) throw new Error('configure the Teams app before its agent bots')
  if (agentBots && !agentBots.clientSecret && teams.agentBots?.blueprintId !== agentBots.blueprintId.toLowerCase()) {
    throw new Error('a new blueprint requires its client secret')
  }
  const secret = agentBots ? agentBots.clientSecret : null
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      msTeams: {
        tenantId: teams.tenantId,
        agentBots: agentBots
          ? {
              blueprintId: agentBots.blueprintId,
              subscriptionId: agentBots.subscriptionId,
              resourceGroup: agentBots.resourceGroup
            }
          : null
      }
    },
    ...(secret === undefined ? {} : { secrets: { 'msTeams.blueprintClientSecret': secret } })
  })
}

export function logtoGoogleConnectorPut(
  current: CurrentDeploymentConfig,
  credentials: LogtoOAuthClientCredentials
): DeploymentConfigPut {
  if (!current.values.logto) throw new Error('save Logto configuration before configuring its Google connector')
  if (!credentials.clientSecret && current.values.logto.googleConnector?.clientId !== credentials.clientId) {
    throw new Error('Google OAuth client secret is required for a new client id')
  }
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...current.values.logto,
        browser: current.values.logto.browser
          ? {
              ...current.values.logto.browser,
              socialProviders: [...new Set([...current.values.logto.browser.socialProviders, 'google'])]
            }
          : current.values.logto.browser,
        googleConnector: {
          clientId: credentials.clientId
        }
      }
    },
    ...(credentials.clientSecret ? { secrets: { 'logto.googleConnectorClientSecret': credentials.clientSecret } } : {})
  })
}
