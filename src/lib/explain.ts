import { redactString } from "@/server/redact";

export type Explained = { text: string; technical: string | null };

export class Said extends Error {
  override name = "Said";
}

export const PLAKY_KEY_REFUSED = "Plaky did not accept the API key. Copy it again: in Plaky, your picture → Profile settings → API.";
export const MONDAY_TOKEN_REFUSED = "monday did not accept the API token. Copy it again: in monday, your picture → Developers → My access tokens.";

const PLAKY_NOUN: Record<string, string> = {
  spaces: "space", boards: "board", items: "item", "item-groups": "group", teams: "team", users: "user", comments: "comment", files: "file",
  fields: "field", reactions: "reaction",
};

function plakyThing(path: string): { noun: string; id: string | null; me: boolean } {
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  if (parts.includes("me")) return { noun: "user", id: null, me: true };
  for (let i = parts.length - 2; i >= 0; i--) {
    const noun = PLAKY_NOUN[parts[i]!];
    if (noun && /^\d+$/.test(parts[i + 1]!)) return { noun, id: parts[i + 1]!, me: false };
  }
  return { noun: "thing", id: null, me: false };
}

function plakySaid(body: string): string | null {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  if (!m) return null;
  try {
    return (JSON.parse(`"${m[1]}"`) as string).trim() || null;
  } catch {
    return m[1]!.trim() || null;
  }
}

function mondaySaid(json: string): string[] {
  const out = new Set<string>();
  for (const m of json.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) out.add(m[1]!.replace(/\\"/g, '"').trim());
  return [...out].filter(Boolean);
}

const quote = (said: string | null): string => (said ? `: “${said.replace(/[.\s]+$/, "")}”` : "");
const TRY_AGAIN = "Try again in a minute.";
const REPORT_IT = "If it keeps happening, report it on the project's GitHub issues with the technical details.";
const NOT_CONFIRMED = "may or may not have been made. Run again: only what is missing or different is written, so nothing is duplicated.";

function plakySentence(method: string, path: string, rest: string): string {
  const write = method !== "GET";
  const thing = plakyThing(path);
  const named = thing.id ? `${thing.noun} ${thing.id}` : `that ${thing.noun}`;
  const http = /^HTTP (\d{3})(?: ([\s\S]*))?$/.exec(rest);
  if (http) {
    const status = Number(http[1]);
    const said = plakySaid(http[2] ?? "");
    if (status === 401 || (status === 403 && thing.me)) return PLAKY_KEY_REFUSED;
    if (status === 403) return `This Plaky key has no access to ${named}${quote(said)}.`;
    if (status === 404) {
      return thing.noun === "space" && thing.id
        ? `Plaky has no space ${thing.id}: it was deleted, or this key belongs to another workspace.`
        : `Plaky has no ${named} any more: it was deleted, or moved to another space.`;
    }
    if (status >= 500) return write ? `Plaky had a problem on its side (HTTP ${status}) and did not confirm the change; it ${NOT_CONFIRMED}` : `Plaky had a problem on its side (HTTP ${status}). ${TRY_AGAIN}`;
    return `Plaky refused ${write ? "the change" : "the request"} (HTTP ${status})${quote(said)}.`;
  }
  if (/^429 after \d+ retries$/.test(rest)) return "Plaky kept asking to slow down (its rate limit). Try again in a few minutes.";
  if (rest === "TimeoutError") return write ? `Plaky did not answer within 60 seconds; the change ${NOT_CONFIRMED}` : `Plaky did not answer within 60 seconds. ${TRY_AGAIN}`;
  const after = /^TimeoutError after (\d+) s$/.exec(rest);
  if (after) return write ? `Plaky did not answer within ${after[1]} seconds; the change ${NOT_CONFIRMED}` : `Plaky did not answer within ${after[1]} seconds. ${TRY_AGAIN}`;
  if (/^\w*Error$/.test(rest)) return write ? `Plaky could not be reached; the change ${NOT_CONFIRMED}` : "Plaky could not be reached: check this computer's internet connection, then try again.";
  return write
    ? `Plaky's answer could not be read (cut off, or not in the expected form); the change ${NOT_CONFIRMED} ${REPORT_IT}`
    : `Plaky's answer could not be read (cut off, or not in the expected form). ${TRY_AGAIN} ${REPORT_IT}`;
}

function mondaySentence(rest: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^HTTP (\d{3}): ([\s\S]*)$/.exec(rest))) {
    const status = Number(m[1]);
    if (status === 401 || status === 403 || /not authenticated/i.test(m[2]!)) return MONDAY_TOKEN_REFUSED;
    if (status === 429) return "monday kept asking to slow down (its rate limit). Try again in a few minutes.";
    if (status >= 500) return `monday had a problem on its side (HTTP ${status}). ${TRY_AGAIN}`;
    return `monday refused the request (HTTP ${status}).`;
  }
  if ((m = /^GraphQL error: ([\s\S]*)$/.exec(rest))) {
    if (/NOT_AUTHENTICATED|not authenticated|USER_UNAUTHORIZED/i.test(m[1]!)) return MONDAY_TOKEN_REFUSED;
    if (/COMPLEXITY|RATE_LIMIT|Rate Limit|maxConcurrency/i.test(m[1]!)) return "monday is busy and asked to slow down. Try again in a few minutes.";
    const said = mondaySaid(m[1]!);
    return `monday refused the query${said.length ? `: “${said.join("; ").replace(/[.\s]+$/, "")}”` : ""}.`;
  }
  if ((m = /^transport error: (\w+)$/.exec(rest))) {
    return m[1] === "TimeoutError" ? `monday did not answer within 60 seconds. ${TRY_AGAIN}` : "monday could not be reached: check this computer's internet connection, then try again.";
  }
  if ((m = /^board (\d+) not found or not accessible$/.exec(rest))) return `monday has no board ${m[1]} any more, or this token cannot see it.`;
  if (rest === "retries exhausted") return `monday did not answer after several tries. ${TRY_AGAIN}`;
  if (/^refused the query as too large/.test(rest)) return `monday refused the query as too large for now. ${TRY_AGAIN}`;
  return `monday's answer could not be read (it may be down for maintenance). Try again in a few minutes. ${REPORT_IT}`;
}

const TAIL = String.raw`([\s\S]*?)(?=\)(?:[;,.]|$)|$)`;
const PLAKY = new RegExp(String.raw`\b(GET|POST|PUT|PATCH|DELETE) (/v1/\S*): ${TAIL}`, "g");
const MONDAY = new RegExp(String.raw`\bmonday\.com:? ${TAIL}`, "g");
const PAGING = /\bpaging exceeded (\d+) pages/g;
const DOWNLOAD = /\bdownloading (.+?) from monday failed: (\w+)/g;
const downloadSentence = (name: string, why: string): string => {
  const what = /^\d{3}$/.test(why) ? `it answered HTTP ${why}` : why === "TimeoutError" ? "it did not answer within 2 minutes" : "it could not be reached";
  return `monday's file server did not hand over ${name} (${what}, three tries). Run again: the files already copied are skipped`;
};
const WITHHELD = /\[database query withheld\]/g;
const PYTHONISH = /\b(?:KeyError|ValueError|IndexError|AttributeError|RangeError|ReferenceError|TypeError): [\s\S]*?(?=\)(?:[;,.]|$)|$)/g;
const CLI_FLAG = /,? or (?:pass|use|run with) --[a-z][\w-]*[^.;)]*/g;
const DATABASE = "this computer's database could not be read or written. Try again; if it keeps happening, restart the app.";

const CLIENT_SIDE: Array<[RegExp, string]> = [
  [/^(?:TypeError: )?(?:Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.?)$/i, "This app's server did not answer. Is it still running? Reload the page once it is."],
  [/^Unable to transform response from server$/, "This app refused the request. Open it at the address it was started on (for example http://localhost:3001), then reload."],
  [/^(?:SyntaxError: )?(?:Unexpected token\b[\s\S]*(?:is not valid JSON|in JSON)|Unexpected end of JSON input|JSON\.parse: [\s\S]*)$/, "This app's server sent an answer the page could not read (it may be restarting). Reload the page."],
  [/^Unknown error$/, "The connection to this app's server was lost. It reconnects on its own; reload the page if it does not."],
];

function zodIssues(text: string): string | null {
  if (!text.trimStart().startsWith("[")) return null;
  try {
    const issues = JSON.parse(text) as unknown;
    if (!Array.isArray(issues) || !issues.length) return null;
    const said = issues.map((i) => (i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string" ? (i as { message: string }).message : null));
    if (said.some((s) => s === null)) return null;
    const text2 = [...new Set(said as string[])].join("; ");
    return text2.charAt(0).toUpperCase() + text2.slice(1) + (/[.!?]$/.test(text2) ? "" : ".");
  } catch {
    return null;
  }
}

export function explainMessage(raw: string): Explained {
  const technical = redactString(raw);
  const typeProblem = /^(.+?) -> '([^']+)': expected [A-Z_]+, got [A-Z_]+; monday \w+ values cannot be stored there\. In Plaky: on the '[^']+' header open the ⌄ menu -> Change field type -> (.+?) -> Convert\.$/.exec(technical);
  if (typeProblem) return { text: `${typeProblem[1]}: in Plaky, “${typeProblem[2]}” → ⌄ → Change field type → ${typeProblem[3]} → Convert.`, technical };
  const typeWarning = /^(.+?) -> '([^']+)' is (.+?), not (.+?): carried, but as .+?\. In Plaky: on the '[^']+' header open the ⌄ menu -> Change field type -> (.+?) -> Convert\.$/.exec(technical);
  if (typeWarning) return { text: `${typeWarning[1]}: moves as ${typeWarning[3]}. Optional: in Plaky, “${typeWarning[2]}” → ⌄ → Change field type → ${typeWarning[5]} → Convert.`, technical };
  const unit = /^'(.+)' shows the unit (.+) on the (left|right)\.$/.exec(technical);
  if (unit) return { text: `Set “${unit[1]}” unit to ${unit[2]} (${unit[3]}).`, technical: null };
  for (const [pattern, sentence] of CLIENT_SIDE) if (pattern.test(raw.trim())) return { text: sentence, technical };
  const issues = zodIssues(raw);
  if (issues) return { text: issues, technical };
  const fence = (sentence: string): string => `\u0001${sentence}\u0002`;
  const opened = (rest: string): boolean => (rest.match(/\(/g)?.length ?? 0) > (rest.match(/\)/g)?.length ?? 0);
  const fenceRaw = (sentence: string, rest: string): string => (opened(rest) ? `\u0001${sentence}\u0003` : fence(sentence));
  const text = technical
    .replace(PLAKY, (_, method: string, path: string, rest: string) => fenceRaw(plakySentence(method, path, rest.trim()), rest))
    .replace(MONDAY, (_, rest: string) => fenceRaw(mondaySentence(rest.trim()), rest))
    .replace(/\u0003\)?/g, "\u0002")
    .replace(DOWNLOAD, (_, name: string, why: string) => fence(downloadSentence(name, why)))
    .replace(PAGING, (_, n: string) => fence(`Plaky kept returning more pages than this app reads (over ${n}). ${REPORT_IT}`))
    .replace(WITHHELD, fence(DATABASE))
    .replace(PYTHONISH, fence(`this app hit an unexpected internal error. ${REPORT_IT}`))
    .replace(CLI_FLAG, "")
    .replace(/ \(\u0001([\s\S]*?)\u0002\)/g, ": $1")
    .replace(/[\u0001\u0002]/g, "");
  if (text === technical) return { text: technical, technical: null };
  const tidy = (/^monday\b/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1)).replace(/\.([;,])/g, "$1").replace(/\.\.$/, ".");
  return { text: tidy, technical };
}
