// Aircrew Go diagnostics (0.5.3): a small ring log of EVENTS ONLY — connection changes, send attempts/results,
// errors, resume — never message text. Persisted in localStorage so it survives restarts; "Send log to Ada"
// in the chat-list header ships it as a .txt to Ada's chat when something misbehaves.
const KEY = 'ago.diag'
const MAX = 400
let lines: string[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[] } catch { return [] } })()
let timer: number | undefined

export function diag(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23)
  lines.push(`${ts}Z ${msg}`)
  if (lines.length > MAX) lines = lines.slice(-MAX)
  if (timer === undefined) timer = window.setTimeout(() => {
    timer = undefined
    try { localStorage.setItem(KEY, JSON.stringify(lines)) } catch { /* storage full — keep in memory */ }
  }, 500)
}

export function diagText(): string { return lines.join('\n') }

window.addEventListener('error', (e) => diag(`js error: ${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason as { message?: string } | undefined
  diag(`js unhandled rejection: ${r?.message ?? String(r)}`)
})
