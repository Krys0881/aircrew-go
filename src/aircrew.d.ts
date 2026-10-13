// Components imported from the Mac app's repo via the '@aircrew' Vite alias (vite.config.ts).
declare module '@aircrew/components/MessageMarkdown' {
  import type { NamedExoticComponent } from 'react'
  export const MessageMarkdown: NamedExoticComponent<{ text: string }>
  export const StreamingMarkdown: NamedExoticComponent<{ text: string }>
}
declare module '@aircrew/components/icons' {
  import type { FC } from 'react'
  type I = FC<{ size?: number; className?: string }>
  export const BotIcon: I
  export const PinIcon: I
  export const MuteIcon: I
  export const MoreIcon: I
  export const PaperclipIcon: I
  export const XIcon: I
}
