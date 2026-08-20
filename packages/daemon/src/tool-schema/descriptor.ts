/** A JSON value, defined locally so this vocabulary stays a dependency-free leaf. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** A tool descriptor in MCP's `tools/list` shape: name, model-facing description, and an argument JSON Schema. */
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: ObjectToolSchema | ObjectUnionSchema
}

export type ToolProperties = Record<string, JsonValue>

export interface ObjectToolSchema extends Record<string, JsonValue> {
  type: 'object'
  properties: ToolProperties
  required: string[]
  additionalProperties: false
}

/** A root object schema whose `oneOf` branches are mutually exclusive call modes (used by sendMessage). */
export interface ObjectUnionSchema extends Record<string, JsonValue> {
  type: 'object'
  oneOf: ObjectToolSchema[]
}

export const obj = (properties: ToolProperties, required: string[] = []): ObjectToolSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

export const unionOf = (oneOf: ObjectToolSchema[]): ObjectUnionSchema => ({
  type: 'object',
  oneOf
})
