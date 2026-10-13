import { useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { ChatRow } from './chats'

const COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae']
export function initials(t: string) {
  const words = t.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w))   // skip '-', '·', emoji-only tokens
  return words.slice(0, 2).map((w) => ([...w].find((ch) => /\p{L}|\p{N}/u.test(ch)) ?? '').toUpperCase()).join('') || '?'
}
export function Avatar({ row, size = 48 }: { row: ChatRow; size?: number }) {
  const style = { width: size, height: size, minWidth: size, fontSize: size * 0.38 }
  if (row.photoPath) return <img className="avatar" style={style} src={Capacitor.convertFileSrc(row.photoPath)} alt="" />
  const bg = row.kind === 'self' ? '#3b82f6' : COLORS[Math.abs(row.id) % COLORS.length]
  return <div className="avatar" style={{ ...style, background: bg }}>{row.kind === 'self' ? '🔖' : initials(row.title)}</div>
}
function when(unix: number): string {
  if (!unix) return ''
  const d = new Date(unix * 1000), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (now.getTime() - d.getTime() < 6 * 86400e3) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

type Scope = 'crew' | 'bots' | 'all'
export function ChatList({ rows, selected, onOpen }: { rows: ChatRow[]; selected?: number; onOpen: (r: ChatRow) => void }) {
  const crewCount = rows.filter((r) => r.ownedBot).length
  const [scope, setScope] = useState<Scope | null>(null)
  const eff: Scope = scope ?? (crewCount ? 'crew' : 'all')
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    let list = eff === 'crew' ? rows.filter((r) => r.ownedBot) : eff === 'bots' ? rows.filter((r) => r.kind === 'bot' || r.kind === 'self') : rows
    const s = q.trim().toLowerCase()
    if (s) list = rows.filter((r) => r.title.toLowerCase().includes(s))
    return list
  }, [rows, eff, q])
  const unreadIn = (f: (r: ChatRow) => boolean) => rows.filter((r) => f(r) && (r.unread > 0 || r.markedUnread)).length
  const seg = (k: Scope, label: string, n: number) => (
    <button className={`seg${eff === k ? ' on' : ''}`} onClick={() => setScope(k)}>{label}{n ? <span className="segdot">{n}</span> : null}</button>)
  return (
    <div className="list">
      <header className="listhead">
        <div className="brand"><img className="logo" src="/logo.png" alt="" />Aircrew <span className="go">Go</span></div>
        <input className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segs">
          {seg('crew', `My crew${crewCount ? ` · ${crewCount}` : ''}`, unreadIn((r) => r.ownedBot))}
          {seg('bots', 'Bots', unreadIn((r) => r.kind === 'bot'))}
          {seg('all', 'All', unreadIn(() => true))}
        </div>
      </header>
      <div className="rows">
        {!rows.length && <div className="empty">Loading your chats…</div>}
        {rows.length > 0 && !shown.length && <div className="empty">{q ? 'No chats match.' : 'Nothing here yet.'}</div>}
        {shown.map((r) => {
          const unread = r.unread > 0 || r.markedUnread
          return (
            <button key={r.id} className={`row${selected === r.id ? ' sel' : ''}`} onClick={() => onOpen(r)}>
              <Avatar row={r} />
              <div className="rmain">
                <div className="rtop">
                  <span className={`rtitle${unread ? ' b' : ''}`}>{r.title}{r.ownedBot && eff !== 'crew' && <span className="tag">crew</span>}</span>
                  <span className="rtime">{when(r.lastDate)}</span>
                </div>
                <div className="rbot">
                  <span className="rprev">{r.lastOut && <span className="you">You: </span>}{r.lastText || ' '}</span>
                  {r.pinned && !unread && <span className="pin">📌</span>}
                  {unread && <span className={`ubadge${r.muted ? ' muted' : ''}`}>{r.unread || ''}</span>}
                </div>
              </div>
            </button>)
        })}
      </div>
    </div>)
}
