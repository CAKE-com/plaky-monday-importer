import { createHash } from "node:crypto";
import type { ExtractedUpdate } from "../extract";
import { fromIsoFormat, utcStamp } from "./isotime";
import { asciiDigits, isDecimalStr, pySplit, pyStrip } from "./pystr";
import { cmpCodePoints } from "./pyvalue";
import { sanitizeHtml, toHtml, toLines } from "./richtext";

export const MAX_COMMENTS_PER_ITEM = 2000;

const MARKER = /^\[monday (update|reply|links) (\p{Nd}+)\]/u;

export type MondayUpdate = ExtractedUpdate;

function updateKind(update: MondayUpdate): "update" | "reply" {
  return update.parentId ? "reply" : "update";
}

export type PlannedComment = {
  kind: "update" | "reply" | "links";
  mondayId: string;
  text: string;
  replyTo: string | null;
};

export const linksCommentId = (mondayItemId: string): string => `links:${mondayItemId}`;

export type LinkEntry = { name: string; url: string };

export function renderLinks(mondayItemId: string, links: readonly LinkEntry[], rich = false): string {
  const header = `[monday links ${mondayItemId}] ${links.length} link${links.length === 1 ? "" : "s"} from monday's file column${links.length === 1 ? "" : "s"} (#${linksDigest(links)})`;
  const lines = links.map((l) => `${pyStrip(l.name) || "link"}: ${l.url}`);
  if (!rich) return toHtml([header, "", ...lines].join("\n"));
  const items = links.map((l) => `<p>${escapeText(pyStrip(l.name) || "link")}: <a href="${escapeText(l.url)}">${escapeText(l.url)}</a></p>`).join("\n");
  return [toHtml(header), "<p></p>", sanitizeHtml(items)].join("\n");
}

function linksDigest(links: readonly LinkEntry[]): string {
  const pairs = links.map((l) => JSON.stringify([pyStrip(l.name) || "link", l.url])).sort(cmpCodePoints);
  return createHash("sha256").update(pairs.join("\n")).digest("hex").slice(0, 8);
}

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function commentHeader(comment: PlannedComment): string {
  return headerOf(comment.text);
}

export function stamp(value: string | null | undefined, seconds = false): string | null {
  if (!value) return null;
  const parsed = fromIsoFormat(value.replaceAll("Z", "+00:00"));
  if (!parsed) return value;
  const utc = utcStamp(parsed);
  return `${utc.slice(0, 10)} ${utc.slice(11, seconds ? 19 : 16)}`;
}

export function render(update: MondayUpdate, filesCarried = false, rich = false): string {
  const created = stamp(update.createdAt);
  let header = `[monday ${updateKind(update)} ${update.id}] ${update.author || "unknown"}`;
  if (created) header += `, ${created} UTC`;
  const edited = stamp(update.editedAt, true);
  if (edited && edited !== stamp(update.createdAt, true)) header += ` (edited ${edited} UTC)`;
  if (update.pinned) header += " (pinned)";
  const lines = [header, "", pyStrip(update.text) || "(no text)"];
  const attachments = update.assets.length && !filesCarried ? `Attachments not carried: ${update.assets.map(([, name]) => name).join(", ")}` : null;
  if (attachments) lines.push("", attachments);
  const body = rich && update.body ? sanitizeHtml(update.body) : "";
  if (!body.replace(/<[^>]*>/g, "").replace(/\ufeff/g, "").trim()) return toHtml(lines.join("\n"));
  return [toHtml(header), "<p></p>", body, ...(attachments ? ["<p></p>", toHtml(attachments)] : [])].join("\n");
}

export function headerOf(content: string): string {
  const first = toLines(content || "").find((line) => pyStrip(line)) ?? "";
  return pySplit(first).join(" ");
}

export function markerOf(content: string): ["update" | "reply" | "links", string] | null {
  const match = MARKER.exec(headerOf(content));
  return match ? [match[1] as "update" | "reply" | "links", match[2]!] : null;
}

export const markerKey = (marker: readonly ["update" | "reply" | "links", string]): string => (marker[0] === "links" ? linksCommentId(marker[1]) : marker[1]);

function byAge(a: MondayUpdate, b: MondayUpdate): number {
  const created = cmpCodePoints(a.createdAt || "", b.createdAt || "");
  if (created) return created;
  const [x, y] = [a, b].map((u) => (isDecimalStr(u.id) ? BigInt(asciiDigits(u.id)) : 0n)) as [bigint, bigint];
  return x < y ? -1 : x > y ? 1 : 0;
}

export function planItemComments(updates: readonly MondayUpdate[], filesCarried = false, rich = false): PlannedComment[] {
  const top = updates.filter((u) => !u.parentId).sort(byAge);
  const replies = new Map<string, MondayUpdate[]>();
  for (const update of updates) {
    if (update.parentId) replies.set(update.parentId, [...(replies.get(update.parentId) ?? []), update]);
  }
  const planned: PlannedComment[] = [];
  for (const update of top) {
    planned.push({ kind: "update", mondayId: update.id, text: render(update, filesCarried, rich), replyTo: null });
    for (const reply of [...(replies.get(update.id) ?? [])].sort(byAge)) {
      planned.push({ kind: "reply", mondayId: reply.id, text: render(reply, filesCarried, rich), replyTo: update.id });
    }
  }
  return planned;
}
