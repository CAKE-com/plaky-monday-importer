export const ITEM_TITLE_HEADER = "Name";
export const MONDAY_ID_FIELD = "Monday ID";
export const PARENT_TITLE_FIELD = "Parent Item";
export const PARENT_ID_FIELD = "Parent Monday ID";
export const RESERVED_FIELD_NAMES = [ITEM_TITLE_HEADER, MONDAY_ID_FIELD, PARENT_TITLE_FIELD, PARENT_ID_FIELD] as const;

const SEED_MARKER_PREFIX = "seed:";
export const seedMarker = (mondayBoardId: string): string => `${SEED_MARKER_PREFIX}${mondayBoardId}`;
export const isSeedMarker = (value: unknown): boolean => typeof value === "string" && value.startsWith(SEED_MARKER_PREFIX);
export const markerBoardId = (marker: string): string => marker.slice(SEED_MARKER_PREFIX.length);

export const SINCE_MARGIN_MS = 10 * 60_000;

export const levelId = (boardId: string, level: number): string => `${boardId}:level${level}`;
export const levelTwoId = (boardId: string): string => levelId(boardId, 2);
export const baseBoardId = (boardId: string): string => boardId.replace(/:level\d+$/, "");
export const isLevelEntry = (boardId: string): boolean => /:level\d+$/.test(boardId);
export const levelOfEntry = (boardId: string): number => Number(/:level(\d+)$/.exec(boardId)?.[1] ?? 1);
