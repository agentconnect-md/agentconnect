export const SLACK_APP_HOME_ACTION_PREFIX = 'ac_home_'

export interface SlackAppHomeContext {
  webAppUrl?: string | undefined
  orgSlug?: string | undefined
  agentId?: string | undefined
}

// Links use normal console authorization; the view never includes private configuration or membership.
export function buildSlackAppHomeView(botUserId: string, context: SlackAppHomeContext = {}) {
  const mention = botUserId ? `<@${botUserId}>` : 'this app'
  const consoleUrl =
    context.webAppUrl && /^https?:\/\//.test(context.webAppUrl) ? context.webAppUrl.replace(/\/+$/, '') : undefined
  const orgUrl = consoleUrl && context.orgSlug ? `${consoleUrl}/${encodeURIComponent(context.orgSlug)}` : undefined
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
          text: `*Get started*\n• Send this app a direct message to start a task.\n• Invite ${mention} to a channel, then @mention it with your task.\n• Reply in the same thread to continue the conversation.`
        }
      },
      { type: 'divider' as const },
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '*Manage your agents*\nUse the AgentConnect console to set up agents, choose models, and connect tools. For access or help completing setup, contact the person who connected this app.'
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
                  text: { type: 'plain_text' as const, text: orgUrl ? 'Open organization' : 'Open AgentConnect' },
                  url: orgUrl ? `${orgUrl}/home` : consoleUrl
                },
                ...(orgUrl
                  ? [
                      {
                        type: 'button' as const,
                        action_id: `${SLACK_APP_HOME_ACTION_PREFIX}agent`,
                        text: {
                          type: 'plain_text' as const,
                          text: context.agentId ? 'Configure agent' : 'Manage agents'
                        },
                        url: context.agentId
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
