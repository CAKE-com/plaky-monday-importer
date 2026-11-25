import { HTML_ENTITIES, INVALID_CHARREFS, LEGACY_ENTITIES } from "./htmlEntities";
import { PY_SPACE, pyLstrip, pySplitlines } from "./pystr";

const LINE_END = new RegExp(`</p>[${PY_SPACE}]*|<br[${PY_SPACE}]*/?>`, "i");
const TAG = /<[^>]*>/g;

export function toHtml(text: string): string {
  return pySplitlines(text)
    .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
    .join("\n");
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

const invalidCodepoint = (n: number): boolean =>
  (n >= 1 && n <= 8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f) || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;

const entity = (name: string): string | undefined => (Object.hasOwn(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : undefined);

export function htmlUnescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(CHARREF, (_all, ref: string) => {
    if (ref.startsWith("#")) {
      const digits = ref.slice(1).replace(/;$/, "");
      const n = digits[0] === "x" || digits[0] === "X" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
      const remapped = Object.hasOwn(INVALID_CHARREFS, n) ? INVALID_CHARREFS[n] : undefined;
      if (remapped !== undefined) return remapped;
      if ((n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) return "�";
      if (invalidCodepoint(n)) return "";
      return String.fromCodePoint(n);
    }
    const whole = ref.endsWith(";") ? entity(ref.slice(0, -1)) : LEGACY_ENTITIES.has(ref) ? entity(ref) : undefined;
    if (whole !== undefined) return whole;
    const chars = [...ref];
    for (let x = chars.length - 1; x > 1; x--) {
      const head = chars.slice(0, x).join("");
      if (LEGACY_ENTITIES.has(head)) return (entity(head) ?? "") + chars.slice(x).join("");
    }
    return `&${ref}`;
  });
}

export function toLines(content: string): string[] {
  if (!pyLstrip(content).startsWith("<")) return pySplitlines(content);
  const lines = content.split(LINE_END).map((part) => htmlUnescape(part.replace(TAG, "")));
  return lines.length > 0 && !lines[lines.length - 1] ? lines.slice(0, -1) : lines;
}

const KEEP: Readonly<Record<string, string>> = {
  p: "p", br: "br", strong: "strong", b: "strong", em: "em", i: "em", u: "u", s: "s", strike: "s", del: "s",
  code: "code", pre: "pre", blockquote: "blockquote", ul: "ul", ol: "ol", li: "li", h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6", a: "a",
};
const VOID = new Set(["br"]);
const BLOCK = new Set(["p", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "noscript", "textarea", "select", "title", "head"]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt|nbsp|tab|newline);?/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16) || 0xfffd);
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10) || 0xfffd);
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", tab: "\t", newline: "\n" } as Record<string, string>)[lower] ?? "";
  });
}

const escapeAttr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function safeHref(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const decoded = decodeEntities(raw).trim();
  const probe = decoded.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
  return /^(https?:\/\/|mailto:)/.test(probe) ? decoded : null;
}

type Tag = { end: number; name: string; closing: boolean; attrs: Map<string, string> };

function readTag(html: string, at: number): Tag | null {
  const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(at, at + 64));
  if (!head) return null;
  let i = at + head[0].length;
  const attrs = new Map<string, string>();
  while (i < html.length) {
    while (i < html.length && /\s|\//.test(html[i]!)) i++;
    if (html[i] === ">") return { end: i + 1, name: head[2]!.toLowerCase(), closing: head[1] === "/", attrs };
    const name = /^[^\s=>/]+/.exec(html.slice(i));
    if (!name) break;
    i += name[0].length;
    let value = "";
    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (html[i] === "=") {
      i++;
      while (i < html.length && /\s/.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, close < 0 ? html.length : close);
        i = close < 0 ? html.length : close + 1;
      } else {
        const bare = /^[^\s>]*/.exec(html.slice(i))![0];
        value = bare;
        i += bare.length;
      }
    }
    attrs.set(name[0].toLowerCase(), value);
  }
  return { end: html.length, name: head[2]!.toLowerCase(), closing: head[1] === "/", attrs };
}

export function sanitizeHtml(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let row: { depth: number; cells: number } | null = null;
  const endRow = (): void => {
    if (!row) return;
    while (open.length > row.depth) out.push(`</${open.pop()}>`);
    row = null;
  };
  const startRow = (): void => {
    endRow();
    row = { depth: open.length, cells: 0 };
    out.push("<p>");
    open.push("p");
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (DROP.has(tag.name)) {
      if (!tag.closing) {
        const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
        const gt = close < 0 ? -1 : html.indexOf(">", close);
        i = gt < 0 ? html.length : gt + 1;
      }
      continue;
    }
    if (tag.name === "img") {
      if (!tag.closing) out.push("[image]");
      continue;
    }
    if (tag.name === "tr" || tag.name === "table") {
      if (tag.closing || tag.name === "table") endRow();
      else startRow();
      continue;
    }
    if (tag.name === "td" || tag.name === "th") {
      if (tag.closing) continue;
      if (!row) startRow();
      while (open.length > row!.depth + 1) out.push(`</${open.pop()}>`);
      if (row!.cells++ > 0) out.push(" | ");
      continue;
    }
    const kept = KEEP[tag.name];
    if (!kept || (row && BLOCK.has(kept))) continue;
    if (tag.closing) {
      const at = open.lastIndexOf(kept);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (VOID.has(kept)) {
      out.push(`<${kept}>`);
      continue;
    }
    if (kept === "a") {
      const href = safeHref(tag.attrs.get("href"));
      if (href === null) continue;
      out.push(`<a href="${escapeAttr(href)}" rel="noopener noreferrer">`);
    } else out.push(`<${kept}>`);
    open.push(kept);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("");
}
