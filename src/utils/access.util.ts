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
 * Kirim Barang (send goods) accesses of Stok Barang. SB03 is the scanned send (not enforced by the
 * server); SB04 is the send from an Excel file, enforced on its upload route.
 */
export const DISTRIBUTION_ACCESS = {
  SEND_EXCEL: 'SB04'
} as const;

/**
 * Visibility (Inventaris, barang non SIM card) accesses. V02 depends on V01: the form refuses to
 * grant Serah Terima without Akses Menu (V-01a), and the routes enforce it too.
 */
export const VISIBILITY_ACCESS = {
  MENU: 'V01',
  HANDOVER: 'V02'
} as const;

/** Accesses that may only be granted together with another access (dependent -> required) */
export const ACCESS_DEPENDENCIES: Record<string, string> = {
  [VISIBILITY_ACCESS.HANDOVER]: VISIBILITY_ACCESS.MENU
};

/** Human-readable label of a dependency violation (the V-01a validation message) */
export const accessDependencyMessage = (dependent: string): string => {
  if (dependent === VISIBILITY_ACCESS.HANDOVER) {
    return 'Centang "Akses Menu" Visibility dulu untuk memberi akses Serah Terima.';
  }
  return `Akses ${dependent} membutuhkan akses lain terlebih dahulu.`;
};

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

/**
 * "Akses Semua Circle": the holder acts as if they belonged to every circle (super admin).
 * Granted only in the database (see isRestrictedAccess), so nobody can give it from the app.
 */
export const ALL_CIRCLES_ACCESS = 'SA01';

/**
 * "Tandai Terkirim" on Jadwal Distribusi: an admin records schedules as delivered when the goods
 * arrived but the serah terima was never done in the app. Granted only in the database (SA prefix,
 * see isRestrictedAccess), so it never shows in Manajemen Akun.
 */
export const MANUAL_HANDOVER_ACCESS = 'SA02';

// Accesses with these prefixes are granted only directly in the database: they never appear in the
// access list and can't be granted or revoked through the API. US = Manajemen Akun, SA = super admin.
const RESTRICTED_ACCESS_PREFIXES = ['US', 'SA'];

export const isRestrictedAccess = (code: string): boolean =>
  RESTRICTED_ACCESS_PREFIXES.some((prefix) => code.startsWith(prefix));

/**
 * Stands in for a circle code to mean "every circle". Never a real code (those are names such as
 * "EAST JAVA"), so it can travel through the same parameters as a circle code.
 */
export const ALL_CIRCLES = '*';

/**
 * The circle every scoping check of this request should use: the user's own circle, or ALL_CIRCLES
 * for a holder of ALL_CIRCLES_ACCESS (loaded into req.allCircles by CheckpointAccess.load).
 */
export const circleScope = (req: { allCircles?: boolean; user?: { circleCode: string } }): string =>
  req.allCircles ? ALL_CIRCLES : req.user!.circleCode;

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
) =>
  circleCode === ALL_CIRCLES
    ? // Every checkpoint: a condition that is always true (and safe on an optional relation)
      { ...(requestedCode ? { code: requestedCode } : {}), id: { gt: 0 } }
    : {
        ...(requestedCode ? { code: requestedCode } : {}),
        checkpointCircles: { some: { circleCode } }
      };
