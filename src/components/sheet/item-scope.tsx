"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";
import type { ItemFilter } from "@/server/pipeline/scope";
import type { AppRouter } from "@/server/trpc/router";
import type { inferRouterOutputs } from "@trpc/server";
import { Block, fieldClass, Go, Note, Plain, Problem, useMigrationId } from "./bits";
import { NeedsLink } from "./link-first";

type ScopeBoard = inferRouterOutputs<AppRouter>["link"]["scope"]["boards"][number];

const toggled = (list: readonly string[], value: string, on: boolean): string[] => (on ? [...list, value] : list.filter((v) => v !== value));

export function ItemScope({ params }: { params: Promise<{ id: string }> }) {
  const migrationId = useMigrationId(params);
  return (
    <Block level={1} title="Which items move">
      <NeedsLink migrationId={migrationId}><ScopeBoards migrationId={migrationId} /></NeedsLink>
    </Block>
  );
}

function ScopeBoards({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const scope = useQuery(trpc.link.scope.queryOptions({ migrationId }));
  return (
    <>
      <Note>Items must match all selected filters. Blank filters allow everything. Subitems follow their parent; existing Plaky items stay.</Note>
      <Problem error={scope.error} title="Could not read the boards" />
      {scope.isPending ? <Note>Reading monday…</Note> : null}
      {scope.data?.boards.map((board) => <BoardScope key={`${board.mondayBoardId}:${JSON.stringify(board.filter)}`} migrationId={migrationId} board={board} />)}
    </>
  );
}

function offered(board: ScopeBoard): { groups: string[]; statusColumn: string; labels: string[]; dateColumn: string; gone: number } {
  const f = board.filter;
  const groups = (f?.groups ?? []).filter((id) => board.groups.some((g) => g.id === id));
  const status = board.statuses.find((s) => s.id === f?.status?.columnId);
  const labels = (f?.status?.labels ?? []).filter((l) => status?.labels.includes(l));
  const dateColumn = board.dates.some((d) => d.id === f?.date?.columnId) ? f!.date!.columnId : "";
  const gone = (f?.groups?.length ?? 0) - groups.length + (f?.status?.labels.length ?? 0) - labels.length + (f?.date && !dateColumn ? 1 : 0);
  return { groups, statusColumn: status && labels.length ? status.id : "", labels, dateColumn, gone };
}

function BoardScope({ migrationId, board }: { migrationId: number; board: ScopeBoard }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stored = offered(board);
  const save = useMutation(trpc.link.setScope.mutationOptions({ onSuccess: async (_saved, { filter: next }) => {
    const key = trpc.link.scope.queryKey({ migrationId });
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData(key, (old) => (old ? { boards: old.boards.map((b) => (b.mondayBoardId === board.mondayBoardId ? { ...b, filter: Object.keys(next).length ? (next as ScopeBoard["filter"]) : null } : b)) } : old));
  } }));
  const [groups, setGroups] = useState<string[]>(stored.groups);
  const [statusColumn, setStatusColumn] = useState(stored.statusColumn);
  const [labels, setLabels] = useState<string[]>(stored.labels);
  const [dateColumn, setDateColumn] = useState(stored.dateColumn);
  const [from, setFrom] = useState(board.filter?.date?.from ?? "");
  const [to, setTo] = useState(board.filter?.date?.to ?? "");
  const status = board.statuses.find((s) => s.id === statusColumn);
  const filter: ItemFilter = {
    ...(groups.length ? { groups } : {}),
    ...(statusColumn && labels.length ? { status: { columnId: statusColumn, labels } } : {}),
    ...(dateColumn && (from || to) ? { date: { columnId: dateColumn, ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
  };
  const clear = (): void => save.mutate({ migrationId, mondayBoardId: board.mondayBoardId, filter: {} });
  return (
    <div className="flex flex-col gap-3" data-testid={`scope-${board.mondayBoardId}`}>
      <h2 className="text-[17px] font-medium">{board.name}</h2>
      <Note>{board.filter ? "Only the items matching this filter move." : "No filter: every item moves."}</Note>
      {stored.gone ? <Note>{stored.gone === 1 ? "One part of the saved filter is" : `${stored.gone} parts of the saved filter are`} no longer on this board. Saving drops {stored.gone === 1 ? "it" : "them"}; until then, nothing matches {stored.gone === 1 ? "it" : "them"}.</Note> : null}
      <Problem error={save.error} title="Could not save the filter" />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[15px] font-semibold">Groups</legend>
        {board.groups.map((g) => (
          <label key={g.id} className="flex items-center gap-2"><input type="checkbox" checked={groups.includes(g.id)} onChange={(e) => setGroups(toggled(groups, g.id, e.target.checked))} />{g.title}</label>
        ))}
      </fieldset>
      {board.statuses.length ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">Status
            <select aria-label="Status field" className={fieldClass} value={statusColumn} onChange={(e) => { setStatusColumn(e.target.value); setLabels([]); }}>
              <option value="">Any</option>
              {board.statuses.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </label>
          {status?.labels.map((l) => (
            <label key={l} className="flex items-center gap-2"><input type="checkbox" checked={labels.includes(l)} onChange={(e) => setLabels(toggled(labels, l, e.target.checked))} />{l}</label>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">Date
          <select aria-label="Date field" className={fieldClass} value={dateColumn} onChange={(e) => setDateColumn(e.target.value)}>
            <option value="">Any</option>
            {board.dates.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">from <input type="date" className={fieldClass} value={from} disabled={!dateColumn} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flex items-center gap-2">to <input type="date" className={fieldClass} value={to} disabled={!dateColumn} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Go disabled={save.isPending} onClick={() => save.mutate({ migrationId, mondayBoardId: board.mondayBoardId, filter })}>Save filter</Go>
        {board.filter ? <Plain disabled={save.isPending} onClick={clear}>Remove filter</Plain> : null}
      </div>
    </div>
  );
}
