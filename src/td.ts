// Minimal tdl-compatible client over the TdJson Capacitor plugin.
// invoke() pairs requests/responses via @extra; on('update') gets everything else.
import { registerPlugin } from '@capacitor/core'

type TdObj = { '@type': string; [k: string]: unknown }
interface TdJsonPlugin {
  create(): Promise<{ clientId: number; filesDir: string; cacheDir: string }>
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
  private constructor(id: number, filesDir: string) { this.id = id; this.filesDir = filesDir }

  static async create(): Promise<TdClient> {
    await TdJson.execute({ json: JSON.stringify({ '@type': 'setLogVerbosityLevel', new_verbosity_level: 1 }) })
    const { clientId, filesDir } = await TdJson.create()
    const c = new TdClient(clientId, filesDir)
    await TdJson.addListener('td', (e) => c.dispatch(e.json))
    // TDLib only starts emitting updates for a client after its first request.
    void c.invoke({ '@type': 'getOption', name: 'version' }).catch(() => undefined)
    return c
  }

  private dispatch(raw: string): void {
    const o = JSON.parse(raw) as TdObj & { '@client_id'?: number; '@extra'?: string }
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

  invoke<T = TdObj>(req: TdObj): Promise<T> {
    const extra = `r${++this.seq}`
    return new Promise<T>((res, rej) => {
      this.pending.set(extra, { res: res as unknown as (v: TdObj) => void, rej })
      void TdJson.send({ clientId: this.id, json: JSON.stringify({ ...req, '@extra': extra }) })
    })
  }

  on(_ev: 'update', cb: (u: TdObj) => void): void {
    this.updateCbs.push(cb)
  }
}
