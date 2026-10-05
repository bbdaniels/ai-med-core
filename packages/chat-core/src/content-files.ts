/**
 * Where a project content file is on disk.
 *
 * Some files a project serves are deliberately not in the repository (they are
 * gitignored: publisher-copyright PDFs, unpublished results). A deployment is
 * built from git, so those files are never in its checkout. They live instead in
 * a private store on a mounted volume (the API's PRIVATE_CONTENT_ROOT), at the
 * SAME repo-relative path they have in a checkout, and tools/push-content.ts
 * fills it. Every reader resolves a content path here, the checkout first and
 * the store second, so project.json names one path and it works in a checkout
 * and on a deployment alike. The API's tab and file routes and the chat
 * pipeline's grounding sets (chat/grounding.ts) all use it.
 */
import fs from 'fs/promises';
import path from 'path';
import { documentSetGroundingFiles, groundingSetFiles, tabContentFiles } from './project-config.js';

/** A repo-relative path under projects/, normalized; null for anything else. */
export function projectContentRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized.startsWith('../')) return null;
  if (!normalized.startsWith('projects/')) return null;
  return normalized;
}

/** Where a file lives in the private store; null when there is no store or the path escapes it. */
export function privateContentPath(privateRoot: string | null, rel: string): string | null {
  if (!privateRoot) return null;
  const root = path.resolve(privateRoot);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** The roots a content path is looked up under. */
export interface ContentRoots {
  repoRoot: string;
  /** The private store, or null when the deployment has none. */
  privateRoot: string | null;
}

/** The file on disk for a project content path: the checkout, then the private store; null when neither has it. */
export async function resolveProjectContentFile(rel: string, roots: ContentRoots): Promise<string | null> {
  const clean = projectContentRelPath(rel);
  if (!clean) return null;
  const candidates = [path.resolve(roots.repoRoot, clean), privateContentPath(roots.privateRoot, clean)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * Every path a project's private store may hold, repo-relative and normalized:
 * the files its tabs name, the files of the grounding sets it lists
 * (`groundingSets`), and the grounding set file of each document set its
 * documents form (`documentKeys`; documentSetGroundingFiles). The last lets a
 * set's file be uploaded before the project.json that lists the set is
 * deployed, the same order as the documents themselves: first opt-in is one
 * content push, then the merge.
 *
 * The one definition. The API's upload route accepts exactly these paths (with
 * the deployed project.json and the deployed documents' keys), and
 * tools/push-content.ts removes from the store only what is not among them, so
 * the push never deletes a file the store would take back.
 */
export function privateStoreFiles(slug: string, cfg: Record<string, any>, documentKeys: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of [...tabContentFiles(cfg), ...groundingSetFiles(slug, cfg), ...documentSetGroundingFiles(slug, documentKeys)]) {
    const clean = projectContentRelPath(f);
    if (clean) out.add(clean);
  }
  return out;
}
