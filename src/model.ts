import * as git from "./git";

export type Mode = "merge-base" | "direct";

/** What persists across restarts; everything else is re-read from git. */
export interface StoredComparison {
  id: string;
  repo: string;
  base: string;
  /** Omitted for the working tree; otherwise the ref on the right. */
  head?: string;
  mode: Mode;
}

export interface Resolved {
  stored: StoredComparison;
  name: string;
  /** Left end of the comparison: the merge-base, or `base` itself in direct mode. */
  left: git.CommitInfo;
  /** How the left end is named, e.g. "origin/develop 분기점". */
  leftRef: string;
  head: git.CommitInfo;
  branch: string;
  dirty: boolean;
  /** `left..head`, newest first. */
  commits: git.CommitInfo[];
}

export type Resolution = { ok: true; value: Resolved } | { ok: false; stored: StoredComparison; error: string };

export async function resolve(stored: StoredComparison): Promise<Resolution> {
  try {
    const { repo, base, mode } = stored;
    const headSha = await git.revParse(repo, stored.head ?? "HEAD");
    const baseSha = await git.revParse(repo, base);
    const leftSha = mode === "merge-base" ? await git.mergeBase(repo, baseSha, headSha) : baseSha;
    const [left, head, branch, dirty, commits, name] = await Promise.all([
      git.commitInfo(repo, leftSha),
      git.commitInfo(repo, headSha),
      stored.head ? Promise.resolve(stored.head) : git.currentBranch(repo),
      stored.head ? Promise.resolve(false) : git.isDirty(repo),
      git.commitsBetween(repo, leftSha, headSha),
      git.repoName(repo),
    ]);
    const leftRef = mode === "merge-base" && leftSha !== baseSha ? `${base} 분기점` : base;
    return {
      ok: true,
      value: { stored, name, left, leftRef, head, branch: branch ?? "HEAD", dirty, commits },
    };
  } catch (e) {
    return { ok: false, stored, error: e instanceof Error ? e.message : String(e) };
  }
}
