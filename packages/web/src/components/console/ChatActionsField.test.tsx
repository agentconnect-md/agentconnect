// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, expect, it, vi } from 'vitest'
import en from '../../../messages/en.json'
import zh from '../../../messages/zh-CN.json'
import { ChatActionsField } from './ChatActionsField'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
})

async function render(locale: 'en' | 'zh-CN', onChange = vi.fn()) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : zh}>
        <ChatActionsField value="approve" onChange={onChange} />
      </NextIntlClientProvider>
    )
  )
  return onChange
}

it('offers the three levels under one title and reports the pick', async () => {
  const onChange = await render('en')
  expect(host!.querySelector('.fldlbl')?.textContent).toBe('What people can do in chat')
  const trigger = host!.querySelector<HTMLButtonElement>('button[aria-label="What people can do in chat"]')!
  expect(trigger.textContent).toBe('Talk and approve tool calls')
  await act(async () => trigger.click())
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(options.map((option) => option.textContent)).toEqual([
    'Talk to the agent',
    'Talk and approve tool calls',
    'Talk, approve and change settings'
  ])
  await act(async () => options[2]!.click())
  expect(onChange).toHaveBeenCalledWith('settings')
})

it('names the levels in Chinese', async () => {
  await render('zh-CN')
  expect(host!.querySelector('.fldlbl')?.textContent).toBe('聊天中可以做什么')
  await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="聊天中可以做什么"]')!.click())
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map((option) => option.textContent)).toEqual([
    '和 agent 对话',
    '对话并批准工具调用',
    '对话、批准并修改设置'
  ])
})
