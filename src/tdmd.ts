// TDLib formattedText -> Markdown (port of ai-gram src/main/tdlib/client.ts formattedTextToMarkdown,
// adapted from tdl's `_` keys to raw TDLib JSON '@type').
type Ent = { offset: number; length: number; type: { '@type': string; language?: string; url?: string } }
export type FT = { text?: string; entities?: Ent[] }
function markers(t: Ent['type']): [string, string] | null {
  switch (t?.['@type']) {
    case 'textEntityTypeCode': return ['`', '`']
    case 'textEntityTypePre': return ['\n\n```\n', '\n```\n\n']
    case 'textEntityTypePreCode': return [`\n\n\`\`\`${t.language ?? ''}\n`, '\n```\n\n']
    case 'textEntityTypeExpandableBlockQuote': return ['\n\n````thinking\n', '\n````\n\n']
    case 'textEntityTypeBold': return ['**', '**']
    case 'textEntityTypeItalic': return ['*', '*']
    case 'textEntityTypeStrikethrough': return ['~~', '~~']
    case 'textEntityTypeTextUrl': return ['[', `](${t.url ?? ''})`]
    default: return null
  }
}
export function ftToMarkdown(ft?: FT): string {
  const text = ft?.text ?? ''
  const ins: Array<{ pos: number; str: string; open: number }> = []
  for (const e of ft?.entities ?? []) {
    const m = markers(e.type); if (!m) continue
    ins.push({ pos: e.offset, str: m[0], open: 1 }, { pos: e.offset + e.length, str: m[1], open: 0 })
  }
  ins.sort((a, b) => b.pos - a.pos || b.open - a.open)
  let out = text
  for (const i of ins) out = out.slice(0, i.pos) + i.str + out.slice(i.pos)
  return out
}
