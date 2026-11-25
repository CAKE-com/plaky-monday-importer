import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-zod";
import type { ItemFilters } from "@/server/pipeline/scope";

const id = () => integer("id").primaryKey({ autoIncrement: true });
const ts = (name: string) => integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch('subsec') * 1000)`);
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export type DraftOptions = { syncComments: boolean; syncFiles: boolean; syncSubscribers: boolean; withCreated: boolean; withLink: boolean; subitems: "board" | "nested" };

export const connections = sqliteTable("connections", {
  id: id(),
  label: text("label").notNull(),
  mondayAccountId: text("monday_account_id").notNull(),
  mondayUserId: text("monday_user_id").notNull(),
  mondayAccountUid: text("monday_account_uid"),
  mondayUserUid: text("monday_user_uid"),
  mondayTimeZone: text("monday_time_zone"),
  mondayAccountSlug: text("monday_account_slug"),
  mondayTier: text("monday_tier"),
  plakyUserId: integer("plaky_user_id").notNull(),
  mondayToken: text("monday_token"),
  plakyKey: text("plaky_key"),
  plakyWebBase: text("plaky_web_base"),
  validatedAt: ts("validated_at"),
});

export const migrations = sqliteTable("migrations", {
  id: id(),
  connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "discovered", "linked", "planned",
    "running", "interrupted", "completed", "failed"] }).notNull().default("draft"),
  plakySpaceId: integer("plaky_space_id"),
  options: json<{ syncComments: boolean; syncFiles: boolean; syncSubscribers: boolean; syncGroups: boolean;
    withCreated: boolean; withLink: boolean; prune: boolean; recreateDrifted: boolean;
    allowDuplicateImport: boolean; since: string | null;
    subitems?: "board" | "nested";
    pick?: string[];
    draft?: { boards: string[]; spaceId: number | null; options?: DraftOptions } | undefined;
    carryArchived?: boolean;
    filters?: ItemFilters }>("options").notNull(),
  people: json<Record<string, Record<string, unknown>>>("people").notNull().default({}),
  manifest: json<Record<string, unknown>>("manifest"),
  linkConfig: json<Record<string, unknown>>("link_config"),
  readinessTicks: json<string[]>("readiness_ticks").notNull().default([]),
  resume: json<{ at: number; since: string | null; reset?: number; unattended?: boolean }>("resume"),
  schedule: json<{ at: number; everyHours: number | null }>("schedule"),
  seedFailures: json<string[]>("seed_failures").notNull().default([]),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const migrationBoards = sqliteTable("migration_boards", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  mondayBoardId: text("monday_board_id").notNull(),
  mondayBoardName: text("monday_board_name").notNull(),
  hierarchyType: text("hierarchy_type").notNull().default("classic"),
  itemsCount: integer("items_count").notNull().default(0),
  subitemsOf: text("subitems_of"),
  plakyBoardId: integer("plaky_board_id"),
  fieldMap: json<Record<string, string>>("field_map").notNull().default({}),
  skipColumns: json<string[]>("skip_columns").notNull().default([]),
  labelMap: json<Record<string, Record<string, string>>>("label_map").notNull().default({}),
  mondayIdFieldKey: text("monday_id_field_key"),
  parentTitleFieldKey: text("parent_title_field_key"),
  parentIdFieldKey: text("parent_id_field_key"),
  seedGroupId: integer("seed_group_id"),
  applied: integer("applied", { mode: "boolean" }).notNull().default(false),
  syncedReadAt: integer("synced_read_at", { mode: "timestamp_ms" }),
  byHand: json<string[]>("by_hand").notNull().default([]),
  warnings: json<string[]>("warnings").notNull().default([]),
}, (t) => [
  uniqueIndex("mb_migration_monday").on(t.migrationId, t.mondayBoardId),
  index("mb_migration_plaky").on(t.migrationId, t.plakyBoardId),
]);

export const migrationColumns = sqliteTable("migration_columns", {
  id: id(),
  migrationBoardId: integer("migration_board_id").notNull().references(() => migrationBoards.id, { onDelete: "cascade" }),
  mondayColumnId: text("monday_column_id").notNull(),
  title: text("title").notNull(),
  mondayType: text("monday_type").notNull(),
  fieldName: text("field_name").notNull(),
  plakyType: text("plaky_type", { enum: ["STRING", "RICH_TEXT", "NUMBER", "DATE_TIME", "TIMELINE",
    "STATUS", "TAG", "PERSON", "LINK"] }),
  reason: text("reason"),
  labels: json<string[]>("labels").notNull().default([]),
  labelCollisions: json<string[]>("label_collisions").notNull().default([]),
  position: integer("position").notNull(),
}, (t) => [uniqueIndex("mc_board_column").on(t.migrationBoardId, t.mondayColumnId)]);

export const irItems = sqliteTable("ir_items", {
  id: id(),
  migrationBoardId: integer("migration_board_id").notNull().references(() => migrationBoards.id, { onDelete: "cascade" }),
  mondayItemId: text("monday_item_id").notNull(),
  parentMondayItemId: text("parent_monday_item_id"),
  title: text("title").notNull(),
  groupTitle: text("group_title"),
  state: text("state").notNull().default("active"),
  position: integer("position").notNull(),
  plakyFields: json<Record<string, unknown>>("plaky_fields").notNull(),
  subscriberIds: json<number[]>("subscriber_ids").notNull().default([]),
  warnings: json<string[]>("warnings").notNull().default([]),
  notCarried: json<string[]>("not_carried").notNull().default([]),
  uncleared: json<string[]>("uncleared").notNull().default([]),
  contentHash: text("content_hash").notNull(),
}, (t) => [uniqueIndex("ir_board_item").on(t.migrationBoardId, t.mondayItemId)]);

export const entityMappings = sqliteTable("entity_mappings", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  entityType: text("entity_type", { enum: ["board", "group", "item", "subitem", "comment", "file",
    "stand_in_team"] }).notNull(),
  mondayId: text("monday_id").notNull(),
  scope: text("scope").notNull().default(""),
  occurrence: integer("occurrence").notNull().default(0),
  plakyId: integer("plaky_id"),
  plakyParentId: integer("plaky_parent_id"),
  matchKey: text("match_key"),
  status: text("status", { enum: ["dispatched", "committed", "ambiguous", "failed"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: ts("updated_at"),
}, (t) => [
  uniqueIndex("em_unique").on(t.migrationId, t.entityType, t.scope, t.mondayId, t.occurrence),
  index("em_plaky").on(t.entityType, t.plakyId),
  index("em_status").on(t.migrationId, t.status),
]);

export const fileMap = sqliteTable("file_map", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  mondayItemId: text("monday_item_id").notNull(),
  mondayAssetId: text("monday_asset_id").notNull(),
  occurrence: integer("occurrence").notNull().default(0),
  plakyItemId: integer("plaky_item_id").notNull(),
  plakyFileId: integer("plaky_file_id").notNull(),
  updatedAt: ts("updated_at"),
}, (t) => [uniqueIndex("fm_unique").on(t.migrationId, t.mondayItemId, t.mondayAssetId, t.occurrence)]);

export const boardLocks = sqliteTable("board_locks", {
  plakySpaceId: integer("plaky_space_id").notNull(),
  plakyBoardId: integer("plaky_board_id").notNull(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.plakySpaceId, t.plakyBoardId] })]);

export const unansweredWrites = sqliteTable("unanswered_writes", {
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  plakySpaceId: integer("plaky_space_id").notNull(),
  plakyBoardId: integer("plaky_board_id").notNull(),
  mondayItemId: text("monday_item_id").notNull(),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.plakySpaceId, t.plakyBoardId, t.mondayItemId] })]);

export const migrationRuns = sqliteTable("migration_runs", {
  id: id(),
  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["discover", "link", "plan", "apply", "verify", "e2e", "undo"] }).notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed", "interrupted", "rate_limited", "plaky_rate_limited"] }).notNull(),
  plannedWrites: integer("planned_writes"),
  counts: json<Record<string, number>>("counts"),
  receipt: json<unknown>("receipt"),
  startedAt: ts("started_at"),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
  ownerHost: text("owner_host"),
  ownerPid: integer("owner_pid"),
  ownerToken: text("owner_token"),
}, (t) => [index("runs_migration").on(t.migrationId, t.startedAt)]);

export const migrationLogs = sqliteTable("migration_logs", {
  id: id(),
  runId: integer("run_id").notNull().references(() => migrationRuns.id, { onDelete: "cascade" }),
  migrationBoardId: integer("migration_board_id").references(() => migrationBoards.id, { onDelete: "set null" }),
  ts: ts("ts"),
  level: text("level", { enum: ["info", "warn", "error", "ambiguous", "progress"] }).notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  data: json<Record<string, unknown>>("data"),
}, (t) => [index("logs_run_id").on(t.runId, t.id)]);

export const mondayUsage = sqliteTable("monday_usage", {
  day: text("day").primaryKey(),
  calls: integer("calls").notNull().default(0),
});

export const selectMigrationSchema = createSelectSchema(migrations);
