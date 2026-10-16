// Takes the README screenshots and GIFs from demo mode.
//
//   npm run demo                 (in another terminal)
//   node demo/capture.mjs        → docs/media/*.png, *.gif
//
// Needs `npm i --no-save playwright-core gifenc pngjs` and Google Chrome.
import { chromium } from "playwright-core";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = "http://localhost:1421";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "media");
const tmp = process.platform === "win32" ? os.tmpdir() : "/tmp";
const SETTINGS = path.join(fs.realpathSync(tmp), "hunkpad-demo", "settings.json");
const W = 1280;
const H = 800;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh sample repo and a page on it. `confirmGit` = the "Ask before Git commands" dialog. */
async function scene({ dark = false, confirmGit = false, scale = 2 } = {}) {
  await fetch(`${URL}/__demo/reset`, { method: "POST" });
  const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  s.values.confirmGit = confirmGit ? "on" : "off";
  fs.writeFileSync(SETTINGS, JSON.stringify(s));
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: scale,
    colorScheme: dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  // Native dialogs are window.confirm in demo mode: answer yes.
  page.on("dialog", (d) => d.accept());
  await page.goto(URL);
  await page.waitForSelector('[data-target="worktree:src/cart/cart.ts"]');
  await sleep(800);
  return page;
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`${name}.png`);
};

const openFile = async (page, file) => {
  await page.click(`[data-target="worktree:${file}"]`);
  await page.waitForSelector(".monaco-diff-editor .modified .view-line");
  await sleep(900);
};

/** Clicks a line number in the right-hand (modified) editor. */
const lineNumber = (page, n) =>
  page.locator(".monaco-diff-editor .editor.modified .line-numbers", { hasText: new RegExp(`^\\s*${n}\\s*$`) }).first();

// ---- screenshots -------------------------------------------------------------

{
  const page = await scene();
  await shot(page, "overview");
  await openFile(page, "src/cart/cart.ts");
  await shot(page, "diff");
  await page.click('#tabs [data-tab="history"]');
  await sleep(600);
  await page.locator("#panel-history .commit").nth(4).click();
  await sleep(800);
  await page.locator("#panel-history .item").first().click();
  await sleep(1200);
  await shot(page, "history");
  await page.click("#overview-btn");
  await page.click('#tabs [data-tab="branches"]');
  await sleep(800);
  await shot(page, "branches");
  await page.click('#tabs [data-tab="changes"]');
  await openFile(page, "src/http/routes.ts");
  await page.click('#tabs [data-tab="comments"]');
  await sleep(800);
  await shot(page, "comments");
  await page.close();
}
{
  const page = await scene({ dark: true });
  await openFile(page, "src/cart/cart.ts");
  await shot(page, "diff-dark");
  await page.close();
}

// ---- GIFs --------------------------------------------------------------------

/** Records frames with a visible cursor, then writes an animated GIF. */
class Recorder {
  frames = [];
  constructor(page) {
    this.page = page;
    this.x = W / 2;
    this.y = H / 2;
  }
  async init() {
    await this.page.evaluate(() => {
      const c = document.createElement("div");
      c.id = "demo-cursor";
      c.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 9-6.5 1.5L8.5 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      Object.assign(c.style, { position: "fixed", zIndex: 99999, pointerEvents: "none", left: "640px", top: "400px" });
      document.body.append(c);
      const ring = document.createElement("div");
      ring.id = "demo-ring";
      Object.assign(ring.style, {
        position: "fixed", zIndex: 99998, pointerEvents: "none", width: "28px", height: "28px",
        margin: "-14px 0 0 -14px", borderRadius: "50%", background: "rgba(76,142,218,.35)", display: "none",
      });
      document.body.append(ring);
    });
  }
  async frame(hold = 80) {
    // Dialogs are in the top layer, above any z-index: move the cursor into an open one.
    await this.page.evaluate(() => {
      const c = document.getElementById("demo-cursor");
      const r = document.getElementById("demo-ring");
      const host = document.querySelector("dialog[open]") ?? document.body;
      if (c.parentElement !== host) host.append(r, c);
    });
    this.frames.push({ png: await this.page.screenshot(), hold });
  }
  async hold(ms) {
    this.frames[this.frames.length - 1].hold += ms;
  }
  async moveTo(locator, { dx = 0, dy = 0 } = {}) {
    const box = await locator.boundingBox();
    const tx = box.x + Math.min(box.width / 2, 40) + dx;
    const ty = box.y + box.height / 2 + dy;
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const t = 1 - (1 - i / steps) ** 3;
      const x = this.x + (tx - this.x) * t;
      const y = this.y + (ty - this.y) * t;
      await this.page.evaluate(([x, y]) => {
        const c = document.getElementById("demo-cursor");
        c.style.left = `${x - 3}px`;
        c.style.top = `${y - 2}px`;
      }, [x, y]);
      await this.frame(40);
    }
    this.x = tx;
    this.y = ty;
  }
  async click(locator, opts = {}) {
    await this.moveTo(locator, opts);
    await this.page.evaluate(([x, y]) => {
      const r = document.getElementById("demo-ring");
      Object.assign(r.style, { left: `${x}px`, top: `${y}px`, display: "block" });
    }, [this.x, this.y]);
    await this.frame(120);
    await this.page.mouse.click(this.x, this.y, { modifiers: opts.modifiers });
    await this.page.evaluate(() => (document.getElementById("demo-ring").style.display = "none"));
  }
  async type(text) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      if (ch === " " || Math.random() < 0.3) await this.frame(50);
    }
    await this.frame(300);
  }
  write(name, width = 960) {
    // DEBUG_FRAMES=<dir>: also save the frames that are held (the "keyframes"), to check them.
    const dbg = process.env.DEBUG_FRAMES;
    if (dbg) {
      fs.mkdirSync(dbg, { recursive: true });
      this.frames.forEach((f, i) => f.hold >= 300 && fs.writeFileSync(path.join(dbg, `${name}-${i}.png`), f.png));
    }
    const gif = GIFEncoder();
    for (const f of this.frames) {
      const { data, w, h } = downscale(PNG.sync.read(f.png), width);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: f.hold });
    }
    gif.finish();
    fs.writeFileSync(path.join(OUT, `${name}.gif`), gif.bytes());
    console.log(`${name}.gif (${this.frames.length} frames)`);
  }
}

/** Box-filter downscale of an RGBA image to `width` (keeps the aspect ratio). */
function downscale(png, width) {
  const s = png.width / width;
  const w = width;
  const h = Math.round(png.height / s);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s));
      const y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
      const acc = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * png.width + xx) * 4;
          for (let k = 0; k < 4; k++) acc[k] += png.data[i + k];
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = acc[k] / n;
    }
  }
  return { data: out, w, h };
}

// Line-level staging: put the cursor in one change and stage just that block.
{
  const page = await scene({ scale: 1 });
  const rec = new Recorder(page);
  await rec.init();
  await rec.frame(900);
  await rec.click(page.locator('[data-target="worktree:src/cart/cart.ts"]'));
  await page.waitForSelector(".monaco-diff-editor .modified .view-line");
  await sleep(900);
  await rec.frame(1200);
  await rec.click(lineNumber(page, 14));
  await sleep(200);
  await rec.frame(600);
  await rec.click(page.locator("#diff-actions button", { hasText: "Stage selection" }));
  await sleep(1200);
  await rec.frame(1800);
  await rec.click(lineNumber(page, 17));
  await sleep(200);
  await rec.frame(500);
  await rec.click(page.locator("#diff-actions button", { hasText: "Stage selection" }));
  await sleep(1200);
  await rec.frame(2500);
  rec.write("line-staging");
  await page.close();
}

// Every Git command is shown before it runs.
{
  const page = await scene({ scale: 1, confirmGit: true });
  const rec = new Recorder(page);
  await rec.init();
  await rec.frame(700);
  await rec.click(page.locator("#commit-msg"));
  await rec.type("Add flat-rate shipping");
  await rec.click(page.locator("#commit-btn"));
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const prompting = await page.evaluate(() => document.getElementById("git-dialog").classList.contains("prompting"));
    if (!prompting) break;
    await rec.frame(2600);
    await rec.click(page.locator("#git-run"));
  }
  await sleep(800);
  await rec.frame(1500);
  if (await page.locator("#git-close").isVisible()) await rec.click(page.locator("#git-close"));
  await sleep(800);
  await rec.frame(2000);
  rec.write("confirm-git");
  await page.close();
}

// Review comments on a line, then the Comments tab.
{
  const page = await scene({ scale: 1 });
  const rec = new Recorder(page);
  await rec.init();
  await rec.frame(600);
  await rec.click(page.locator('[data-target="worktree:src/cart/cart.ts"]'));
  await page.waitForSelector(".monaco-diff-editor .modified .view-line");
  await sleep(900);
  await rec.frame(600);
  // In the code, not on the number: clicking a line number puts the cursor on the next line.
  await rec.click(lineNumber(page, 27), { dx: 160 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+KeyM" : "Control+Alt+KeyM");
  await page.waitForSelector("#comment-dialog[open]");
  await sleep(300);
  await rec.frame(500);
  await rec.type("Reject percent discounts outside 0-100?");
  await rec.click(page.locator("#comment-save"));
  await sleep(700);
  await rec.frame(500);
  // Scroll the new comment into view.
  await page.mouse.move(1000, 500);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 50);
    await sleep(60);
    await rec.frame(40);
  }
  await sleep(300);
  await rec.frame(1800);
  await rec.click(page.locator('#tabs [data-tab="comments"]'));
  await sleep(700);
  await rec.frame(2500);
  rec.write("comments");
  await page.close();
}

await browser.close();
