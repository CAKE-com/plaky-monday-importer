"use client";

import { useId, useState } from "react";
import { fieldClass } from "./bits";

type Option = { value: string; label: string; disabled?: boolean };

export function SearchSelect({ label, searchLabel, searchPlaceholder = searchLabel, placeholder, hideLabel = false, value, options, disabled, onChange }: {
  label: string; searchLabel: string; searchPlaceholder?: string; placeholder?: string; hideLabel?: boolean; value: string; options: readonly Option[]; disabled?: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const matches = options.filter((o) => o.label.toLocaleLowerCase().includes(query));
  const chosen = options.find((o) => o.value === value);
  const kept = Boolean(chosen && !matches.includes(chosen));
  const entry = (o: Option) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>;
  return <div className="flex w-full min-w-0 flex-col gap-2">
    <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</label>
    <input type="search" aria-label={searchLabel} placeholder={searchPlaceholder} className={`${fieldClass} w-full min-w-0`} value={search} disabled={disabled} onInput={(e) => setSearch(e.currentTarget.value)} />
    <select id={id} aria-label={label} className={`${fieldClass} w-full min-w-0 max-w-full truncate`} value={value} disabled={disabled}
      onChange={(e) => { onChange(e.target.value); setSearch(""); }}>
      {!chosen && placeholder ? <option value="" disabled>{placeholder}</option> : null}
      {kept && chosen && matches.length ? <><optgroup label="Selected">{entry(chosen)}</optgroup><optgroup label="Search results">{matches.map(entry)}</optgroup></> : kept && chosen ? entry(chosen) : matches.map(entry)}
    </select>
    {query && !matches.length ? <span role="status" className="text-sm text-cake-muted">No matches.{chosen ? ` Still selected: ${chosen.label}.` : ""}</span> : null}
  </div>;
}
