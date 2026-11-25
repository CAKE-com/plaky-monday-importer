import { z } from "zod";

export const idish = z.union([z.string(), z.number()]);
export const nullishStr = z.string().nullish();

export const envelope = z.looseObject({ data: z.unknown().optional(), errors: z.unknown().optional() });

const columnValueSchema = z.looseObject({ id: z.string(), type: z.string(), text: nullishStr, value: z.unknown().optional() });
export const blockSchema = z.looseObject({ id: idish.nullish(), type: nullishStr, parent_block_id: idish.nullish(), content: z.unknown().optional() });
const assetRef = z.looseObject({ id: idish, name: nullishStr, file_size: z.number().nullish() });
export const rawItemSchema = z.looseObject({
  id: idish,
  name: z.string(),
  state: nullishStr,
  url: nullishStr,
  created_at: nullishStr,
  updated_at: nullishStr,
  creator_id: idish.nullish(),
  description: z.looseObject({ blocks: z.array(blockSchema).nullish() }).nullish(),
  group: z.looseObject({ id: idish.nullish(), title: nullishStr }).nullish(),
  parent_item: z.looseObject({ id: idish.nullish() }).nullish(),
  subscribers: z.array(z.looseObject({ id: idish.nullish() })).nullish(),
  column_values: z.array(columnValueSchema).nullish(),
  assets: z.array(assetRef).nullish(),
});
export type RawItem = z.infer<typeof rawItemSchema>;

const rawColumnSchema = z.looseObject({ id: z.string(), title: z.string(), type: z.string(), settings: z.unknown().optional(), settings_str: nullishStr });
const rawGroupSchema = z.looseObject({ id: idish, title: nullishStr, color: nullishStr, position: nullishStr, archived: z.boolean().nullish(), deleted: z.boolean().nullish() });
export const rawBoardSchema = z.looseObject({
  id: idish,
  name: z.string(),
  hierarchy_type: nullishStr,
  board_kind: nullishStr,
  permissions: nullishStr,
  description: nullishStr,
  views: z.array(z.looseObject({ name: nullishStr, type: nullishStr })).nullish(),
  columns: z.array(rawColumnSchema),
  tags: z.array(z.looseObject({ id: idish.nullish(), name: nullishStr })).nullish(),
  groups: z.array(rawGroupSchema).nullish(),
});
export type RawBoard = z.infer<typeof rawBoardSchema>;

const updateCore = {
  id: idish,
  item_id: idish.nullish(),
  text_body: nullishStr,
  body: nullishStr,
  created_at: nullishStr,
  edited_at: nullishStr,
  creator_id: idish.nullish(),
  creator: z.looseObject({ name: nullishStr }).nullish(),
  pinned_to_top: z.array(z.looseObject({ item_id: idish.nullish() })).nullish(),
  assets: z.array(assetRef).nullish(),
};
export const rawUpdateSchema = z.looseObject({ ...updateCore, replies: z.array(z.looseObject(updateCore)).nullish() });
export type RawUpdate = z.infer<typeof rawUpdateSchema>;

export const nullableRow = <T extends z.ZodType>(row: T) => z.array(row.nullable()).nullish();
export const listBoardRow = z.looseObject({ id: idish, name: nullishStr, board_kind: nullishStr, permissions: nullishStr, items_count: z.number().nullish(), type: nullishStr, state: nullishStr });
export const catalogRow = listBoardRow.extend({ board_folder_id: idish.nullish(), workspace: z.looseObject({ id: idish, name: nullishStr, kind: nullishStr }).nullish() });
export type CatalogRow = z.infer<typeof catalogRow>;
export const tagRow = z.looseObject({ id: idish, name: nullishStr });
export const userRow = z.looseObject({
  id: idish, name: nullishStr, email: nullishStr, status: nullishStr, user_config: z.looseObject({ kind: nullishStr }).nullish(),
  enabled: z.boolean().nullish(), is_pending: z.boolean().nullish(), is_guest: z.boolean().nullish(),
}).transform((u) => (u.status ? { ...u, enabled: u.status !== "INACTIVE", is_pending: u.status === "PENDING", is_guest: u.user_config?.kind === "guest" } : u));
export const teamRow = z.looseObject({ id: idish, name: nullishStr, users: z.array(z.looseObject({ id: idish, email: nullishStr })).nullish() });
export const assetRow = z.looseObject({ id: idish, name: nullishStr, file_size: z.number().nullish(), public_url: nullishStr });
export const assetMetaRow = z.looseObject({ id: idish, name: nullishStr, file_size: z.number().nullish() });
export type RawUser = z.infer<typeof userRow>;
export type RawTeam = z.infer<typeof teamRow>;
export type RawAsset = z.infer<typeof assetRow>;
export type RawAssetMeta = z.infer<typeof assetMetaRow>;
