const ITEM_FIELDS =
  "id name state url created_at updated_at creator_id " +
  "description { blocks { id type parent_block_id content } } " +
  "group { id title } parent_item { id } subscribers { id } assets(assets_source: gallery) { id name file_size }";

const COLUMN_VALUE_FRAGMENT = `
        column_values {
          id
          type
          text
          value
          ... on MirrorValue { display_value }
          ... on BoardRelationValue { display_value }
          ... on DependencyValue { display_value }
          ... on FormulaValue { display_value }
          ... on DocValue { file { ... on FileDocValue { doc { name } } } }
        }
`;
export const ITEM_SELECTION = `${ITEM_FIELDS} ${COLUMN_VALUE_FRAGMENT}`;

export const BOARD_QUERY = `
          query($ids: [ID!]) {
            boards(ids: $ids) {
              id
              name
              hierarchy_type
              board_kind
              permissions
              description
              views { name type }
              columns { id title type settings settings_str }
              tags { id name }
              groups { id title color position archived deleted }
            }
          }
        `;

export function itemPageQueries(selection: string, o: { columns?: boolean; rules?: boolean; allLevels?: boolean }): { first: string; next: string } {
  const cols = o.columns ? ", $cols: [String!]" : "";
  const declared = o.rules ? ", $rules: ItemsQuery" : "";
  const params = `${o.allLevels ? ', hierarchy_scope_config: "allItems"' : ""}${o.rules ? ", query_params: $rules" : ""}`;
  return {
    first: `
          query($ids: [ID!], $limit: Int!${cols}${declared}) {
            boards(ids: $ids) {
              items_page(limit: $limit${params}) { cursor items { ${selection} } }
            }
          }
        `,
    next: `
          query($cursor: String!, $limit: Int!${cols}) {
            next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${selection} } }
          }
        `,
  };
}

export const DESCRIPTION_QUERY = `
          query($ids: [ID!], $limit: Int!, $page: Int!) {
            items(ids: $ids) {
              id description {
                blocks(limit: $limit, page: $page) { id type parent_block_id content }
              }
            }
          }
        `;
export const ACTIVITY_LOG_QUERY = `
          query($ids: [ID!], $limit: Int!, $page: Int!) {
            boards(ids: $ids) { activity_logs(limit: $limit, page: $page) { event data } }
          }
        `;
export const ITEM_STATES_QUERY = `
          query($ids: [ID!], $limit: Int!) {
            items(ids: $ids, limit: $limit, exclude_nonactive: false) { id state }
          }
        `;
export const ACTIVE_ITEMS_QUERY = `
          query($ids: [ID!], $limit: Int!) {
            items(ids: $ids, limit: $limit, exclude_nonactive: true) { id name state board { id } }
          }
        `;
export const ARCHIVED_ITEMS_QUERY = `
          query($ids: [ID!], $limit: Int!) {
            items(ids: $ids, limit: $limit, exclude_nonactive: false) {
              ${ITEM_SELECTION}
              board { id }
              updates(limit: 100) {
                id item_id text_body body created_at edited_at creator_id creator { name } pinned_to_top { item_id }
                assets { id name file_size }
                replies {
                  id text_body body created_at edited_at creator_id creator { name }
                  assets { id name file_size }
                }
              }
            }
          }
        `;
export const ARCHIVED_ITEM_UPDATES_QUERY = `
          query($ids: [ID!], $limit: Int!, $page: Int!) {
            items(ids: $ids, limit: 1, exclude_nonactive: false) {
              id
              updates(limit: $limit, page: $page) {
                id item_id text_body body created_at edited_at creator_id creator { name } pinned_to_top { item_id }
                assets { id name file_size }
                replies {
                  id text_body body created_at edited_at creator_id creator { name }
                  assets { id name file_size }
                }
              }
            }
          }
        `;
export const UPDATES_QUERY = `
          query($ids: [ID!], $limit: Int!, $page: Int!, $from: ISO8601DateTime) {
            boards(ids: $ids) {
              updates(limit: $limit, page: $page, from_date: $from) {
                id item_id text_body body created_at edited_at creator_id creator { name } pinned_to_top { item_id }
                assets { id name file_size }
                replies {
                  id text_body body created_at edited_at creator_id creator { name }
                  assets { id name file_size }
                }
              }
            }
          }
        `;
export const LIST_BOARDS_QUERY = `
          query($limit: Int!, $page: Int!) {
            boards(limit: $limit, page: $page, state: all) {
              id name board_kind permissions items_count type state
            }
          }
        `;
export const CATALOG_QUERY = `
          query($limit: Int!, $page: Int!) {
            boards(limit: $limit, page: $page, state: all) {
              id name board_kind permissions items_count type state board_folder_id workspace { id name kind }
            }
            folders(limit: $limit, page: $page) { id name }
          }
        `;
export const AUTOMATIONS_QUERY = `
          query($board: [ID!], $cursor: String) {
            board_automations(board_ids: $board, limit: 100, cursor: $cursor) { cursor items { id title active } legacy_automations }
          }
        `;
export const DASHBOARDS_QUERY = `query { search { overviews(query: "", limit: 100) { results { id live_data { id name } } } } }`;
export const TAGS_QUERY = "query($ids: [ID!]) { tags(ids: $ids) { id name } }";
export const ASSETS_QUERY = "query($ids: [ID!]!) { assets(ids: $ids) { id name file_size public_url } }";
export const ASSET_META_QUERY = "query($ids: [ID!]!) { assets(ids: $ids) { id name file_size } }";
export const TEAMS_QUERY = "query($ids: [ID!]) { teams(ids: $ids) { id name users { id email } } }";
export const USERS_QUERY = `
          query($ids: [ID!]) {
            users(ids: $ids, status: [ACTIVE, INACTIVE, PENDING], limit: 100) {
              id name email status user_config { kind }
            }
          }
        `;

export function legacyTitles(legacy: unknown): string[] {
  const list = legacy && typeof legacy === "object" ? (legacy as { automations?: unknown }).automations : undefined;
  if (!Array.isArray(list)) return [];
  return list.map((a) => {
    const o = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    const said = [o["title"], o["name"], o["description"]].find((v) => typeof v === "string" && v.trim());
    return typeof said === "string" ? said.trim() : "an automation";
  });
}
