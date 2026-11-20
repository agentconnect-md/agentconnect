// No 'use client' here: reached only from ModalProvider's tree and the console views, both client trees.

import { checkEmailAddressName, type EmailAddressCheckDto } from '@/lib/api'

/** The mail domain design mode shows, with no Control Plane behind it. */
export const MOCK_MAIL_DOMAIN = 'example.test'

/** Design mode's answer: every name is free, so the pane can be walked through. */
function mockCheck(name?: string): EmailAddressCheckDto {
  const named = name ? `${name.toLowerCase()}@${MOCK_MAIL_DOMAIN}` : null
  return { mailDomain: MOCK_MAIL_DOMAIN, address: named, available: named !== null, reason: null }
}

// The Email module's own CP client surface ({@link WebPlatformModule.apiBindings}).
export const emailApi = {
  check: (orgId: string, name: string | undefined, mockMode: boolean): Promise<EmailAddressCheckDto> =>
    mockMode ? Promise.resolve(mockCheck(name)) : checkEmailAddressName(orgId, name),
  /** Whether the deployment gives agents addresses at all: the same route, answering a mail domain. */
  offered: async (orgId: string): Promise<boolean> => (await checkEmailAddressName(orgId)).mailDomain !== null
}

export type EmailApi = typeof emailApi
