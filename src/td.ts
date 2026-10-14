// Minimal tdl-compatible client over the TdJson Capacitor plugin.
// invoke() pairs requests/responses via @extra; on('update') gets everything else.
import { registerPlugin } from '@capacitor/core'
import { diag } from './diag'

type TdObj = { '@type': string; [k: string]: unknown }
interface TdJsonPlugin {
  create(o?: { fresh?: boolean }): Promise<{ clientId: number; filesDir: string; cacheDir: string; reused?: boolean }>
  send(o: { clientId: number; json: string }): Promise<void>
  execute(o: { json: string }): Promise<{ json: string | null }>
  openFile(o: { path: string; mime?: string }): Promise<{ needsPermission?: boolean }>
  addListener(ev: 'td', cb: (e: { json: string }) => void): Promise<{ remove: () => void }>
}
export const TdJson = registerPlugin<TdJsonPlugin>('TdJson')

export class TdClient {
  private seq = 0
  private pending = new Map<string, { res: (v: TdObj) => void; rej: (e: TdObj) => void }>()
  private updateCbs: Array<(u: TdObj) => void> = []
  readonly id: number
  readonly filesDir: string
  /** true when the native side handed back the process' existing TDLib client (JS/WebView restarted). */
  readonly reused: boolean
  private constructor(id: number, filesDir: string, reused: boolean) { this.id = id; this.filesDir = filesDir; this.reused = reused }

  static async create(fresh = false): Promise<TdClient> {
    await TdJson.execute({ json: JSON.stringify({ '@type': 'setLogVerbosityLevel', new_verbosity_level: 1 }) })
    const { clientId, filesDir, reused } = await TdJson.create({ fresh })
    const c = new TdClient(clientId, filesDir, !!reused)
    await TdJson.addListener('td', (e) => c.dispatch(e.json))
    diag(`td: client ${clientId} ${reused ? 'REUSED (JS restarted, TDLib kept)' : 'new'}`)
    // TDLib only starts emitting updates for a client after its first request.
    void c.invoke({ '@type': 'getOption', name: 'version' }).catch(() => undefined)
    return c
  }

  private dispatch(raw: string): void {
    let o: TdObj & { '@client_id'?: number; '@extra'?: string }
    try { o = JSON.parse(raw) } catch { diag('td: unparsable event dropped'); return }
    if (o['@client_id'] !== undefined && o['@client_id'] !== this.id) return
    const extra = o['@extra']
    if (extra && this.pending.has(extra)) {
      const p = this.pending.get(extra)!
      this.pending.delete(extra)
      if (o['@type'] === 'error') p.rej(o)
      else p.res(o)
      return
    }
    for (const cb of this.updateCbs) cb(o)
  }

  /** timeoutMs > 0: reject (and forget the request) if TDLib doesn't answer in time — so the UI can never
   *  hang on a lost answer (0.5.2 kept Send greyed forever). Bridge failures reject too (they were swallowed). */
  invoke<T = TdObj>(req: TdObj, timeoutMs = 0): Promise<T> {
    const extra = `r${++this.seq}`
    return new Promise<T>((res, rej) => {
      let to: number | undefined
      const settle = () => { if (to !== undefined) window.clearTimeout(to) }
      this.pending.set(extra, { res: (v) => { settle(); (res as unknown as (v: TdObj) => void)(v) }, rej: (e) => { settle(); rej(e) } })
      if (timeoutMs > 0) to = window.setTimeout(() => {
        if (!this.pending.delete(extra)) return
        diag(`td: TIMEOUT ${req['@type']} — no answer after ${timeoutMs} ms`)
        rej({ '@type': 'error', code: -1, message: `no answer from Telegram after ${Math.round(timeoutMs / 1000)} s` })
      }, timeoutMs)
      TdJson.send({ clientId: this.id, json: JSON.stringify({ ...req, '@extra': extra }) }).catch((e: { message?: string }) => {
        if (!this.pending.delete(extra)) return
        settle()
        diag(`td: bridge send failed for ${req['@type']}: ${e?.message ?? String(e)}`)
        rej({ '@type': 'error', code: -2, message: `app bridge error: ${e?.message ?? String(e)}` })
      })
    })
  }

  on(_ev: 'update', cb: (u: TdObj) => void): void {
    this.updateCbs.push(cb)
  }
}
