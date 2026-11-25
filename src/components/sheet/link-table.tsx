import { Cell, Explain, Grid, Mark, Note, Row, Status } from "./bits";

type LinkPreviewView = {
  links: { mondayBoardId: string; name: string; plakyBoardId: number; plakyTitle?: string | null; paired: number; unmatched: string[]; warnings: string[]; seedRows: number; ready: boolean; subitemsOf: string | null }[];
  missing: { id: string; name: string }[];
  gone?: { id: string }[];
  hints?: { id: string; text: string }[];
  blocking: string[];
  peopleWarnings: string[];
  wanted: number;
  needsConfirm: boolean;
  changes: string[] | null;
};

export function LinkTable({ preview }: { preview: LinkPreviewView }) {
  const gone = new Set((preview.gone ?? []).map((g) => g.id));
  const hints = preview.hints ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="link-table">
      <p className="text-sm" data-testid="link-found">{preview.links.length} of {preview.wanted} board(s) found in Plaky; {preview.missing.length} still to import.</p>
      <Grid head={["monday board", "Plaky board", "Fields paired", "Status"]} align={["left", "left", "right", "left"]} label="Board links, monday to Plaky">
        {preview.links.map((l) => (
          <Row key={l.mondayBoardId}>
            <Cell>{l.name}</Cell>
            <Cell>#{l.plakyBoardId}</Cell>
            <Cell right>{l.paired}</Cell>
            <Cell className="text-[15px]">
              {l.ready ? <Status kind="done">ready</Status> : <Status kind="flag"><strong>blocked</strong></Status>}
              {l.unmatched.map((u, i) => <div key={`${i}:${u}`} className="mt-1 flex items-start gap-2"><Mark kind="flag" /><span><Explain text={u} /></span></div>)}
              {l.warnings.map((w, i) => <div key={`${i}:${w}`} className="mt-1 flex items-start gap-2"><Mark kind="now" /><span><Explain text={w} /></span></div>)}
              {l.seedRows ? <div className="mt-1 text-cake-muted">{l.seedRows} example row(s) removed on link</div> : null}
            </Cell>
          </Row>
        ))}
        {preview.missing.map((m) => (
          <Row key={m.id}><Cell>{m.name}</Cell><Cell className="text-cake-muted">{hints.some((h) => h.id === m.id) ? hints.filter((h) => h.id === m.id).map((h) => <div key={h.text}><Explain text={h.text} /></div>) : gone.has(m.id) ? "Deleted: import its setup file again." : "Import its setup file in Plaky."}</Cell><Cell /><Cell /></Row>
        ))}
      </Grid>
      {preview.blocking.map((b) => <div key={b} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></div>)}
      {preview.peopleWarnings.map((b) => <Note key={b}>{b}</Note>)}
      {preview.changes?.map((c) => <Note key={c}>Re-link change: {c}</Note>)}
    </div>
  );
}
