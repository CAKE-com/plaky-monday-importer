const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const UTF8_NAMES = 0x0800;

export function zip(files: readonly { name: string; text: string }[], at: Date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(at);
  const entries = files.map((f) => {
    const name = encoder.encode(f.name);
    const data = encoder.encode(f.text);
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(new ArrayBuffer(localSize + centralSize + 22));
  const view = new DataView(out.buffer);
  let pos = 0;
  const u16 = (v: number): void => { view.setUint16(pos, v, true); pos += 2; };
  const u32 = (v: number): void => { view.setUint32(pos, v, true); pos += 4; };
  const bytes = (b: Uint8Array): void => { out.set(b, pos); pos += b.length; };

  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(pos);
    u32(0x04034b50); u16(20); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    bytes(e.name); bytes(e.data);
  }
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(offsets[i]!);
    bytes(e.name);
  });
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(centralSize); u32(localSize); u16(0);
  return out;
}
