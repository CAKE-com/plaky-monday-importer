"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";
import { fieldClass, Note, Plain, Problem, plural } from "./bits";

const REPEATS: [hours: number, label: string][] = [[0, "Once"], [1, "Every hour"], [6, "Every 6 hours"], [24, "Every 24 hours"]];

export function ScheduleChanges({ migrationId, schedule, onChange }: { migrationId: number; schedule: { at: number; everyHours: number | null } | null; onChange: () => void }) {
  const trpc = useTRPC();
  const save = useMutation(trpc.run.setSchedule.mutationOptions({ onSuccess: onChange }));
  const cancel = useMutation(trpc.run.cancelSchedule.mutationOptions({ onSuccess: onChange }));
  const [when, setWhen] = useState("");
  const [every, setEvery] = useState(0);
  if (schedule) {
    return (
      <div className="flex flex-wrap items-center gap-5" data-testid="schedule">
        <p>Next at {new Date(schedule.at).toLocaleString()}{schedule.everyHours ? `, then every ${plural(schedule.everyHours, "hour")}` : ""}.</p>
        <Plain onClick={() => cancel.mutate({ migrationId })} disabled={cancel.isPending}>Cancel the schedule</Plain>
        <Problem error={cancel.error} title="Could not cancel the schedule" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="schedule">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-wrap items-center gap-2">Local time
          <input type="datetime-local" aria-label="When to bring over changes" className={fieldClass} value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <select aria-label="How often" className={fieldClass} value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          {REPEATS.map(([hours, label]) => <option key={hours} value={hours}>{label}</option>)}
        </select>
        <Plain disabled={!when || save.isPending} onClick={() => save.mutate({ migrationId, at: new Date(when).getTime(), everyHours: every || null })}>Schedule</Plain>
      </div>
      <Note>Keep the app running. Missed schedules run on startup. Scheduled moves never delete items.</Note>
      <Problem error={save.error} title="Could not schedule it" />
    </div>
  );
}
