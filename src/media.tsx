import { Capacitor } from '@capacitor/core'
type Any = Record<string, any>

export type FileState = { id: number; size: number; got: number; done: boolean; path?: string; busy?: boolean }
export type Media =
  | { kind: 'photo'; fileId: number; w: number; h: number; thumb?: string }
  | { kind: 'sticker'; fileId: number; emoji: string; w: number; h: number }
  | { kind: 'animation'; fileId: number; w: number; h: number }
  | { kind: 'audio'; fileId: number; name: string; mime: string; voice: boolean }
  | { kind: 'file'; fileId: number; name: string; mime: string }

export function fileStateOf(f: Any | undefined): FileState | undefined {
  if (!f) return undefined
  return { id: f.id, size: f.size || f.expected_size || 0, got: f.local?.downloaded_size ?? 0, done: !!f.local?.is_downloading_completed, path: f.local?.path || undefined }
}

/** Media + the TDLib file objects it references (so the caller can seed its file-state map). */
export function mediaOf(c: Any): { media?: Media; files: Any[] } {
  switch (c?.['@type']) {
    case 'messagePhoto': {
      const sizes = (c.photo?.sizes ?? []) as Any[]
      const pick = [...sizes].sort((a, b) => a.width - b.width).filter((s) => s.width <= 1600).pop() ?? sizes[sizes.length - 1]
      if (!pick) return { files: [] }
      const mt = c.photo?.minithumbnail
      return { media: { kind: 'photo', fileId: pick.photo.id, w: pick.width, h: pick.height, thumb: mt?.data ? `data:image/jpeg;base64,${mt.data}` : undefined }, files: [pick.photo] }
    }
    case 'messageSticker': {
      const st = c.sticker; const webp = st?.format?.['@type'] === 'stickerFormatWebp'
      if (!webp) return { media: undefined, files: [] }
      return { media: { kind: 'sticker', fileId: st.sticker.id, emoji: st.emoji ?? '', w: st.width, h: st.height }, files: [st.sticker] }
    }
    case 'messageAnimation': {
      const a = c.animation
      return { media: { kind: 'animation', fileId: a.animation.id, w: a.width, h: a.height }, files: [a.animation] }
    }
    case 'messageVoiceNote':
      return { media: { kind: 'audio', fileId: c.voice_note.voice.id, name: 'Voice message', mime: c.voice_note.mime_type || 'audio/ogg', voice: true }, files: [c.voice_note.voice] }
    case 'messageAudio':
      return { media: { kind: 'audio', fileId: c.audio.audio.id, name: c.audio.title || c.audio.file_name || 'Audio', mime: c.audio.mime_type || 'audio/mpeg', voice: false }, files: [c.audio.audio] }
    case 'messageDocument':
      return { media: { kind: 'file', fileId: c.document.document.id, name: c.document.file_name || 'File', mime: c.document.mime_type || '' }, files: [c.document.document] }
    case 'messageVideo':
      return { media: { kind: 'file', fileId: c.video.video.id, name: c.video.file_name || 'Video.mp4', mime: c.video.mime_type || 'video/mp4' }, files: [c.video.video] }
    default:
      return { files: [] }
  }
}

/** Small media is fetched as soon as the message is shown; documents/videos wait for a tap. */
export function autoDownload(m: Media, f?: FileState): boolean {
  if (f?.done) return false
  if (m.kind === 'photo' || m.kind === 'sticker') return true
  if (m.kind === 'animation' || m.kind === 'audio') return !f || f.size <= 15 * 1024 * 1024
  return false
}

export function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const isApk = (m: { name: string; mime: string }) => m.mime === 'application/vnd.android.package-archive' || /\.apk$/i.test(m.name)
function icon(m: { name: string; mime: string }): string {
  if (isApk(m)) return '🤖'
  if (/pdf/.test(m.mime) || /\.pdf$/i.test(m.name)) return '📕'
  if (/^video\//.test(m.mime)) return '🎬'
  if (/zip|compressed/.test(m.mime) || /\.(zip|gz|7z|rar)$/i.test(m.name)) return '🗜️'
  if (/sheet|excel|csv/.test(m.mime) || /\.(xlsx?|csv)$/i.test(m.name)) return '📊'
  if (/word|document/.test(m.mime) || /\.docx?$/i.test(m.name)) return '📄'
  if (/sql|json|text/.test(m.mime) || /\.(sql|json|txt|md|log)$/i.test(m.name)) return '📝'
  return '📎'
}

export function MediaView({ media, f, onDownload, onOpen, onZoom }: {
  media: Media; f?: FileState; onDownload: () => void; onOpen: (path: string, mime: string, apk: boolean) => void; onZoom: (src: string) => void
}) {
  const src = f?.done && f.path ? Capacitor.convertFileSrc(f.path) : undefined
  const pct = f && f.size ? Math.min(100, Math.round((f.got / f.size) * 100)) : 0
  switch (media.kind) {
    case 'photo': {
      const ratio = media.w && media.h ? media.w / media.h : 1.5
      return (
        <div className="go-photo" style={{ aspectRatio: String(ratio) }} onClick={() => src && onZoom(src)}>
          {src ? <img src={src} alt="" /> : media.thumb ? <img className="blur" src={media.thumb} alt="" /> : null}
        </div>)
    }
    case 'sticker':
      return src ? <img className="go-sticker" src={src} alt={media.emoji} /> : <div className="go-sticker-ph">{media.emoji || '…'}</div>
    case 'animation':
      return src ? <video className="go-gif" src={src} autoPlay loop muted playsInline /> : <div className="attach-loading video">loading GIF… {pct ? `${pct}%` : ''}</div>
    case 'audio':
      return (
        <div className="attach audio">
          {src ? <audio className="attach-audio" controls src={src} /> : <div className="attach-loading">loading {media.voice ? 'voice message' : 'audio'}… {pct ? `${pct}%` : ''}</div>}
          {!media.voice && <div className="attach-row"><div className="attach-meta"><span className="attach-name">{media.name}</span></div></div>}
        </div>)
    case 'file': {
      const apk = isApk(media)
      const sub = f?.done ? `${fmtSize(f.size)} · ${apk ? 'tap to install' : 'tap to open'}`
        : f?.busy || (f && f.got > 0) ? `downloading… ${pct}%` : `${fmtSize(f?.size ?? 0)} · tap to download`
      return (
        <div className={`attach file${apk ? ' apk' : ''}`}>
          <button className="attach-open" onClick={() => (f?.done && f.path ? onOpen(f.path, media.mime, apk) : onDownload())}>
            <span className="attach-icon">{icon(media)}</span>
            <span className="attach-meta">
              <span className="attach-name">{media.name}</span>
              <span className="attach-sub">{sub}</span>
            </span>
          </button>
          {!f?.done && (f?.busy || (f && f.got > 0)) && <div className="go-progress"><div style={{ width: `${pct}%` }} /></div>}
        </div>)
    }
  }
}
