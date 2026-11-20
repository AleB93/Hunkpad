// Draws the Mermaid diagrams of "Code to flow" (claude.ts makes the text).
// Mermaid is large, so it is loaded the first time a diagram is drawn. The
// diagram text comes from Claude, which read repository code, so Mermaid runs
// in its strict mode with plain-SVG labels, and its SVG is sanitised again.

import DOMPurify from "dompurify";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | null = null;
let seq = 0;

/** The diagram as sanitised SVG markup; throws Mermaid's message on a syntax error. */
export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = await (loading ??= import("mermaid").then((m) => m.default));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false, // labels as SVG text, no HTML inside the drawing
    theme: dark ? "dark" : "default",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  });
  const { svg } = await mermaid.render(`hunkpad-flow-${++seq}`, source);
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"], // Mermaid styles its diagram with an inner <style>
    FORBID_TAGS: ["foreignObject", "script"],
  });
}

/** The SVG as a PNG blob (for the clipboard), drawn at `scale`. */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const box = svg.viewBox.baseVal;
  const width = Math.ceil((box?.width || svg.getBoundingClientRect().width) * scale);
  const height = Math.ceil((box?.height || svg.getBoundingClientRect().height) * scale);
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("could not draw the diagram as an image"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not make a PNG"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
