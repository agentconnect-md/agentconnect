import { parseCsv } from './parse-csv.mjs'

const sample = 'name,city,note\nAri,Oslo,"Likes tea, coffee"\nBo,Kyoto,"Said ""hello""\nand waved"'
const input = document.querySelector('#csv')
const output = document.querySelector('#json')
const status = document.querySelector('#status')
const copy = document.querySelector('#copy')

function render() {
  try {
    const headers = document.querySelector('input[name="mode"]:checked').value === 'headers'
    const result = parseCsv(input.value, { headers })
    output.value = JSON.stringify(result, null, 2)
    status.textContent = input.value.length
      ? `${result.length} ${result.length === 1 ? 'row' : 'rows'} converted.`
      : 'Paste CSV to get started.'
    status.className = 'success'
    copy.disabled = false
  } catch (error) {
    output.value = ''
    status.textContent = error.message
    status.className = 'error'
    copy.disabled = true
  }
}

input.addEventListener('input', render)
document.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', render))
document.querySelector('#sample').addEventListener('click', () => {
  input.value = sample
  render()
  input.focus()
})
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.value)
    status.textContent = 'JSON copied to clipboard.'
    status.className = 'success'
  } catch {
    status.textContent = 'Could not copy automatically. Focus the JSON output, select all, and copy it manually.'
    status.className = 'error'
  }
})

input.value = sample
render()
