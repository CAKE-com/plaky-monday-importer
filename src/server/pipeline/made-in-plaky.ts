import { isPlakyNotFound, type PlakyClient, type PlakyComment, type PlakyItem } from "../clients/plaky";
import { markerOf } from "./transform/comments";

type PlakyWork = { comments: number; files: number };
type RowAt = { space: number; board: number };
export type OurFiles = (plakyItemId: number) => Promise<ReadonlySet<number>>;
type Counted = { id: number; commentCount?: number | null | undefined; fileCount?: number | null | undefined };

const everyComment = (comments: readonly PlakyComment[]): PlakyComment[] => comments.flatMap((c) => [c, ...everyComment(c.replies ?? [])]);

export async function plakyWork(plaky: PlakyClient, at: RowAt, row: Counted, ourFiles: OurFiles): Promise<PlakyWork> {
  const comments = row.commentCount === 0 ? 0 : everyComment(await plaky.listItemComments(at.space, at.board, row.id))
    .filter((c) => !c.deleted && markerOf(String(c.content ?? "")) === null).length;
  let files = 0;
  if (row.fileCount !== 0) {
    const listed = await plaky.listItemFiles(at.space, at.board, row.id);
    if (listed.length) {
      const ours = await ourFiles(row.id);
      files = listed.filter((f) => !ours.has(Number(f.id))).length;
    }
  }
  return { comments, files };
}

export const worked = (work: PlakyWork): boolean => work.comments + work.files > 0;

const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const workText = (work: PlakyWork, nestedTitle?: string): string =>
  `people added ${[work.comments ? counted(work.comments, "comment") : "", work.files ? counted(work.files, "file") : ""].filter(Boolean).join(" and ")} in Plaky${nestedTitle === undefined ? "" : ` to its nested row '${nestedTitle}'`}`;

type DeleteCheck = { why: string[]; work: PlakyWork; subitemsBehaviour: "INCLUDE" | "EXCLUDE" };

export async function checkBeforeDelete(plaky: PlakyClient, at: RowAt, rowId: number, o: { ourFiles: OurFiles; ourNested: (row: PlakyItem) => boolean }): Promise<DeleteCheck> {
  const work = await plakyWork(plaky, at, { id: rowId }, o.ourFiles);
  const why = worked(work) ? [workText(work)] : [];
  const listed = (await plaky.collect((page) => plaky.listItems(at.space, at.board, { parentId: rowId, subitemsBehaviour: "INCLUDE", page, pageSize: 1000 }))).filter((n) => !n.deleted);
  const nested = listed.filter((n) => !n.archived);
  const foreign = nested.filter((n) => !o.ourNested(n)).length;
  if (foreign) why.push(`it holds ${foreign} nested row(s) this migration did not write`);
  if (listed.length > nested.length) why.push(`it holds ${listed.length - nested.length} archived nested row(s)`);
  const total = { ...work };
  for (const n of nested) {
    if (!o.ourNested(n)) continue;
    let own: PlakyWork;
    try {
      own = await plakyWork(plaky, at, { id: Number(n.id) }, o.ourFiles);
    } catch (error) {
      if (isPlakyNotFound(error)) continue;
      throw error;
    }
    if (!worked(own)) continue;
    why.push(workText(own, n.title ?? ""));
    total.comments += own.comments;
    total.files += own.files;
  }
  return { why, work: total, subitemsBehaviour: listed.length ? "INCLUDE" : "EXCLUDE" };
}
