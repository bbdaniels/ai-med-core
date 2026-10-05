/**
 * Does every vignette a project.json registers have content somewhere?
 *
 * tools/push-content.ts pushes a project's registry (project.json, and the
 * titles in languages.json) together with the vignette files this checkout
 * has. Some vignette files are private and gitignored, so a CI checkout never
 * has them; they reach a deployment only from a checkout that does. If the
 * registry reaches the deployment first (a merge to main, whose CI push sends
 * the titles), every link to those vignettes is refused as unknown, while the
 * page already shows their titles.
 *
 * So a vignette counts as served when its file is in this checkout (the push
 * delivers it) or its key is already deployed (an earlier push delivered it).
 * Any other registered vignette makes the push fail before it writes anything.
 * The order that works: push the files from a checkout that has them, then
 * merge the registry.
 */
export interface RegisteredVignette {
  key: string;
  /** The vignette's file exists in this checkout. */
  inCheckout: boolean;
}

/** Keys registered locally whose content is neither in this checkout nor deployed. */
export function vignettesWithoutContent(registered: RegisteredVignette[], deployedKeys: Iterable<string>): string[] {
  const deployed = new Set(deployedKeys);
  return registered.filter(v => !v.inCheckout && !deployed.has(v.key)).map(v => v.key);
}

/**
 * The refusal, by count only: keys can name unpublished work, and the CI log
 * that prints this is wider than the project.
 */
export function withoutContentMessage(count: number, project: string): string {
  return `ABORT: ${count} vignette(s) registered in projects/${project}/project.json have content ` +
    'neither in this checkout nor on the deployment, so their links would answer as unknown. ' +
    'Nothing was pushed. Push from a checkout that has the vignette files first ' +
    `(npx tsx tools/push-content.ts ${project} --url <deployment-url>), then merge the registry.`;
}
