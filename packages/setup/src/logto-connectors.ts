export const LOGTO_GITHUB_CONNECTOR_ID = 'agentconnect-github'
export const LOGTO_GITLAB_CONNECTOR_ID = 'agentconnect-gitlab'
export const LOGTO_GOOGLE_CONNECTOR_ID = 'agentconnect-google'
export const LOGTO_SLACK_CONNECTOR_ID = 'agentconnect-slack'
export const LOGTO_LOGIN_APPS = {
  telegram: {
    name: 'Telegram',
    id: 'agentconnect-telegram',
    settingsUrl: 'https://t.me/BotFather',
    instruction:
      'In BotFather, select your bot and open Login Widget. Add these Allowed URLs, then copy the OIDC Client ID and Client Secret below.'
  },
  discord: {
    name: 'Discord',
    id: 'agentconnect-discord',
    settingsUrl: 'https://discord.com/developers/applications',
    instruction:
      'Create an application in the Discord Developer Portal. Under OAuth2, add these redirects and copy the Client ID and Client Secret below.'
  },
  azuread: {
    name: 'Microsoft',
    id: 'agentconnect-azuread',
    settingsUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    instruction:
      'Register a multi-tenant application in Microsoft Entra (accounts in any organizational directory). Add these as Web redirect URIs, then copy the Application (client) ID and a client secret below.'
  }
} as const
