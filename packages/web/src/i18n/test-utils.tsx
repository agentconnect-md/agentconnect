import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import english from '../../messages/en.json'

export function IntlTestProvider({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={english} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  )
}

export function renderWithIntl(node: ReactNode): ReactNode {
  return <IntlTestProvider>{node}</IntlTestProvider>
}
