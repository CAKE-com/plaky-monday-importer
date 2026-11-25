"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { migrationStatus } from "@/lib/labels";
import { useTRPC } from "@/lib/trpc";
import { normalizeWebAddress, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT, workspaceName } from "@/lib/web-address";
import { buttonClass, clock, fieldClass, Go, Note, Problem, Quiet, Section } from "./bits";

const connectedKey = (migrationId: number) => ["connection", "connected", migrationId] as const;
const NEW_MIGRATION_NAME = "monday to Plaky";
const ownName = (name: string): string => (name.startsWith(NEW_MIGRATION_NAME) ? name.slice(NEW_MIGRATION_NAME.length).replace(/^ — /, "") : name);

export function ConnectOpen() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const env = useQuery(trpc.connection.env.queryOptions());
  const list = useQuery(trpc.connection.list.queryOptions());
  const create = useMutation(trpc.connection.create.mutationOptions({ gcTime: 0, onSuccess: (r) => { queryClient.setQueryData(connectedKey(r.migrationId), r.checkedAt); router.push(`/migrations/${r.migrationId}`); } }));
  const [mondayToken, setMondayToken] = useState("");
  const [plakyKey, setPlakyKey] = useState("");
  const [plakyWebBase, setPlakyWebBase] = useState("");
  const address = normalizeWebAddress(plakyWebBase);
  const addressWrong = plakyKey.trim() !== "" && address !== "" && !PLAKY_WEB_ADDRESS.test(address);
  const hasKeys = Boolean((mondayToken.trim() || env.data?.mondayToken) && (plakyKey.trim() || env.data?.plakyKey));
  const addressField = useRef<HTMLInputElement>(null);
  const connect = (event: React.FormEvent): void => {
    event.preventDefault();
    if (create.isPending || create.isSuccess) return;
    if (addressWrong) { addressField.current?.focus(); return; }
    if (hasKeys) create.mutate({ name: NEW_MIGRATION_NAME, mondayToken, plakyKey, plakyWebBase: plakyKey.trim() ? plakyWebBase : "" });
  };
  const begun = list.data ?? [];
  return (
    <>
      {begun.length ? (
        <section className="mb-4 rounded-lg border border-cake-brand-100 bg-cake-brand-50 p-4 sm:p-6" aria-labelledby="continue" data-testid="continue">
          <h2 id="continue" className="mb-3 text-lg font-semibold">Continue your migration</h2>
          <ul className="flex flex-col gap-2" data-testid="migrations">
            {begun.map((m, at) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Link prefetch={false} href={`/migrations/${m.id}`} aria-label={`Continue migration ${m.id}`} className={at === 0 ? buttonClass.cta : buttonClass.secondary}>Continue</Link>
                <span>Migration {m.id}{ownName(m.name) ? `: ${ownName(m.name)}` : ""}</span>
                <span className="text-cake-muted">{migrationStatus(m.status)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Section n={1} title="Connect accounts" state="open">

        <form className="flex flex-col gap-5" onSubmit={connect} noValidate>
        <div className="grid gap-5 sm:grid-cols-2" data-testid="keys">
          <KeyField id="monday-token" label="monday API token" value={mondayToken} onChange={setMondayToken} inEnv={env.data?.mondayToken ?? false}
            how="In monday: your picture → Developers → My access tokens → Copy." />
          <KeyField id="plaky-key" label="Plaky API key" value={plakyKey} onChange={setPlakyKey} inEnv={env.data?.plakyKey ?? false}
            how="In Plaky: your picture → Profile settings → API → Generate." />
          {plakyKey.trim() ? (
            <div className="flex max-w-[520px] flex-col gap-1.5">
              <label htmlFor="plaky-web-base" className="text-[15px] font-semibold">Plaky workspace address</label>
              <input
                id="plaky-web-base" ref={addressField} type="url" autoComplete="off" spellCheck={false} value={plakyWebBase} onChange={(e) => setPlakyWebBase(e.target.value)}
                placeholder="https://yourcompany.plaky.com" className={fieldClass}
                aria-invalid={addressWrong} aria-describedby={addressWrong ? "plaky-web-base-error plaky-web-base-hint" : "plaky-web-base-hint"}
              />
              {addressWrong ? <span id="plaky-web-base-error" role="alert" className="text-sm text-cake-red-500">{PLAKY_WEB_ADDRESS_HINT.charAt(0).toUpperCase() + PLAKY_WEB_ADDRESS_HINT.slice(1)}.</span> : null}
              <span id="plaky-web-base-hint" className="text-sm text-cake-muted">Optional. Adds Plaky board links to reports.</span>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <Go type="submit" disabled={!hasKeys || create.isPending || create.isSuccess}>{create.isPending ? "Connecting…" : "Connect"}</Go>
          <Note>Keys stay on this computer; only monday and Plaky receive them.{begun.length ? " Connecting again starts a new migration." : ""}</Note>
        </div>
        <Problem error={create.error} title="Could not connect" />
        <Problem error={env.error} title="Could not read saved keys" />
        </form>
      </Section>
      <Problem error={list.error} title="Could not read the earlier migrations" />
      <Section n={2} title="Set up boards" state="later" summary="Choose boards and a Plaky Space" />
      <Section n={3} title="Move and check items" state="later" summary="Review and move" />
      <Section n={4} title="Save your archive" state="later" summary="Optional: save an offline copy" />
    </>
  );
}

function KeyField({ id, label, how, value, onChange, inEnv }: { id: string; label: string; how: string; value: string; onChange: (v: string) => void; inEnv: boolean }) {
  return (
    <div className="flex max-w-[520px] flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] font-semibold">{label}</label>
      <input
        id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={inEnv ? "Leave blank to use saved key" : "Paste API key"}
        className={fieldClass}
      />
      <details className="text-sm text-cake-muted"><summary className="cursor-pointer">Where to find this key</summary><p className="pt-2">{how}</p></details>
    </div>
  );
}

export function ConnectClosed({ migrationId }: { migrationId: number }) {
  const trpc = useTRPC();
  const env = useQuery(trpc.connection.env.queryOptions());
  const stored = useQuery(trpc.connection.get.queryOptions({ migrationId }));
  const connectedAt = useQuery<number>({ queryKey: connectedKey(migrationId), queryFn: skipToken, staleTime: Infinity }).data;
  const queryClient = useQueryClient();
  const check = useMutation(trpc.connection.check.mutationOptions({ onSuccess: () => {
    void queryClient.invalidateQueries(trpc.plan.latest.queryFilter({ migrationId }));
    void queryClient.invalidateQueries(trpc.discovery.catalog.queryFilter({ migrationId }));
  } }));
  const base = stored.data?.connection.plakyWebBase ?? (stored.data?.connection.typedPlakyKey ? null : env.data?.plakyWebBase ?? null);
  const workspace = workspaceName(base);
  const summary = stored.data
    ? `monday: ${check.data?.account ?? stored.data.connection.account} · Plaky: ${workspace ? `workspace ${workspace}` : check.data?.plakyUser ?? "the key typed for this migration"}`
    : "…";
  const checkedAt = check.data ? check.submittedAt : connectedAt;
  return (
    <>
      <Section migrationId={migrationId}
        n={1} title="Connect accounts" state="closed"
        summary={checkedAt !== undefined ? <>{summary} · checked <time dateTime={new Date(checkedAt).toISOString()}>{clock(checkedAt, checkedAt, true)}</time></> : summary}
        action={<Quiet onClick={() => check.mutate({ migrationId })} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check again"}</Quiet>}
      />
      <Problem error={check.error} title="The keys did not answer" />
      <Problem error={stored.error} title="Could not read this migration's connection" />
      <Problem error={env.error} title="Could not read saved keys" />
    </>
  );
}
