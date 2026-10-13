// Components imported from the Mac app's repo via the '@aircrew' Vite alias (vite.config.ts).
declare module '@aircrew/components/MessageMarkdown' {
  import type { NamedExoticComponent } from 'react'
  export const MessageMarkdown: NamedExoticComponent<{ text: string }>
  export const StreamingMarkdown: NamedExoticComponent<{ text: string }>
}
