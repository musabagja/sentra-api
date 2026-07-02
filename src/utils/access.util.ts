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
