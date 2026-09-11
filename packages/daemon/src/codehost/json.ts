/** Code-host ids exceed the safe-integer range; quote every `id`/`*_id` field before parsing so none is rounded. */
export function parseCodeHostJson(raw: string): unknown {
  return JSON.parse(raw.replace(/"((?:[a-z][a-z0-9_]*_)?id)"\s*:\s*(\d{15,})/g, '"$1":"$2"'))
}
