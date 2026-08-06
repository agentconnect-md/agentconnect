/** Typed deployment mutations used by the Tenant Admin provider workflows. */
import {
  DeploymentConfigValuesV1Schema,
  DeploymentSecretPatchSchema,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { z } from 'zod'
import { LOGTO_GITHUB_CONNECTOR_ID, LOGTO_GOOGLE_CONNECTOR_ID, LOGTO_SLACK_CONNECTOR_ID } from './logto-connectors.js'

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

export interface GithubConfiguredUrls {
  externalUrl: string
  setupUrl: string
  webhookUrl: string
  webhookActive: boolean
  callbackUrls: string[]
}

type CurrentDeploymentConfig = { values: DeploymentConfigValuesV1 }

export function githubDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: GithubDeploymentCredentials,
  options: { configuredUrls?: GithubConfiguredUrls; connectLogto?: boolean } = {}
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
        ...(options.configuredUrls ? { configuredUrls: options.configuredUrls } : {})
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
                connectorId: LOGTO_GITHUB_CONNECTOR_ID,
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

export interface LogtoGithubConnectorCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
}

export interface LocalAuthLogtoBootstrap {
  managementAppId?: string
  managementAppSecret?: string
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
        managementAppId,
        managementResource: existing?.managementResource ?? 'https://default.logto.app/api',
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
          connectorId: current.values.logto.githubConnector?.connectorId ?? LOGTO_GITHUB_CONNECTOR_ID,
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

export interface SlackConfiguredUrls {
  oauthRedirectUrl: string
  eventsUrl: string
  interactionsUrl: string
  loginRedirectUrl?: string
  socialLinkRedirectUrl?: string
}

export function slackDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: SlackDeploymentCredentials,
  configuredUrls?: SlackConfiguredUrls,
  connectLogto = false
): DeploymentConfigPut {
  const logto = connectLogto && current.values.logto
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      slack: {
        appId: credentials.appId,
        clientId: credentials.clientId,
        ...(configuredUrls ? { configuredUrls } : {})
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
                connectorId: logto.slackConnector?.connectorId ?? LOGTO_SLACK_CONNECTOR_ID,
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

export interface LogtoGoogleConnectorCredentials {
  connectorId?: string
  clientId: string
  clientSecret?: string
  configuredRedirectUris: string[]
}

export function logtoGoogleConnectorPut(
  current: CurrentDeploymentConfig,
  credentials: LogtoGoogleConnectorCredentials
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
          connectorId:
            credentials.connectorId ?? current.values.logto.googleConnector?.connectorId ?? LOGTO_GOOGLE_CONNECTOR_ID,
          clientId: credentials.clientId,
          configuredRedirectUris: credentials.configuredRedirectUris
        }
      }
    },
    ...(credentials.clientSecret ? { secrets: { 'logto.googleConnectorClientSecret': credentials.clientSecret } } : {})
  })
}
