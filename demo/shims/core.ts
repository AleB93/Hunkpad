// Browser stand-in for @tauri-apps/api/core in demo mode: every command goes
// to the dev server (demo/vite.config.ts), which runs it against the demo repo.
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/__demo/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  const body = (await res.json()) as { ok: boolean; value?: T; error?: string };
  if (!body.ok) throw body.error;
  return body.value as T;
}
