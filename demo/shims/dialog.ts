// Browser stand-in for @tauri-apps/plugin-dialog: native dialogs become browser ones.
type Opts = { title?: string };
export async function ask(text: string, _opts?: Opts): Promise<boolean> {
  return window.confirm(text);
}
export async function message(text: string, _opts?: Opts): Promise<void> {
  window.alert(text);
}
export async function open(_opts?: Opts): Promise<string | null> {
  return null;
}
