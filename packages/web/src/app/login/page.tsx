import Auth from '@/components/Auth'
import { resolvePublicEnv } from '@/lib/public-env'
import { selectEnabledProviders } from '@/lib/social-login-providers'

export default async function LoginPage() {
  const env = await resolvePublicEnv()
  return <Auth providers={selectEnabledProviders(env.SOCIAL_PROVIDERS || process.env.NEXT_PUBLIC_SOCIAL_PROVIDERS)} />
}
