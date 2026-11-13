// @vitest-environment happy-dom

import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import english from '../../../../../messages/en.json'
import chinese from '../../../../../messages/zh-CN.json'
import { displayRow } from '@/components/console/IntegrationChannelList'
import type { IntegrationChannelRow } from '@/lib/data'
import { sessionChannelDisplay, sessionUserDisplay } from '@/lib/data'
import { platformUnnamedLabel } from '../registry'
import { useUnnamedLabel } from '../unnamed-label'
import { weComIdTag, weComUnnamedLabel } from './unnamed'

// Invented placeholder ids: a group chatid and an encrypted-form userid, both long and opaque.
const GROUP = 'wrEXAMPLEgroupEXAMPLEid0a1bAAAA'
const OTHER_GROUP = 'wrEXAMPLEgroupEXAMPLEid9z8yAAAA'
const OPAQUE_USER = 'woEXAMPLEuserEXAMPLEopaque7c3d'

describe('weComUnnamedLabel', () => {
  it('labels a group by a short tag that skips trailing padding', () => {
    expect(weComUnnamedLabel({ kind: 'room', id: GROUP })).toEqual({ key: 'wecomGroup', tag: '0a1b' })
    expect(weComUnnamedLabel({ kind: 'room', id: OTHER_GROUP })).toEqual({ key: 'wecomGroup', tag: '9z8y' })
    expect(weComUnnamedLabel({ kind: 'room', id: 'chat-example-group' })).toEqual({ key: 'wecomGroup', tag: 'roup' })
  })

  it('shows a short plaintext userid as it is and abbreviates an opaque one', () => {
    expect(weComUnnamedLabel({ kind: 'direct', id: 'dm:user-alice' })).toEqual({ text: 'user-alice' })
    expect(weComUnnamedLabel({ kind: 'person', id: 'user-alice' })).toEqual({ text: 'user-alice' })
    expect(weComUnnamedLabel({ kind: 'direct', id: `dm:${OPAQUE_USER}` })).toEqual({ key: 'wecomMember', tag: '7c3d' })
    expect(weComUnnamedLabel({ kind: 'person', id: OPAQUE_USER })).toEqual({ key: 'wecomMember', tag: '7c3d' })
  })

  it('tells a session place apart by its id alone', () => {
    expect(weComUnnamedLabel({ kind: 'place', id: GROUP })).toEqual({ key: 'wecomGroup', tag: '0a1b' })
    expect(weComUnnamedLabel({ kind: 'place', id: 'dm:user-alice' })).toEqual({ text: 'user-alice' })
  })

  it('leaves non-member authors and empty ids alone', () => {
    expect(weComUnnamedLabel({ kind: 'person', id: 'cron:schedule-example' })).toBeUndefined()
    expect(weComUnnamedLabel({ kind: 'direct', id: 'dm:' })).toBeUndefined()
  })

  it('tags an id that is all padding by its own last characters', () => {
    expect(weComIdTag('AAAA')).toBe('AAAA')
  })

  it('is reached through the registry for WeCom only', () => {
    expect(platformUnnamedLabel('wecom', { kind: 'room', id: GROUP })).toEqual({ key: 'wecomGroup', tag: '0a1b' })
    for (const platform of ['slack', 'dingtalk', 'qq', 'wechat', 'unknown'])
      expect(platformUnnamedLabel(platform, { kind: 'room', id: GROUP })).toBeUndefined()
    expect(platformUnnamedLabel(undefined, { kind: 'room', id: GROUP })).toBeUndefined()
  })
})

const row = (over: Partial<IntegrationChannelRow>): IntegrationChannelRow => ({
  channelId: GROUP,
  name: GROUP,
  trigger: 'mention',
  ...over
})

function Labels() {
  const unnamed = useUnnamedLabel()
  const labels = [
    displayRow(row({}), 'wecom', unnamed).name,
    displayRow(row({ kind: 'im', channelId: `dm:${OPAQUE_USER}`, name: `dm:${OPAQUE_USER}` }), 'wecom', unnamed).name,
    displayRow(row({ kind: 'im', channelId: 'dm:user-alice', name: 'dm:user-alice' }), 'wecom', unnamed).name,
    // A known name wins over the placeholder.
    displayRow(row({ name: 'Release team' }), 'wecom', unnamed).name,
    sessionChannelDisplay({ platform: 'wecom', channel: GROUP, channelUnnamed: true }, () => null, unnamed).label,
    sessionChannelDisplay({ platform: 'wecom', channel: 'Release team' }, () => null, unnamed).label,
    sessionUserDisplay({ platform: 'wecom', user: OPAQUE_USER, triggeredBy: OPAQUE_USER }, unnamed),
    sessionUserDisplay({ platform: 'wecom', user: 'Alice', triggeredBy: OPAQUE_USER }, unnamed),
    // Other platforms keep the raw id.
    displayRow(row({}), 'slack', unnamed).name
  ]
  return (
    <ul>
      {labels.map((label, i) => (
        <li key={i}>{label}</li>
      ))}
    </ul>
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function rendered(locale: 'en' | 'zh-CN'): string[] {
  act(() =>
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? english : chinese} timeZone="UTC">
        <Labels />
      </NextIntlClientProvider>
    )
  )
  return [...host.querySelectorAll('li')].map((li) => li.textContent ?? '')
}

describe('unnamed WeCom labels in the console', () => {
  it('prints placeholders in English', () => {
    expect(rendered('en')).toEqual([
      'WeCom group · 0a1b',
      'WeCom member · 7c3d',
      'user-alice',
      'Release team',
      'WeCom group · 0a1b',
      'Release team',
      'WeCom member · 7c3d',
      'Alice',
      GROUP
    ])
  })

  it('prints placeholders in Simplified Chinese', () => {
    expect(rendered('zh-CN').slice(0, 3)).toEqual(['企业微信群 · 0a1b', '企业微信成员 · 7c3d', 'user-alice'])
  })
})
