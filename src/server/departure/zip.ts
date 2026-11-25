import { open, type FileHandle } from "node:fs/promises";

type ZipState = { state: "open" | "finished" | "failed" | "closed" }
  | { state: "writing" | "finishing" | "closing"; done: Promise<void> };

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export class DepartureZip {
  private current: ZipState = { state: "open" };
  get state(): ZipState["state"] { return this.current.state; }
  private offset = 0;
  private centralBytes = 22;
  private entries: { name: Buffer; size: number; crc: number; offset: number }[] = [];
  private names = new Set<string>();
  private constructor(private file: FileHandle) {}
  static async create(path: string): Promise<DepartureZip> {
    return new DepartureZip(await open(path, "wx", 0o600));
  }
  private assertOpen(): void {
    if (this.current.state !== "open") throw new Error(`Archive is not open (${this.current.state})`);
  }
  private async perform(state: "writing" | "finishing", work: () => Promise<void>): Promise<void> {
    this.assertOpen();
    let release!: () => void;
    const pending = { state, done: new Promise<void>((resolve) => { release = resolve; }) };
    this.current = pending;
    try {
      await work();
      if (this.current === pending) this.current = { state: state === "finishing" ? "finished" : "open" };
    } catch (error) {
      if (this.current === pending) this.current = { state: "failed" };
      throw error;
    } finally { release(); }
  }
  private async write(data: Uint8Array): Promise<void> {
    let at = 0;
    while (at < data.length) {
      const { bytesWritten } = await this.file.write(data, at, data.length - at, this.offset);
      if (!bytesWritten) throw new Error("Archive storage stopped accepting data");
      at += bytesWritten; this.offset += bytesWritten;
    }
  }
  async add(path: string, data: Uint8Array): Promise<void> {
    this.assertOpen();
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some((p) => !p || p === "..") || this.names.has(path)) throw new Error("Invalid archive entry");
    const name = Buffer.from(path);
    if (this.entries.length >= 65534 || name.length > 65535 || this.offset + data.length + 2 * name.length + 76 + this.centralBytes >= 0xffffffff) throw new Error("Archive exceeds ZIP capacity; split this migration into smaller board sets and export each");
    return this.perform("writing", async () => {
      const entry = { name, size: data.length, crc: crc32(data), offset: this.offset };
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(33, 12);
      h.writeUInt32LE(entry.crc, 14); h.writeUInt32LE(entry.size, 18); h.writeUInt32LE(entry.size, 22); h.writeUInt16LE(name.length, 26);
      await this.write(h); await this.write(name); await this.write(data);
      this.entries.push(entry); this.names.add(path);
      this.centralBytes += 46 + name.length;
    });
  }
  async finish(): Promise<void> {
    return this.perform("finishing", async () => {
      const start = this.offset;
      for (const e of this.entries) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(33, 14);
        h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.size, 20); h.writeUInt32LE(e.size, 24); h.writeUInt16LE(e.name.length, 28); h.writeUInt32LE(e.offset, 42);
        await this.write(h); await this.write(e.name);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
      await this.write(end);
      await this.file.sync();
    });
  }
  async close(): Promise<void> {
    if (this.current.state === "closed") return;
    if (this.current.state === "closing") return this.current.done;
    const pending = "done" in this.current ? this.current.done : Promise.resolve();
    const done = (async () => { await pending; await this.file.close(); })();
    this.current = { state: "closing", done };
    try { await done; }
    finally { this.current = { state: "closed" }; }
  }
}
