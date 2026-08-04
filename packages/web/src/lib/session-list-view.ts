const SESSION_FILTER_KEYS = ['agent', 'integration', 'channel', 'trigger'] as const

type SearchParamsReader = Pick<URLSearchParams, 'get'>

export function isFlatSessionView(params: SearchParamsReader): boolean {
  return params.get('view') === 'flat'
}

/** Query state that remains meaningful while moving between the Sessions list
 *  and one raw session. Unknown list modes are deliberately dropped. */
export function sessionListSearchParams(params: SearchParamsReader): URLSearchParams {
  const next = new URLSearchParams()
  if (isFlatSessionView(params)) next.set('view', 'flat')
  for (const key of SESSION_FILTER_KEYS) {
    const value = params.get(key)
    if (value && value !== 'all') next.set(key, value)
  }
  return next
}
