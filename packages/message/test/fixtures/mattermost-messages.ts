// Synthetic Mattermost API v4 WebSocket `posted` / `post_edited` payloads; all IDs are synthetic 26-char `[a-z0-9]` placeholders.
import type { MattermostPostedEvent } from '../../src/mattermost-message.js'
import { AGENTCONNECT_THREAD_EVENT_TYPE } from '../../src/slack-message.js'

export const SERVER_URL = 'https://mattermost.example.test'
export const BOT_USER_ID = 'mmbot000000000000000000001'
export const BOT_USERNAME = 'acbot'
export const OTHER_BOT_USER_ID = 'mmbot000000000000000000002'
export const ALICE_USER_ID = 'mmusr000000000000000000001'
export const BOB_USER_ID = 'mmusr000000000000000000002'
export const TEAM_ID = 'mmteam00000000000000000001'
export const PUBLIC_CHANNEL_ID = 'mmch0000000000000000000001'
export const PRIVATE_CHANNEL_ID = 'mmch0000000000000000000002'
export const DM_CHANNEL_ID = 'mmdm0000000000000000000001'
export const GROUP_DM_CHANNEL_ID = 'mmgm0000000000000000000001'

export const ROOT_POST_ID = 'mmpost00000000000000000001'
export const REPLY_POST_ID = 'mmpost00000000000000000002'
export const DM_POST_ID = 'mmpost00000000000000000003'
export const GROUP_DM_POST_ID = 'mmpost00000000000000000004'
export const FILE_POST_ID = 'mmpost00000000000000000005'
export const RICH_POST_ID = 'mmpost00000000000000000006'
export const BOT_POST_ID = 'mmpost00000000000000000007'

export const IMAGE_FILE_ID = 'mmfile00000000000000000001'
export const PDF_FILE_ID = 'mmfile00000000000000000002'

export const publicChannelMention: MattermostPostedEvent = {
  event: 'posted',
  seq: 10,
  data: {
    channel_display_name: 'Town Square',
    channel_name: 'town-square',
    channel_type: 'O',
    sender_name: '@alice',
    team_id: TEAM_ID,
    mentions: JSON.stringify([BOT_USER_ID]),
    post: JSON.stringify({
      id: ROOT_POST_ID,
      create_at: 1767225600123,
      update_at: 1767225600123,
      delete_at: 0,
      user_id: ALICE_USER_ID,
      channel_id: PUBLIC_CHANNEL_ID,
      root_id: '',
      message: `@${BOT_USERNAME} please summarize the incident`,
      type: '',
      props: {}
    })
  },
  broadcast: {
    channel_id: PUBLIC_CHANNEL_ID,
    team_id: TEAM_ID,
    user_id: '',
    omit_users: null
  }
}

export const privateChannelReply: MattermostPostedEvent = {
  event: 'posted',
  seq: 11,
  data: {
    channel_display_name: 'Security Ops',
    channel_name: 'security-ops',
    channel_type: 'P',
    sender_name: '@bob',
    team_id: TEAM_ID,
    post: JSON.stringify({
      id: REPLY_POST_ID,
      create_at: 1767225660000,
      update_at: 1767225660000,
      delete_at: 0,
      user_id: BOB_USER_ID,
      channel_id: PRIVATE_CHANNEL_ID,
      root_id: ROOT_POST_ID,
      message: 'follow up in the private thread',
      type: '',
      props: {}
    })
  }
}

export const directMessage: MattermostPostedEvent = {
  event: 'posted',
  seq: 12,
  data: {
    channel_type: 'D',
    sender_name: '@alice',
    post: JSON.stringify({
      id: DM_POST_ID,
      create_at: 1767225700000,
      update_at: 1767225700000,
      delete_at: 0,
      user_id: ALICE_USER_ID,
      channel_id: DM_CHANNEL_ID,
      root_id: '',
      message: 'hello in dm',
      type: '',
      props: {}
    })
  }
}

export const groupDmMentionFallback: MattermostPostedEvent = {
  event: 'posted',
  seq: 13,
  data: {
    channel_type: 'G',
    sender_name: '@bob',
    // Omit `data.mentions` to exercise `@botUsername` fallback in group DMs.
    post: JSON.stringify({
      id: GROUP_DM_POST_ID,
      create_at: 1767225760000,
      update_at: 1767225760000,
      delete_at: 0,
      user_id: BOB_USER_ID,
      channel_id: GROUP_DM_CHANNEL_ID,
      root_id: '',
      message: `Hey @AcBot, check this group chat.`,
      type: '',
      props: {}
    })
  }
}

export const postWithFiles: MattermostPostedEvent = {
  event: 'posted',
  seq: 14,
  data: {
    channel_type: 'O',
    sender_name: '@alice',
    team_id: TEAM_ID,
    mentions: JSON.stringify([BOT_USER_ID]),
    post: JSON.stringify({
      id: FILE_POST_ID,
      create_at: 1767225800000,
      user_id: ALICE_USER_ID,
      channel_id: PUBLIC_CHANNEL_ID,
      root_id: ROOT_POST_ID,
      message: `@${BOT_USERNAME} inspect these artifacts`,
      file_ids: [IMAGE_FILE_ID, PDF_FILE_ID],
      metadata: {
        files: [
          {
            id: IMAGE_FILE_ID,
            name: 'error-screenshot.png',
            extension: 'png',
            size: 4096,
            mime_type: 'image/png',
            has_preview_image: true
          },
          {
            id: PDF_FILE_ID,
            name: 'trace/report(1).pdf',
            extension: 'pdf',
            size: 16384,
            mime_type: 'application/pdf',
            has_preview_image: false
          }
        ]
      }
    })
  }
}

export const postWithRichAttachments: MattermostPostedEvent = {
  event: 'posted',
  seq: 15,
  data: {
    channel_type: 'O',
    sender_name: '@alertbot',
    team_id: TEAM_ID,
    post: JSON.stringify({
      id: RICH_POST_ID,
      create_at: 1767225860000,
      user_id: OTHER_BOT_USER_ID,
      channel_id: PUBLIC_CHANNEL_ID,
      root_id: '',
      message: '',
      props: {
        from_bot: 'true',
        attachments: [
          {
            pretext: 'Deployment Alert',
            author_name: 'Release Bot',
            title: 'api-server v2.1.0 failed',
            title_link: 'https://deploy.example.test/runs/42',
            text: `Paging @${BOT_USERNAME} to triage`,
            fields: [
              { title: 'Environment', value: 'staging', short: true },
              { title: 'Exit code', value: '137', short: true }
            ],
            footer: 'changelogue'
          }
        ]
      }
    })
  }
}

export const agentBotFinalEdit: MattermostPostedEvent = {
  event: 'post_edited',
  seq: 16,
  data: {
    channel_type: 'O',
    sender_name: '@peerbot',
    team_id: TEAM_ID,
    mentions: JSON.stringify([BOT_USER_ID]),
    post: JSON.stringify({
      id: BOT_POST_ID,
      create_at: 1767225900000,
      edit_at: 1767225905000,
      user_id: OTHER_BOT_USER_ID,
      channel_id: PUBLIC_CHANNEL_ID,
      root_id: ROOT_POST_ID,
      message: `@${BOT_USERNAME} please verify the rollout`,
      props: {
        from_bot: 'true',
        [AGENTCONNECT_THREAD_EVENT_TYPE]: {
          author_agent_id: 'agent-author',
          response_id: 'resp-1',
          delivery_state: 'final',
          hop_count: 1,
          mentioned_agent_ids: ['agent-reviewer'],
          addressed_anyone: true
        }
      }
    })
  }
}
