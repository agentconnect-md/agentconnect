import Auth from '@/components/Auth'
import { resolvePublicEnv } from '@/lib/public-env'
import { selectOfferedProviders } from '@/lib/social-login-providers'

export default async function LoginPage() {
  const env = await resolvePublicEnv()
  const sso = env.SSO_CONNECTOR_ID ? { connectorId: env.SSO_CONNECTOR_ID, name: env.SSO_NAME || 'SSO' } : undefined
  const providers = selectOfferedProviders(
    env.SOCIAL_PROVIDERS || process.env.NEXT_PUBLIC_SOCIAL_PROVIDERS,
    sso !== undefined
  )
  return <Auth providers={providers} sso={sso} />
}
