// Markdown preview: GitHub-flavoured Markdown rendered with marked, then
// sanitised with DOMPurify. The preview lives in the app's own page, which can
// call Git, so nothing from the file may run: no scripts, event handlers,
// javascript: links, styles that would leak into the app, frames or forms.

import { marked } from "marked";
import DOMPurify from "dompurify";

export const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(path);

export function markdownToHtml(text: string): string {
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "link", "meta", "base", "iframe", "frame", "frameset", "object", "embed", "form", "button", "textarea", "select"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * A link or image path in the file at `fromFile`, as a repository path: relative
 * to that file's folder, or to the repository root when it starts with "/".
 * Null when it leaves the repository.
 */
export function resolveRepoPath(fromFile: string, href: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(href);
  } catch {
    target = href;
  }
  const parts = target.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** http(s) / mailto links: opened in the browser. */
export const isWebLink = (href: string) => /^(https?:|mailto:)/i.test(href);
