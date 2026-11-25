const said = (map: Readonly<Record<string, string>>) => (value: string | null | undefined): string => (value == null ? "—" : (map[value] ?? value));

export const runKind = said({ apply: "Move", plan: "Plan", verify: "Check", undo: "Undo" });
export const runMode = said({ full: "Everything", changes: "Changes only" });
export const runStatus = said({ succeeded: "Done", failed: "Failed", running: "Running", interrupted: "Stopped", rate_limited: "Paused at monday’s limit", plaky_rate_limited: "Stopped at Plaky’s rate limit" });
export const migrationStatus = said({
  draft: "Not read yet", discovered: "Boards read", linked: "Boards set up", planned: "Planned", running: "Moving", completed: "Moved",
  failed: "Failed", interrupted: "Stopped",
});
export const COUNT_LABEL: Readonly<Record<string, string>> = {
  writes: "writes", created: "created", updated: "updated", unchanged: "unchanged", failures: "failed", ambiguous: "outcome unknown",
  deletedItems: "items deleted", deletedGroups: "groups deleted",
};
