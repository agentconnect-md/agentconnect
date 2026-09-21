/** Runtimes that bind their model from the environment at launch because they advertise no ACP model selector. */
export const RUNTIME_MODEL_ENV: Readonly<Record<string, string>> = Object.freeze({
  // @google/gemini-cli 0.60.0 reads process.env.GEMINI_MODEL once at process start — no live switching.
  gemini: 'GEMINI_MODEL'
})

/** The runtime-native model variable for `runtimeId`, or `{}` when it selects models over ACP. */
export function runtimeModelEnv(runtimeId: string, model: string | undefined): Record<string, string> {
  const name = RUNTIME_MODEL_ENV[runtimeId]
  return name && model ? { [name]: model } : {}
}
