import { redirect } from 'next/navigation'
import SsoSignIn from '@/components/SsoSignIn'
import { resolvePublicEnv } from '@/lib/public-env'

export default async function SsoLoginPage() {
  const env = await resolvePublicEnv()
  const authOn = Boolean(
    (env.LOGTO_ENDPOINT || process.env.NEXT_PUBLIC_LOGTO_ENDPOINT) &&
    (env.LOGTO_APP_ID || process.env.NEXT_PUBLIC_LOGTO_APP_ID)
  )
  // Only organizations' own connections sign in by address; anywhere else the login page has every method.
  if (env.ORGANIZATION_SSO !== 'true' || !authOn) redirect('/login')
  return <SsoSignIn />
}
