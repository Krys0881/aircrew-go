// Composer keys (0.5.5): on a HARDWARE keyboard (e.g. Bluetooth) Enter sends and Shift+Enter makes a new line.
// The on-screen keyboard keeps Enter = new line: Android's IME delivers Enter without a physical key position, so
// KeyboardEvent.code is '' (Chrome derives `code` from the scancode, which IME-generated events don't have).
export interface EnterKey {
  key: string
  code: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

export function isHardwareEnterSend(e: EnterKey): boolean {
  if (e.key !== 'Enter' || e.isComposing) return false
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false // Shift+Enter (and any modifier) = default: new line
  return e.code === 'Enter' || e.code === 'NumpadEnter' // physical Enter keys only
}
