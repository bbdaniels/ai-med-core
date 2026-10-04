/**
 * Which deployed vignettes may tools/push-content.ts delete?
 *
 * A deployed vignette that the checked-out project.json no longer names is
 * "stale", and push-content removes it. CI runs push-content for every project
 * on every merge to main, so a project.json that was not committed after a
 * content sync, or a checkout that never had the generated list, would delete
 * live content on the next merge. This guard refuses every removal, unless the
 * caller passes --prune, when any of these holds:
 *
 *   - the local list is empty (nothing was synced into this checkout);
 *   - the project sets requireKnownVignette (its keys are deep links people
 *     hold, and an unknown key is refused, never swapped for another);
 *   - the removals exceed max(3, 25% of the deployed keys).
 *
 * A refusal removes nothing at all, rather than a capped subset: a partial
 * deletion is the hardest state to diagnose.
 */
export interface StaleRemovalPlan {
  remove: string[];
  refused: string[];
}

export const MASS_REMOVAL_FLOOR = 3;
export const MASS_REMOVAL_SHARE = 0.25;

export function planStaleRemoval(
  local: string[],
  remote: string[],
  opts: { prune: boolean; requireKnownVignette: boolean },
): StaleRemovalPlan {
  const localSet = new Set(local);
  const stale = remote.filter(k => !localSet.has(k));
  if (stale.length === 0 || opts.prune) return { remove: stale, refused: [] };
  const limit = Math.max(MASS_REMOVAL_FLOOR, MASS_REMOVAL_SHARE * remote.length);
  const guarded = local.length === 0 || opts.requireKnownVignette || stale.length > limit;
  return guarded ? { remove: [], refused: stale } : { remove: stale, refused: [] };
}

/** Why a plan refused, for the log line. */
export function refusalReason(local: string[], remote: string[], requireKnownVignette: boolean): string {
  if (local.length === 0) return 'project.json names no vignettes in this checkout';
  if (requireKnownVignette) return 'the project sets requireKnownVignette, so its keys are deep links';
  const limit = Math.max(MASS_REMOVAL_FLOOR, MASS_REMOVAL_SHARE * remote.length);
  return `more than ${Math.floor(limit)} of ${remote.length} deployed vignettes would go`;
}
