export function parseCsv(source, { headers = true } = {}) {
  const input = source.replace(/^\uFEFF/, '')
  if (!input.trim()) return []

  const records = []
  let row = []
  let field = ''
  let state = 'start'
  let line = 1
  let rowLine = 1

  function finishRow() {
    row.push(field)
    records.push({ values: row, line: rowLine })
    row = []
    field = ''
    state = 'start'
    rowLine = line + 1
  }

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const newline = char === '\n' || char === '\r'

    if (state === 'quoted') {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          state = 'afterQuote'
        }
      } else if (newline) {
        if (char === '\r' && input[i + 1] === '\n') i++
        field += '\n'
        line++
      } else {
        field += char
      }
      continue
    }

    if (char === ',') {
      row.push(field)
      field = ''
      state = 'start'
    } else if (newline) {
      if (char === '\r' && input[i + 1] === '\n') i++
      finishRow()
      line++
      rowLine = line
    } else if (char === '"') {
      if (state === 'afterQuote') throw new Error(`Line ${line}: unexpected character after closing quote.`)
      if (state !== 'start') throw new Error(`Line ${line}: unexpected quote in an unquoted field.`)
      state = 'quoted'
    } else {
      if (state === 'afterQuote') throw new Error(`Line ${line}: unexpected character after closing quote.`)
      field += char
      state = 'unquoted'
    }
  }

  if (state === 'quoted') throw new Error(`Line ${rowLine}: quoted field is not closed.`)
  if (row.length || field || state !== 'start') finishRow()

  const expected = records[0]?.values.length ?? 0
  for (const record of records) {
    if (record.values.length !== expected) {
      throw new Error(
        `Line ${record.line}: expected ${expected} column${expected === 1 ? '' : 's'}, found ${record.values.length}.`
      )
    }
  }

  if (!headers) return records.map((record) => record.values)
  const [header, ...data] = records
  if (!header) return []
  const names = new Set()
  for (const name of header.values) {
    if (!name.trim()) throw new Error(`Line ${header.line}: header names cannot be empty.`)
    if (names.has(name)) throw new Error(`Line ${header.line}: duplicate header "${name}".`)
    names.add(name)
  }
  return data.map((record) => Object.fromEntries(header.values.map((name, index) => [name, record.values[index]])))
}
