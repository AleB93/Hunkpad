// Browser stand-in for @tauri-apps/api/event: no file watcher or live git output in demo mode.
export async function listen(_event: string, _handler: (e: { payload: unknown }) => void): Promise<() => void> {
  return () => {};
}
