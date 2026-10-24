export const SLACK_APP_HOME_ACTION_PREFIX = 'ac_home_'

export interface SlackAppHomeContext {
  webAppUrl?: string | undefined
  orgSlug?: string | undefined
  agentId?: string | undefined
  connected?: boolean | undefined
  botId?: string | undefined
  connectUrl?: string | undefined
  /** The Slack user who installed a workspace not yet connected, the only one who can connect it. */
  installerUserId?: string | undefined
}

function homeUrls(context: SlackAppHomeContext) {
  const consoleUrl =
    context.webAppUrl && /^https?:\/\//.test(context.webAppUrl) ? context.webAppUrl.replace(/\/+$/, '') : undefined
  const orgUrl = consoleUrl && context.orgSlug ? `${consoleUrl}/${encodeURIComponent(context.orgSlug)}` : undefined
  const connectUrl = context.connectUrl?.startsWith('https://') ? context.connectUrl : undefined
  const reconnectUrl =
    orgUrl && context.botId ? `${orgUrl}/integrations?reconnect=${encodeURIComponent(context.botId)}` : consoleUrl
  return { consoleUrl, orgUrl, connectUrl, reconnectUrl }
}

/** The chat reply for an installation that cannot answer yet: one not connected to an organization, or one with no agent; undefined otherwise. */
export function slackSetupReply(context: SlackAppHomeContext): string | undefined {
  const { connectUrl, reconnectUrl } = homeUrls(context)
  if (connectUrl) {
    const who = context.installerUserId
      ? `<@${context.installerUserId}>, who installed this app,`
      : 'The person who installed this app'
    return `This workspace isn’t connected to AgentConnect yet. ${who} can connect it from the app’s Home tab or here: <${connectUrl}|Connect AgentConnect>.`
  }
  if (context.connected !== false) return undefined
  const link = reconnectUrl ? ` <${reconnectUrl}|Reconnect it in AgentConnect>.` : ' Reconnect it in AgentConnect.'
  return `No agent is connected to this app yet.${link} If you can’t, ask an organization owner or the person who set up this app.`
}

// Links use normal console authorization; the view never includes private configuration or membership.
export function buildSlackAppHomeView(botUserId: string, context: SlackAppHomeContext = {}) {
  const mention = botUserId ? `<@${botUserId}>` : 'this app'
  const { consoleUrl, orgUrl, connectUrl, reconnectUrl } = homeUrls(context)
  const disconnected = context.connected === false
  const installer = context.installerUserId ? `<@${context.installerUserId}>` : 'The person who installed this app'
  return {
    type: 'home' as const,
    blocks: [
      {
        type: 'header' as const,
        text: { type: 'plain_text' as const, text: 'Your AI agent in Slack' }
      },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: 'Work with your agent in direct messages and channel threads.'
        }
      },
      { type: 'divider' as const },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: connectUrl
            ? '*Connect your workspace*\nAgentConnect is installed in your Slack workspace. Connect it to an organization and agent to start receiving replies.'
            : disconnected
              ? '*No agent connected*\nThis app is installed in your Slack workspace, but it is not connected to an agent. Reconnect it in AgentConnect to start receiving replies.'
              : `*Get started*\n• Send this app a direct message to start a task.\n• Invite ${mention} to a channel, then @mention it with your task.\n• Reply in the same thread to continue the conversation.`
        }
      },
      { type: 'divider' as const },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: connectUrl
            ? `*Finish setup*\n${installer} can sign in to AgentConnect, choose an organization and agent, and connect this workspace.`
            : disconnected
              ? '*Reconnect your agent*\nReconnect this Slack app in the AgentConnect console. If you do not have access, ask an organization owner or the person who set up this app.'
              : '*Manage your agents*\nUse the AgentConnect console to set up agents, choose models, and connect tools. For access or help completing setup, contact the person who connected this app.'
        }
      },
      ...(consoleUrl
        ? [
            {
              type: 'actions' as const,
              elements: [
                {
                  type: 'button' as const,
                  action_id: `${SLACK_APP_HOME_ACTION_PREFIX}console`,
                  text: {
                    type: 'plain_text' as const,
                    text: connectUrl ? 'Connect AgentConnect' : orgUrl ? 'Open organization' : 'Open AgentConnect'
                  },
                  url: connectUrl ?? (orgUrl ? `${orgUrl}/home` : consoleUrl),
                  ...(connectUrl ? { style: 'primary' as const } : {})
                },
                ...(orgUrl
                  ? [
                      {
                        type: 'button' as const,
                        action_id: `${SLACK_APP_HOME_ACTION_PREFIX}agent`,
                        text: {
                          type: 'plain_text' as const,
                          text: disconnected ? 'Reconnect' : context.agentId ? 'Configure agent' : 'Manage agents'
                        },
                        url: disconnected
                          ? reconnectUrl!
                          : context.agentId
                            ? `${orgUrl}/agents/${encodeURIComponent(context.agentId)}?tab=config`
                            : `${orgUrl}/agents`,
                        style: 'primary' as const
                      }
                    ]
                  : [])
              ]
            }
          ]
        : []),
      { type: 'divider' as const },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '*Help & support*\n<https://www.agentconnect.md/docs/connect-automate/chat-platforms/slack|Slack guide> · <mailto:contact@agentconnect.md|Contact support>\n<https://www.agentconnect.md/privacy/|Privacy policy> · <https://www.agentconnect.md/docs/connect-automate/chat-platforms/slack#data-and-support|Data and deletion requests>'
        }
      }
    ]
  }
}
