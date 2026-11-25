import Decimal from "decimal.js";

type Dict = Record<string, unknown>;

export const isDict = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

export const truthy = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && v.length === 0) && !(isDict(v) && Object.keys(v).length === 0);

export const pyOr = (a: unknown, b: unknown): unknown => (truthy(a) ? a : b);

export const pyStr = (v: unknown): string =>
  v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : typeof v === "object" ? JSON.stringify(v) : String(v);

export const PY_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`);

export const pyStrip = (s: string): string => s.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
export const pyLstrip = (s: string): string => s.replace(LEADING_SPACE, "");
export const pySplit = (s: string): string[] => s.split(SPACE_RUN).filter(Boolean);

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
export function pySplitlines(s: string): string[] {
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const CASEFOLD_EXCEPTIONS = new Map<string, string>(
  "b5>3bc,df>73 73,149>2bc 6e,17f>73,1f0>6a 30c,345>3b9,390>3b9 308 301,3b0>3c5 308 301,3c2>3c3,3d0>3b2,3d1>3b8,3d5>3c6,3d6>3c0,3f0>3ba,3f1>3c1,3f5>3b5,587>565 582,13a0>13a0,13a1>13a1,13a2>13a2,13a3>13a3,13a4>13a4,13a5>13a5,13a6>13a6,13a7>13a7,13a8>13a8,13a9>13a9,13aa>13aa,13ab>13ab,13ac>13ac,13ad>13ad,13ae>13ae,13af>13af,13b0>13b0,13b1>13b1,13b2>13b2,13b3>13b3,13b4>13b4,13b5>13b5,13b6>13b6,13b7>13b7,13b8>13b8,13b9>13b9,13ba>13ba,13bb>13bb,13bc>13bc,13bd>13bd,13be>13be,13bf>13bf,13c0>13c0,13c1>13c1,13c2>13c2,13c3>13c3,13c4>13c4,13c5>13c5,13c6>13c6,13c7>13c7,13c8>13c8,13c9>13c9,13ca>13ca,13cb>13cb,13cc>13cc,13cd>13cd,13ce>13ce,13cf>13cf,13d0>13d0,13d1>13d1,13d2>13d2,13d3>13d3,13d4>13d4,13d5>13d5,13d6>13d6,13d7>13d7,13d8>13d8,13d9>13d9,13da>13da,13db>13db,13dc>13dc,13dd>13dd,13de>13de,13df>13df,13e0>13e0,13e1>13e1,13e2>13e2,13e3>13e3,13e4>13e4,13e5>13e5,13e6>13e6,13e7>13e7,13e8>13e8,13e9>13e9,13ea>13ea,13eb>13eb,13ec>13ec,13ed>13ed,13ee>13ee,13ef>13ef,13f0>13f0,13f1>13f1,13f2>13f2,13f3>13f3,13f4>13f4,13f5>13f5,13f8>13f0,13f9>13f1,13fa>13f2,13fb>13f3,13fc>13f4,13fd>13f5,1c80>432,1c81>434,1c82>43e,1c83>441,1c84>442,1c85>442,1c86>44a,1c87>463,1c88>a64b,1c89>1c89,1e96>68 331,1e97>74 308,1e98>77 30a,1e99>79 30a,1e9a>61 2be,1e9b>1e61,1e9e>73 73,1f50>3c5 313,1f52>3c5 313 300,1f54>3c5 313 301,1f56>3c5 313 342,1f80>1f00 3b9,1f81>1f01 3b9,1f82>1f02 3b9,1f83>1f03 3b9,1f84>1f04 3b9,1f85>1f05 3b9,1f86>1f06 3b9,1f87>1f07 3b9,1f88>1f00 3b9,1f89>1f01 3b9,1f8a>1f02 3b9,1f8b>1f03 3b9,1f8c>1f04 3b9,1f8d>1f05 3b9,1f8e>1f06 3b9,1f8f>1f07 3b9,1f90>1f20 3b9,1f91>1f21 3b9,1f92>1f22 3b9,1f93>1f23 3b9,1f94>1f24 3b9,1f95>1f25 3b9,1f96>1f26 3b9,1f97>1f27 3b9,1f98>1f20 3b9,1f99>1f21 3b9,1f9a>1f22 3b9,1f9b>1f23 3b9,1f9c>1f24 3b9,1f9d>1f25 3b9,1f9e>1f26 3b9,1f9f>1f27 3b9,1fa0>1f60 3b9,1fa1>1f61 3b9,1fa2>1f62 3b9,1fa3>1f63 3b9,1fa4>1f64 3b9,1fa5>1f65 3b9,1fa6>1f66 3b9,1fa7>1f67 3b9,1fa8>1f60 3b9,1fa9>1f61 3b9,1faa>1f62 3b9,1fab>1f63 3b9,1fac>1f64 3b9,1fad>1f65 3b9,1fae>1f66 3b9,1faf>1f67 3b9,1fb2>1f70 3b9,1fb3>3b1 3b9,1fb4>3ac 3b9,1fb6>3b1 342,1fb7>3b1 342 3b9,1fbc>3b1 3b9,1fbe>3b9,1fc2>1f74 3b9,1fc3>3b7 3b9,1fc4>3ae 3b9,1fc6>3b7 342,1fc7>3b7 342 3b9,1fcc>3b7 3b9,1fd2>3b9 308 300,1fd3>3b9 308 301,1fd6>3b9 342,1fd7>3b9 308 342,1fe2>3c5 308 300,1fe3>3c5 308 301,1fe4>3c1 313,1fe6>3c5 342,1fe7>3c5 308 342,1ff2>1f7c 3b9,1ff3>3c9 3b9,1ff4>3ce 3b9,1ff6>3c9 342,1ff7>3c9 342 3b9,1ffc>3c9 3b9,a7cb>a7cb,a7cc>a7cc,a7ce>a7ce,a7d2>a7d2,a7d4>a7d4,a7da>a7da,a7dc>a7dc,ab70>13a0,ab71>13a1,ab72>13a2,ab73>13a3,ab74>13a4,ab75>13a5,ab76>13a6,ab77>13a7,ab78>13a8,ab79>13a9,ab7a>13aa,ab7b>13ab,ab7c>13ac,ab7d>13ad,ab7e>13ae,ab7f>13af,ab80>13b0,ab81>13b1,ab82>13b2,ab83>13b3,ab84>13b4,ab85>13b5,ab86>13b6,ab87>13b7,ab88>13b8,ab89>13b9,ab8a>13ba,ab8b>13bb,ab8c>13bc,ab8d>13bd,ab8e>13be,ab8f>13bf,ab90>13c0,ab91>13c1,ab92>13c2,ab93>13c3,ab94>13c4,ab95>13c5,ab96>13c6,ab97>13c7,ab98>13c8,ab99>13c9,ab9a>13ca,ab9b>13cb,ab9c>13cc,ab9d>13cd,ab9e>13ce,ab9f>13cf,aba0>13d0,aba1>13d1,aba2>13d2,aba3>13d3,aba4>13d4,aba5>13d5,aba6>13d6,aba7>13d7,aba8>13d8,aba9>13d9,abaa>13da,abab>13db,abac>13dc,abad>13dd,abae>13de,abaf>13df,abb0>13e0,abb1>13e1,abb2>13e2,abb3>13e3,abb4>13e4,abb5>13e5,abb6>13e6,abb7>13e7,abb8>13e8,abb9>13e9,abba>13ea,abbb>13eb,abbc>13ec,abbd>13ed,abbe>13ee,abbf>13ef,fb00>66 66,fb01>66 69,fb02>66 6c,fb03>66 66 69,fb04>66 66 6c,fb05>73 74,fb06>73 74,fb13>574 576,fb14>574 565,fb15>574 56b,fb16>57e 576,fb17>574 56d,10d50>10d50,10d51>10d51,10d52>10d52,10d53>10d53,10d54>10d54,10d55>10d55,10d56>10d56,10d57>10d57,10d58>10d58,10d59>10d59,10d5a>10d5a,10d5b>10d5b,10d5c>10d5c,10d5d>10d5d,10d5e>10d5e,10d5f>10d5f,10d60>10d60,10d61>10d61,10d62>10d62,10d63>10d63,10d64>10d64,10d65>10d65,16ea0>16ea0,16ea1>16ea1,16ea2>16ea2,16ea3>16ea3,16ea4>16ea4,16ea5>16ea5,16ea6>16ea6,16ea7>16ea7,16ea8>16ea8,16ea9>16ea9,16eaa>16eaa,16eab>16eab,16eac>16eac,16ead>16ead,16eae>16eae,16eaf>16eaf,16eb0>16eb0,16eb1>16eb1,16eb2>16eb2,16eb3>16eb3,16eb4>16eb4,16eb5>16eb5,16eb6>16eb6,16eb7>16eb7,16eb8>16eb8"
    .split(",")
    .map((entry) => {
      const [cp = "", folded = ""] = entry.split(">");
      return [String.fromCodePoint(parseInt(cp, 16)), folded.split(" ").map((c) => String.fromCodePoint(parseInt(c, 16))).join("")];
    }),
);

export function casefold(s: string): string {
  let out = "";
  for (const ch of s) out += CASEFOLD_EXCEPTIONS.get(ch) ?? ch.toLowerCase();
  return out;
}

export const isAlnum = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

const DIGIT_ZEROS = "30,660,6f0,7c0,966,9e6,a66,ae6,b66,be6,c66,ce6,d66,de6,e50,ed0,f20,1040,1090,17e0,1810,1946,19d0,1a80,1a90,1b50,1bb0,1c40,1c50,a620,a8d0,a900,a9d0,a9f0,aa50,abf0,ff10,104a0,10d30,11066,110f0,11136,111d0,112f0,11450,114d0,11650,116c0,11730,118e0,11950,11c50,11d50,11da0,11f50,16a60,16ac0,16b50,1d7ce,1d7d8,1d7e2,1d7ec,1d7f6,1e140,1e2f0,1e4f0,1e950,1fbf0".split(",").map((h) => parseInt(h, 16));

export function asciiDigits(s: string): string {
  return [...s]
    .map((ch) => {
      if (!/^\p{Nd}$/u.test(ch)) return ch;
      const cp = ch.codePointAt(0) ?? 0;
      const zero = DIGIT_ZEROS.filter((z) => z <= cp && cp - z < 10).pop();
      return zero === undefined ? ch : String(cp - zero);
    })
    .join("");
}

export const isDecimalStr = (s: string): boolean => s.length > 0 && /^\p{Nd}+$/u.test(s);

export type PyDecimal = { kind: "num"; value: Decimal } | { kind: "inf" } | { kind: "nan" } | { kind: "snan" };

const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const DECIMAL_NAN = /^[+-]?s?nan\d*$/i;
const DECIMAL_INF = /^[+-]?inf(?:inity)?$/i;

export function pyDecimal(text: string): PyDecimal | null {
  const cleaned = asciiDigits(pyStrip(text)).replace(/_/g, "");
  if (DECIMAL_NUMBER.test(cleaned)) return { kind: "num", value: new Decimal(cleaned) };
  if (DECIMAL_INF.test(cleaned)) return { kind: "inf" };
  if (DECIMAL_NAN.test(cleaned)) return { kind: /s/i.test(cleaned) ? "snan" : "nan" };
  return null;
}

export type OrderedJson = null | boolean | number | string | OrderedJson[] | Map<string, OrderedJson>;

export function parseJsonOrdered(text: string): OrderedJson {
  let at = 0;
  const skip = () => {
    while (" \t\n\r".includes(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const value = (): OrderedJson => {
    skip();
    const c = text[at];
    if (c === "{") {
      const out = new Map<string, OrderedJson>();
      at++;
      skip();
      if (text[at] === "}") return at++, out;
      for (;;) {
        skip();
        const key = string();
        skip();
        at++;
        out.set(key, value());
        skip();
        if (text[at++] === "}") return out;
      }
    }
    if (c === "[") {
      const out: OrderedJson[] = [];
      at++;
      skip();
      if (text[at] === "]") return at++, out;
      for (;;) {
        out.push(value());
        skip();
        if (text[at++] === "]") return out;
      }
    }
    if (c === '"') return string();
    const start = at;
    while (at < text.length && !",]} \t\n\r".includes(text[at] ?? ",")) at++;
    return JSON.parse(text.slice(start, at)) as OrderedJson;
  };
  return value();
}
