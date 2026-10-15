const SESSION_FILTER_KEYS = ['agent', 'integration', 'channel', 'trigger'] as const

type SearchParamsReader = Pick<URLSearchParams, 'get'>

/** The All sessions toggle that lists tasks beside conversations; tasks are hidden unless it is on. */
export const SHOW_TASKS_PARAM = 'tasks'
const SHOW_TASKS_VALUE = 'show'

export function isFlatSessionView(params: SearchParamsReader): boolean {
  return params.get('view') === 'flat'
}

/** Whether the list shows tasks (delegated tasks, patrols, approved proposals) as well as conversations. */
export function showsTasks(params: SearchParamsReader): boolean {
  return params.get(SHOW_TASKS_PARAM) === SHOW_TASKS_VALUE
}

/** `params` with the Show tasks toggle set to `on`, every other key kept. */
export function withShowTasks(params: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(params.toString())
  if (on) next.set(SHOW_TASKS_PARAM, SHOW_TASKS_VALUE)
  else next.delete(SHOW_TASKS_PARAM)
  return next
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
  if (showsTasks(params)) next.set(SHOW_TASKS_PARAM, SHOW_TASKS_VALUE)
  return next
}
