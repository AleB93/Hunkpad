// Demo mode: the real UI in a browser, with the Tauri APIs replaced by shims
// whose commands run here, in Node, against a generated sample repository.
// Used for the screenshots in docs/. Run: npm run demo
import { defineConfig, type Plugin } from "vite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// A short temp path (it shows in the screenshots), resolved like Git resolves
// repository roots (macOS /tmp → /private/tmp).
const tmp = process.platform === "win32" ? os.tmpdir() : "/tmp";
const root = path.join(fs.realpathSync(tmp), "hunkpad-demo");
const settingsFile = path.join(root, "settings.json");

function safeJoin(repo: string, rel: string) {
  if (!fs.existsSync(path.join(repo, ".git"))) throw `not a Git repository: ${repo}`;
  if (rel.split(/[\\/]/).some((p) => p === ".." || p === "")) throw `invalid path: ${rel}`;
  return path.join(repo, rel);
}

const commands: Record<string, (a: any) => unknown> = {
  git_version: () => spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim(),
  initial_repo: () => null, // the tabs saved in settings.json open instead
  load_settings: () => (fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : null),
  save_settings: ({ content }) => fs.writeFileSync(settingsFile, content),
  migrate_data_dir: () => null,
  run_git: ({ cwd, args, stdin, indexFile }) => {
    const r = spawnSync("git", args, {
      cwd,
      input: stdin ?? undefined,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  temp_index_path: () => path.join(os.tmpdir(), `hunkpad-index-demo-${Date.now()}`),
  remove_temp_index: ({ path: p }) => fs.rmSync(p, { force: true }),
  read_file: ({ repo, path: p }) => {
    const full = safeJoin(repo, p);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  },
  write_file: ({ repo, path: p, content }) => {
    const full = safeJoin(repo, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  },
  file_times: ({ repo, paths }) =>
    (paths as string[]).map((p) => {
      try {
        return Math.round(fs.statSync(safeJoin(repo, p)).mtimeMs);
      } catch {
        return null;
      }
    }),
  paths_exist: ({ base, paths }) => (paths as string[]).map((p) => fs.existsSync(path.join(base, p))),
  is_file: ({ path: p }) => fs.existsSync(p) && fs.statSync(p).isFile(),
  find_child_repos: () => [],
  read_package_json: ({ path: p }) => fs.readFileSync(p, "utf8"),
  copy_as_file: () => "",
  watch_repo: () => null,
  unwatch_repo: () => null,
  launch_script: () => null,
  open_terminal: () => null,
  open_git_download: () => null,
  open_token_page: () => null,
};

function demoBackend(): Plugin {
  return {
    name: "hunkpad-demo-backend",
    configureServer(server) {
      // A fresh sample repository on every start (and on POST /__demo/reset),
      // so screenshots are reproducible.
      const reset = () => spawnSync("bash", [path.join(here, "make-repo.sh"), root], { stdio: "inherit" });
      reset();
      server.middlewares.use("/__demo/reset", (_req, res) => {
        reset();
        res.end("ok");
      });
      server.middlewares.use("/__demo/invoke", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const { cmd, args } = JSON.parse(body);
          let out: { ok: boolean; value?: unknown; error?: string };
          try {
            const fn = commands[cmd];
            if (!fn) throw `demo: unknown command ${cmd}`;
            out = { ok: true, value: fn(args ?? {}) ?? null };
          } catch (e) {
            out = { ok: false, error: String(e) };
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out));
        });
      });
    },
  };
}

export default defineConfig({
  root: path.resolve(here, ".."),
  clearScreen: false,
  plugins: [demoBackend()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": path.join(here, "shims/core.ts"),
      "@tauri-apps/api/event": path.join(here, "shims/event.ts"),
      "@tauri-apps/plugin-dialog": path.join(here, "shims/dialog.ts"),
    },
  },
  server: { port: 1421, strictPort: true },
});
