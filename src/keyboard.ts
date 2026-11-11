/** Resolve application shortcuts by physical position, not the active layout. */
export function shortcutKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (event.code === 'Comma') return ',';
  // Some WebView/remote-input events omit code. Support standard RU/EN here too.
  const key = event.key.toLowerCase();
  const russian: Record<string, string> = { 'с': 'c', 'м': 'v', 'е': 't', 'ц': 'w', 'б': ',', '<': ',' };
  return russian[key] ?? key;
}
