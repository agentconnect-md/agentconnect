import type { OutboundTextFormat } from '../ilink-options.js'

/** 将常见 Markdown 转成纯文本，同时保留适合聊天阅读的段落换行。 */
export function coercePlainMarkdown(source: string): string {
  const lines = source.split(/\r?\n/)
  const acc: string[] = []
  for (const raw of lines) {
    let line = raw.trimEnd()
    if (/^```/.test(line)) continue
    if (/^\s*```/.test(line)) continue
    line = line.replace(/^#{1,6}\s+/, '')
    line = line.replace(/^\s*>\s?/, '')
    line = line.replace(/^\s*[-*+]\s+/, '')
    line = line.replace(/^\s*\d+\.\s+/, '')
    line = line.replace(/`([^`]+)`/g, '$1')
    line = line.replace(/!\[[^\]]*]\([^)]*\)/g, '')
    line = line.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    line = line.replace(/[*_~]+/g, '')
    acc.push(line.trimEnd())
  }
  let plain = acc.join('\n').replace(/\|/g, ' ')
  plain = plain.replace(/[^\S\r\n]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  return plain.trim()
}

/** 按账号配置选择 Markdown 原样透传或兼容纯文本。 */
export function formatOutboundText(source: string, format: OutboundTextFormat = 'plain'): string {
  return format === 'markdown' ? source : coercePlainMarkdown(source)
}
