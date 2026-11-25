export function cmpCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done) return q.done ? 0 : -1;
    if (q.done) return 1;
    const diff = p.value.codePointAt(0)! - q.value.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(cmpCodePoints);
}

const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}\p{Zs}]/u;

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch !== " " && NOT_PRINTABLE.test(ch)) {
      out += cp < 0x100 ? `\\x${cp.toString(16).padStart(2, "0")}` : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

export function strOf(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}
