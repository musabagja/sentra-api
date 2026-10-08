/**
 * Access code that lets a user create circles and checkpoints, and grant
 * accesses to other users in their circle.
 */
export const CHECKPOINT_MANAGE_ACCESS = 'C04';

/**
 * Accesses of the Pengadaan (procurement) menu. The screens hide the buttons without them; the
 * routes enforce them too, so the API cannot be called around the UI.
 */
export const PROCUREMENT_ACCESS = {
  MENU: 'P01',
  ADD_STOCK: 'P02',
  VERIFY: 'P03',
  DELETE_BATCH: 'P04'
} as const;

/**
 * "Download Data" accesses: who may export each menu to Excel. Jadwal Distribusi and Pengadaan
 * have none of their own, so they follow Stok Barang (the same stock data).
 */
export const DOWNLOAD_ACCESS = {
  STOCK: 'SB02',
  CHECKPOINT: 'C02',
  SALES: 'S02'
} as const;

/**
 * Accesses of the User menu. They are granted only directly in the database:
 * they never appear in the access list and can't be granted or revoked through
 * the API (see isRestrictedAccess).
 */
export const USER_ACCESS = {
  MENU: 'US01',
  ADD: 'US02',
  EDIT: 'US03',
  FREEZE: 'US04'
} as const;

const RESTRICTED_ACCESS_PREFIX = 'US';

export const isRestrictedAccess = (code: string): boolean =>
  code.startsWith(RESTRICTED_ACCESS_PREFIX);

/** Status of a user who can't sign in and is signed out everywhere */
export const USER_STATUS = { ACTIVE: 'ACTIVE', FROZEN: 'FROZEN' } as const;

/**
 * Returns true when the given checkpointCode is within the caller's allowed set.
 *
 * allowNull=true handles the Numbers rule: a number with no checkpoint is
 * considered available to every checkpoint (globally accessible stock).
 */
export const hasCheckpointAccess = (
  checkpointCode: string | null | undefined,
  allowed: string[],
  allowNull = false
): boolean => {
  if (!checkpointCode) return allowNull;
  return allowed.includes(checkpointCode);
};

/**
 * Narrows a user-supplied checkpointCode query param to only the codes the
 * caller may access. Returns the filtered list to use in a Prisma { in: ... }.
 *
 * - If the caller passed a specific code that is in their allowed set → [code]
 * - If the caller passed a code they cannot access              → [] (no rows)
 * - If the caller passed nothing                                → all allowed codes
 */
export const resolveCheckpointFilter = (
  requestedCode: string | undefined,
  allowed: string[]
): string[] => {
  if (!requestedCode) return allowed;
  return allowed.includes(requestedCode) ? [requestedCode] : [];
};

/**
 * Prisma relation filter scoping a Checkpoint (or a relation pointing at one)
 * to the caller's circle, optionally narrowed to a single requested code.
 *
 * Use this instead of `checkpointCode: { in: allowed } }` — expanding a large
 * circle (e.g. HQ, which spans every checkpoint) into an explicit `IN` list
 * can exceed SQL Server's ~2100 query-parameter limit. This filters via a
 * join on CheckpointCircle instead, which scales to any circle size.
 */
export const checkpointInCircle = (
  circleCode: string,
  requestedCode?: string
) => ({
  ...(requestedCode ? { code: requestedCode } : {}),
  checkpointCircles: { some: { circleCode } }
});
