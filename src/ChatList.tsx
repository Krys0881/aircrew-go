import { useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { BotIcon, PinIcon, MuteIcon } from '@aircrew/components/icons'
import type { ChatRow } from './chats'

// Same markup + class names as the Mac app's ChatList (ai-gram/src/renderer/components/ChatList.tsx),
// styled by the Mac app's own styles.css.
export function initials(t: string) {
  const words = t.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w))
  return words.slice(0, 2).map((w) => ([...w].find((ch) => /\p{L}|\p{N}/u.test(ch)) ?? '').toUpperCase()).join('') || '?'
}
export function Avatar({ row, size }: { row: ChatRow; size?: number }) {
  const style = size ? { width: size, height: size, flexBasis: size, fontSize: Math.round(size * 0.38) } : undefined
  if (row.photoPath) return <img className="avatar avatar-img" style={style} src={Capacitor.convertFileSrc(row.photoPath)} alt="" />
  return <div className="avatar" style={style}>{row.kind === 'self' ? '🔖' : initials(row.title)}</div>
}

type Scope = 'crew' | 'all'
export function ChatList({ rows, selected, onOpen }: { rows: ChatRow[]; selected?: number; onOpen: (r: ChatRow) => void }) {
  const crewCount = rows.filter((r) => r.ownedBot).length
  const [scope, setScope] = useState<Scope | null>(() => (localStorage.getItem('ago.scope') as Scope | null))
  const eff: Scope = scope ?? (crewCount ? 'crew' : 'all')
  const pick = (s: Scope) => { localStorage.setItem('ago.scope', s); setScope(s) }
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s) return rows.filter((r) => r.title.toLowerCase().includes(s))
    return eff === 'crew' ? rows.filter((r) => r.ownedBot) : rows
  }, [rows, eff, q])
  return (
    <div className="chatlist go-list">
      <div className="go-top">
        <img className="go-logo" src="/logo.png" alt="" />
        <span className="go-brand">Aircrew <span className="go-word">Go</span></span>
      </div>
      <div className="toolbar">
        <input className="search" placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chatfilter">
        <div className="seg cf-seg">
          <button className={`seg-btn${eff === 'all' ? ' active' : ''}`} onClick={() => pick('all')}>All</button>
          <button className={`seg-btn cf-crew-btn${eff === 'crew' ? ' active' : ''}`} onClick={() => pick('crew')}>
            <BotIcon size={13} /> My crew{crewCount ? ` (${crewCount})` : ''}
          </button>
        </div>
      </div>
      <div className="rows">
        {!rows.length && <div className="empty">Loading your chats…</div>}
        {rows.length > 0 && !shown.length && <div className="empty">{q ? 'No chats match' : 'No bots you own yet.'}</div>}
        {shown.map((c) => (
          <div key={c.id} className={`row${selected === c.id ? ' active' : ''}`} onClick={() => onOpen(c)}>
            <Avatar row={c} />
            <div className="meta">
              <div className="line1">
                {c.pinned && <span className="chip-ico chip-pin"><PinIcon size={12} /></span>}
                <span className="title">{c.title}</span>
                {c.muted && <span className="chip-ico"><MuteIcon size={13} /></span>}
                {c.kind === 'bot' && <span className="badge">BOT</span>}
                {(c.kind === 'group') && <span className="badge badge-group">GROUP</span>}
              </div>
              <div className="line2">{c.lastOut ? 'You: ' : ''}{c.lastText || '—'}</div>
            </div>
            {c.unread > 0 ? <div className={`unread${c.muted ? ' muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</div>
              : c.markedUnread && <div className={`unread dot${c.muted ? ' muted' : ''}`} />}
          </div>))}
      </div>
      <div className="statusbar">{rows.length} chats</div>
    </div>)
}
