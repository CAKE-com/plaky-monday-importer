type IsoStamp = { year: number; month: number; day: number; hour: number; minute: number; second: number; micro?: number; offset: number | null; offsetMicro?: number };

function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const shifted = z + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0);

const epochOf = (s: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number =>
  daysFromCivil(s.year, s.month, s.day) * 86400 + s.hour * 3600 + s.minute * 60 + s.second;

function fieldsOf(epoch: number): IsoStamp {
  const days = Math.floor(epoch / 86400);
  const rest = epoch - days * 86400;
  const [year, month, day] = civilFromDays(days);
  return { year, month, day, hour: Math.floor(rest / 3600), minute: Math.floor((rest % 3600) / 60), second: rest % 60, offset: null };
}

function inRange(s: IsoStamp): IsoStamp {
  if (s.year < 1 || s.year > 9999) throw new RangeError("date value out of range");
  return s;
}

const digit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

function digits(text: string, at: number, n: number): { value: number; at: number } | null {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const c = text[at + i];
    if (!digit(c)) return null;
    value = value * 10 + Number(c);
  }
  return { value, at: at + n };
}

function separatorAt(s: string): number {
  if (s.length === 7) return 7;
  if (s[4] === "-") {
    if (s[5] === "W") {
      if (s.length > 8 && s[8] === "-") {
        if (s.length === 9) return -1;
        return s.length > 10 && digit(s[10]) ? 8 : 10;
      }
      return 8;
    }
    return 10;
  }
  if (s[4] === "W") {
    let idx = 7;
    while (idx < s.length && digit(s[idx])) idx++;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

const mod7 = (n: number): number => ((n % 7) + 7) % 7;

function isoWeekDate(year: number, week: number, day: number): [number, number, number] | null {
  if (week <= 0 || week >= 53) {
    const firstWeekday = mod7(daysFromCivil(year, 1, 1) + 3);
    if (!(week === 53 && (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))))) return null;
  }
  if (day <= 0 || day >= 8) return null;
  const jan1 = daysFromCivil(year, 1, 1);
  const weekday = mod7(jan1 + 3);
  const monday1 = jan1 - weekday + (weekday > 3 ? 7 : 0);
  return civilFromDays(monday1 + (week - 1) * 7 + (day - 1));
}

function parseDate(s: string): [number, number, number] | null {
  const y = digits(s, 0, 4);
  if (!y) return null;
  let at = y.at;
  const sep = s[at] === "-";
  if (sep) at++;
  if (s[at] === "W") {
    const w = digits(s, at + 1, 2);
    if (!w) return null;
    at = w.at;
    let weekday = 1;
    if (at < s.length) {
      if (sep && s[at++] !== "-") return null;
      const d = digits(s, at, 1);
      if (!d) return null;
      weekday = d.value;
    }
    return isoWeekDate(y.value, w.value, weekday);
  }
  const m = digits(s, at, 2);
  if (!m) return null;
  at = m.at;
  if (sep && s[at++] !== "-") return null;
  const d = digits(s, at, 2);
  return d ? [y.value, m.value, d.value] : null;
}

function parseClock(s: string, from: number, to: number): { hms: [number, number, number]; micro: number; extra: boolean } | null {
  const hms: [number, number, number] = [0, 0, 0];
  let p = from;
  let separated = true;
  for (let i = 0; i < 3; i++) {
    const v = digits(s, p, 2);
    if (!v) return null;
    hms[i] = v.value;
    p = v.at;
    const c = s[p++] ?? "\0";
    if (i === 0) separated = c === ":";
    if (p >= to) return { hms, micro: 0, extra: c !== "\0" };
    if (separated && c === ":") continue;
    if (c === "." || c === ",") break;
    if (!separated) p--;
    else return null;
  }
  const remains = to - p;
  const take = Math.min(remains, 6);
  const fraction = digits(s, p, take);
  if (!fraction) return null;
  p = fraction.at;
  while (digit(s[p])) p++;
  return { hms, micro: fraction.value * 10 ** (6 - take), extra: p < s.length };
}

export function fromIsoFormat(input: string): IsoStamp | null {
  const text = Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join("");
  if (text.length < 7) return null;
  const split = separatorAt(text);
  if (split < 0) return null;
  const date = parseDate(text.slice(0, split));
  if (!date) return null;
  const [year, month, day] = date;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let micro = 0;
  let offset: number | null = null;
  let offsetMicro = 0;
  if (text.length > split) {
    let at = split + 1;
    while ((text.charCodeAt(at) & 0xc0) === 0x80 && text.charCodeAt(split) >= 0x80) at++;
    const t = text.slice(at);
    const tz = t.search(/[Z+-]/);
    const end = tz < 0 ? t.length : tz;
    const clock = parseClock(t, 0, end);
    if (!clock) return null;
    [hour, minute, second] = clock.hms;
    micro = clock.micro;
    if (tz < 0) {
      if (clock.extra) return null;
    } else if (t[tz] === "Z") {
      if (tz + 1 !== t.length) return null;
      offset = 0;
    } else {
      const zone = parseClock(t, tz + 1, t.length);
      if (!zone || zone.extra) return null;
      const [zh, zm, zs] = zone.hms;
      const sign = t[tz] === "-" ? -1 : 1;
      offset = sign * (zh * 3600 + zm * 60 + zs);
      offsetMicro = offset === 0 ? 0 : sign * zone.micro;
    }
  }
  const valid =
    year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) &&
    hour <= 23 && minute <= 59 && second <= 59 && (offset === null || Math.abs(offset * 1e6 + offsetMicro) < 86400e6);
  return valid ? { year, month, day, hour, minute, second, micro, offset, offsetMicro } : null;
}

const p2 = (n: number): string => String(n).padStart(2, "0");
const stamp = (s: IsoStamp): string => `${String(s.year).padStart(4, "0")}-${p2(s.month)}-${p2(s.day)}T${p2(s.hour)}:${p2(s.minute)}:${p2(s.second)}`;

export function utcStamp(s: IsoStamp): string {
  const micros = epochOf(s) * 1e6 + (s.micro ?? 0) - (s.offset ?? 0) * 1e6 - (s.offsetMicro ?? 0);
  return `${stamp(inRange(fieldsOf(Math.floor(micros / 1e6))))}Z`;
}

function offsetText(offset: number): string {
  const sign = offset < 0 ? "-" : "+";
  const a = Math.abs(offset);
  return `${sign}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}${a % 60 ? `:${p2(a % 60)}` : ""}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(zone: string): Intl.DateTimeFormat | null {
  const known = formats.get(zone);
  if (known) return known;
  if (/^[+-]/.test(zone)) return null;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", era: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(zone, f);
    return f;
  } catch {
    return null;
  }
}

function offsetAt(f: Intl.DateTimeFormat, epoch: number): number {
  const d = new Date(0);
  d.setTime(epoch * 1000);
  const parts = f.formatToParts(d);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const bc = /^B/i.test(parts.find((p) => p.type === "era")?.value ?? "");
  const wall = epochOf({ year: bc ? 1 - part("year") : part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") });
  return wall - epoch;
}

export function toZone(utc: IsoStamp, zone: string): string | null {
  const f = zoneFormat(zone);
  if (!f) return null;
  const epoch = epochOf(utc) - (utc.offset ?? 0);
  const offset = offsetAt(f, epoch);
  return `${stamp(inRange(fieldsOf(epoch + offset)))}${offsetText(offset)}`;
}

export function attachZone(wall: IsoStamp, zone: string): string | null {
  const f = zoneFormat(zone);
  if (!f) return null;
  const local = epochOf(wall);
  const before = offsetAt(f, local - 86400);
  const after = offsetAt(f, local + 86400);
  const fits = (o: number): boolean => offsetAt(f, local - o) === o;
  const offset = fits(before) ? before : fits(after) ? after : before;
  return `${stamp(inRange(wall))}${offsetText(offset)}`;
}
