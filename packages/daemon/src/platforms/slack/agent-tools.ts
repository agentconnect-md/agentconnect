import { z } from 'zod'
import { createHash } from 'node:crypto'
import { SLACK_CODE_MODEL_KEY, SLACK_CODE_CONTEXT_KEY } from '@agentconnect.md/protocol'
import { parseArgs } from '../../mcp/ops/args.js'
import type { SessionContext } from '../../mcp/ops/context.js'
import { buildAttributionBlocks } from '../../slack/render.js'
import type { SlackConnection } from '../../slack/connection.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import type { PlatformSessionTools, PlatformSessionToolEnv } from '../read-ports.js'

const text = z.string().trim().min(1)
const reportArgs = z
  .object({
    title: text.max(150),
    sections: z
      .array(z.object({ title: text.max(150), text: text.max(3000), collapsed: z.boolean().optional() }))
      .max(10)
      .optional(),
    table: z
      .object({
        caption: text.max(150),
        columns: z.array(text.max(100)).min(1).max(20),
        rows: z
          .array(
            z
              .array(z.union([z.string().min(1).max(3000), z.number().finite()]))
              .min(1)
              .max(20)
          )
          .min(1)
          .max(200),
        pageSize: z.number().int().min(1).max(100).optional()
      })
      .optional()
  })
  .strict()
  .refine((a) => a.sections?.length || a.table, 'Supply at least one section or table')

// Slack's table limit includes every cell, including column headings.
export function slackReport(args: z.infer<typeof reportArgs>): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: args.title } }]
  const fallback = [args.title]
  for (const section of args.sections ?? []) {
    blocks.push({
      type: 'container',
      title: { type: 'plain_text', text: section.title },
      is_collapsible: true,
      default_collapsed: section.collapsed ?? true,
      child_blocks: [{ type: 'section', text: { type: 'mrkdwn', text: section.text } }]
    })
    fallback.push(section.title, section.text)
  }
  if (args.table) {
    const table = args.table
    if (table.rows.some((row) => row.length !== table.columns.length))
      throw new Error('Every row must match the column count')
    if ([...table.columns, ...table.rows.flat().map(String)].join('').length > 20000)
      throw new Error('Table cells must total at most 20000 characters')
    blocks.push({
      type: 'data_table',
      caption: table.caption,
      page_size: table.pageSize ?? 5,
      rows: [
        table.columns.map((value) => ({ type: 'raw_text', text: value })),
        ...table.rows.map((row) =>
          row.map((value) =>
            typeof value === 'number'
              ? { type: 'raw_number', text: String(value), value }
              : { type: 'raw_text', text: value }
          )
        )
      ]
    })
    fallback.push(table.caption, table.columns.join(' | '), ...table.rows.map((row) => row.join(' | ')))
  }
  const body = fallback.join('\n\n')
  if (body.length > 39000) throw new Error('Report is too long for one Slack message; split it into separate reports')
  return { blocks, text: body }
}

const descriptor: ToolDescriptor = {
  name: 'presentSlackReport',
  description:
    'Publish substantial findings or multi-row comparisons in this Slack conversation with native collapsible sections and a sortable, paginated data table. Choose this when the results benefit from expandable details or sorting, even if the user did not request a format. Use sections.text as Slack mrkdwn. String cells are plain text; numeric cells sort numerically. Keep short answers and small tables in ordinary replies. This posts immediately; do not repeat the report in your final reply.',
  inputSchema: z.toJSONSchema(reportArgs, { unrepresentable: 'any' }) as ToolDescriptor['inputSchema']
}

const createArgs = z.object({ name: text.max(255) }).strict()
const viewArgs = z
  .object({
    channelId: text.optional(),
    type: z.enum(['html', 'diff', 'pull_request']),
    viewKey: text.max(255).optional(),
    name: text.max(150).optional(),
    content: z.string().min(1).max(1000000).optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
    baseBranch: text.max(255).optional(),
    headBranch: text.max(255).optional()
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.type === 'pull_request' ? !a.prUrl : !a.content)
      ctx.addIssue({ code: 'custom', message: a.type === 'pull_request' ? 'prUrl is required' : 'content is required' })
    if (a.type === 'html' && !a.viewKey) ctx.addIssue({ code: 'custom', message: 'HTML needs a stable viewKey' })
    if (a.content && Buffer.byteLength(a.content) > 1000000)
      ctx.addIssue({ code: 'custom', message: 'content exceeds 1000000 UTF-8 bytes' })
  })
const manageArgs = z
  .object({
    channelId: text.optional(),
    action: z.enum(['context', 'listViews', 'removeView', 'archive']),
    items: z
      .array(
        z
          .object({
            key: text
              .max(64)
              .refine(
                (key) => key !== SLACK_CODE_MODEL_KEY && key !== SLACK_CODE_CONTEXT_KEY,
                'Reserved session control key'
              ),
            label: text.max(128),
            icon: z
              .enum([
                'branch',
                'folder',
                'hierarchy',
                'life-ring',
                'link',
                'globe',
                'terminal',
                'code',
                'search',
                'lock'
              ])
              .optional(),
            status: z
              .enum(['pending', 'passed', 'failed'])
              .optional()
              .describe(
                'Current check result; overrides icon with a monochrome status symbol. Omit when unknown or no checks exist.'
              ),
            url: z
              .url({ protocol: /^https$/ })
              .max(2048)
              .optional()
          })
          .strict()
      )
      .max(3)
      .optional(),
    viewId: text.optional(),
    summaryMessageTs: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional()
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.action === 'context' && !a.items)
      ctx.addIssue({ code: 'custom', message: 'context needs items (an empty array clears informational items)' })
    if (a.action === 'removeView' && !a.viewId) ctx.addIssue({ code: 'custom', message: 'removeView needs viewId' })
  })

const codeTools: ToolDescriptor[] = [
  {
    name: 'createSlackCodeChannel',
    description:
      'Start requested coding work needing several steps, edits, tests or a PR in a dedicated Slack channel, unless the user asks to stay here or the task needs earlier discussion that would be lost. Quick questions stay here. Slack preserves origin privacy, invites its author and copies only the originating message into the new channel. Repeating the same trigger returns the same channel; inside a code channel this reuses the current channel. After creating one, link it and end this turn without duplicating work or asking the user to repeat the task. Follow-ups there share one channel session. If creation is unavailable, use the ordinary task workflow here.',
    inputSchema: z.toJSONSchema(createArgs) as ToolDescriptor['inputSchema']
  },
  {
    name: 'setSlackCodeView',
    description:
      'Publish a PR tab when a PR opens or a self-contained HTML preview when it helps review the result. The platform maintains the task diff when automatic updates are active; do not overwrite that Code view. Otherwise this tool can publish an authorized unified diff with diff --git headers and baseBranch/headBranch labels. channelId defaults to this conversation. HTML needs a stable viewKey. Content is limited to 1000000 UTF-8 bytes. No external HTML resources are enabled.',
    inputSchema: z.toJSONSchema(viewArgs) as ToolDescriptor['inputSchema']
  },
  {
    name: 'manageSlackCodeChannel',
    description:
      'Keep a code channel oriented as you work: set its context bar when repository, branch, PR or test status becomes known, and update it as they change. context replaces informational items (max 3), preserving the platform-managed model/effort and context controls. Retain links still relevant. Use icon: branch for repositories; for PRs, set status from checks on the current head: failed if any failed, otherwise pending if any are unfinished, passed only when all checks pass. Omit status when unknown or no checks exist. Labels omit leading icons. Also list/remove view tabs or archive a completed task. channelId defaults to this conversation. Archive only when requested: post the wrap-up first and pass its ts as summaryMessageTs so Slack echoes it to the origin; an archived channel accepts no further posts, so end the turn without another reply there. Native Working, Stop and titles follow the normal turn lifecycle.',
    inputSchema: z.toJSONSchema(manageArgs) as ToolDescriptor['inputSchema']
  }
]

async function execute(
  name: string,
  ctx: SessionContext,
  args: Record<string, unknown>,
  env: PlatformSessionToolEnv
): Promise<unknown> {
  const conn = env.connection as SlackConnection
  if (name === 'createSlackCodeChannel') {
    const a = parseArgs(createArgs, args)
    const origin = env.originMsgId?.split(':')
    if (origin?.length !== 3 || origin[0] !== 'slack' || origin[1] !== ctx.channel || !/^\d+\.\d+$/.test(origin[2]!))
      throw new Error('A code channel requires a live Slack message as its origin')
    if (!ctx.isDm && (await conn.codeChannel(ctx.channel)).code)
      return { ok: true, channel_id: ctx.channel, already_exists: true }
    await env.judgeWrite({ kind: 'new', platform: ctx.platform, integrationId: ctx.integrationId, users: [] })
    const sessionId = createHash('sha256').update(`${ctx.agentId}:${env.originMsgId}`).digest('hex')
    return conn.codeChannelApi('create', {
      name: a.name,
      session_id: sessionId,
      origin_channel_id: ctx.channel,
      origin_message_ts: origin[2]!
    })
  }
  if (name === 'setSlackCodeView' || name === 'manageSlackCodeChannel') {
    const a = name === 'setSlackCodeView' ? parseArgs(viewArgs, args) : parseArgs(manageArgs, args)
    const channel = a.channelId ?? ctx.channel
    await env.judgeWrite({ kind: 'conversation', platform: ctx.platform, integrationId: ctx.integrationId, channel })
    const info = await conn.codeChannel(channel)
    if (!info.code || !info.owners.includes(conn.botUserId))
      throw new Error('This bot does not own that Slack code channel')
    if ('type' in a)
      return conn.codeChannelApi('setView', {
        channel_id: channel,
        type: a.type,
        view_key: a.viewKey,
        name: a.name,
        content: a.content,
        pr_url: a.prUrl,
        base_branch: a.baseBranch,
        head_branch: a.headBranch
      })
    if (a.action === 'context') {
      const symbols = { pending: '◷', passed: '✓', failed: '✕' }
      const updated = await conn.updateCodeContext(channel, {
        items: a.items!.map(({ status, icon, label, ...item }) => ({
          ...item,
          label: status ? `${symbols[status]} ${label}`.slice(0, 128) : label,
          ...(status ? {} : { icon: icon ?? 'link' })
        }))
      })
      if (!updated) throw new Error('This bot does not own that Slack code channel')
      return { ok: true }
    }
    if (a.action === 'archive') {
      await conn.closeCodeSession(channel)
      return conn.codeChannelApi('archive', { channel_id: channel, summary_message_ts: a.summaryMessageTs })
    }
    if (a.action === 'removeView') return conn.codeChannelApi('removeView', { channel_id: channel, view_id: a.viewId! })
    return conn.codeChannelApi('listViews', { channel_id: channel })
  }
  if (name !== descriptor.name) throw new Error(`Unknown Slack tool: ${name}`)
  const report = slackReport(parseArgs(reportArgs, args))
  await env.judgeWrite({
    kind: 'conversation',
    platform: ctx.platform,
    integrationId: ctx.integrationId,
    channel: ctx.channel
  })
  const attribution = await env.attribution?.()
  const ts = await (env.connection as SlackConnection).postBlocks(
    ctx.channel,
    [...report.blocks, ...(attribution ? buildAttributionBlocks(attribution).blocks : [])],
    report.text,
    env.deliveryThread,
    env.postIdentity()
  )
  if (!ts) throw new Error('Slack did not post the report; its originating thread may have been deleted')
  await env.recordPost(report.text, ts)
  return { channel: ctx.channel, ts }
}

export const SLACK_SESSION_TOOLS: PlatformSessionTools = {
  descriptors: [descriptor, ...codeTools],
  argSchemas: new Map<string, z.ZodType>([
    [descriptor.name, reportArgs],
    ['createSlackCodeChannel', createArgs],
    ['setSlackCodeView', viewArgs],
    ['manageSlackCodeChannel', manageArgs]
  ]),
  execute
}
