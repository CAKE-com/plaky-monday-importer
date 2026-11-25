import { type PlakyClient } from "../../clients/plaky";
import { type AssetSource } from "../assets";
import type { PipelineLog } from "../events";
import { failureText } from "../plan";
import { asId, normalizeTitle } from "../transform/mapping";
import { isDict } from "../transform/pystr";
import type { LoadStore } from "./store";

export type ApplyResult = {
  created: number;
  updated: number;
  fieldUpdates: number;
  unchanged: number;
  recreated: number;
  moved: number;
  pruned: number;
  groupsCreated: number;
  groupsReordered: number;
  groupsRenamed: number;
  commentsCreated: number;
  commentsUpdated: number;
  filesUploaded: number;
  subscribersReplaced: number;
  ambiguous: string[];
  failures: string[];
  notes: string[];
  rateLimited: boolean;
  seedGroupDeleted: boolean;
  writes: number;
  stopped: boolean;
  permanentFailures: number;
  plakyItemIds: Record<string, number>;
};

export function newApplyResult(): ApplyResult {
  return {
    created: 0, updated: 0, fieldUpdates: 0, unchanged: 0, recreated: 0, moved: 0, pruned: 0, groupsCreated: 0, groupsReordered: 0, groupsRenamed: 0,
    commentsCreated: 0, commentsUpdated: 0, filesUploaded: 0, subscribersReplaced: 0,
    ambiguous: [], failures: [], notes: [], rateLimited: false, seedGroupDeleted: false, writes: 0, stopped: false, permanentFailures: 0, plakyItemIds: {},
  };
}

export type ApplyDeps = {
  plaky: PlakyClient;
  store: LoadStore;
  log?: PipelineLog;
  progress?: () => void;
  fetcher?: AssetSource | undefined;
};

export type ApplyOptions = {
  recreateDrifted?: boolean;
  prune?: boolean;
  signal?: AbortSignal | undefined;
  maxCommentsPerItem?: number;
  parentIds?: ((parentMondayItemId: string) => number | null) | undefined;
};

export const textOf = (error: unknown): string => failureText(error);

export const emptyListing = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0);

export function fileKey(name: string, size: unknown): string {
  return `${normalizeTitle(name)}\u0000${asId(size) ?? ""}`;
}

export type FilesOutcome = "ok" | "rate_limited" | "monday_limit" | "stopped";
