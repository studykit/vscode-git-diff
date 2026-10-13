import { execFile } from "node:child_process";
import * as path from "node:path";

/** git's well-known empty tree; the "parent" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Status = "A" | "M" | "D" | "R";

export interface Change {
  status: Status;
  /** Path on the right-hand side (the old path for a deletion). */
  path: string;
  /** Path on the left-hand side; differs from `path` only for a rename. */
  oldPath: string;
}

export interface CommitInfo {
  sha: string;
  short: string;
  subject: string;
  date: string;
  /** First parent, or the empty tree for a root commit. */
  parent: string;
}

export function git(repo: string, args: string[], maxBuffer = 256 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, maxBuffer, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function gitBuffer(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")}: ${stderr.toString().trim() || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function toplevel(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
}

/** The repo's name; for a linked worktree, the name of the main checkout it belongs to. */
export async function repoName(repo: string): Promise<string> {
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const main = path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "");
  return path.basename(main);
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return (await git(repo, ["merge-base", a, b])).trim();
}

export async function currentBranch(repo: string): Promise<string | undefined> {
  const name = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return name === "HEAD" ? undefined : name;
}

/** The remote's default branch (origin/HEAD), falling back to develop, main, master. */
export async function defaultBase(repo: string): Promise<string> {
  try {
    const ref = (await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (ref) return ref;
  } catch {
    // origin/HEAD is not set; try the usual names.
  }
  for (const candidate of ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"]) {
    try {
      await revParse(repo, candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return "HEAD";
}

export async function refs(repo: string): Promise<string[]> {
  const out = await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"]);
  return out.split("\n").filter((r) => r && !r.endsWith("/HEAD"));
}

const LOG_FORMAT = "%H%x00%h%x00%s%x00%cd%x00%P";
const DATE_FORMAT = "--date=format:%Y-%m-%d %H:%M";

function parseLog(out: string): CommitInfo[] {
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, short, subject, date, parents] = rec.split("\x00");
      return { sha, short, subject, date, parent: parents.trim().split(" ")[0] || EMPTY_TREE };
    });
}

export async function commitInfo(repo: string, rev: string): Promise<CommitInfo> {
  const out = await git(repo, ["log", "-1", `--format=%x1e${LOG_FORMAT}`, DATE_FORMAT, rev]);
  return parseLog(out)[0];
}

/** Commits in `from..to`, newest first. */
export async function commitsBetween(repo: string, from: string, to: string): Promise<CommitInfo[]> {
  const out = await git(repo, ["log", "--topo-order", `--format=%x1e${LOG_FORMAT}`, DATE_FORMAT, `${from}..${to}`]);
  return parseLog(out);
}

function parseNameStatus(out: string): Change[] {
  const tokens = out.split("\x00").filter((t) => t !== "");
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++];
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      changes.push(kind === "R" ? { status: "R", path, oldPath } : { status: "A", path, oldPath: path });
    } else {
      const path = tokens[i++];
      const status: Status = kind === "A" ? "A" : kind === "D" ? "D" : "M";
      changes.push({ status, path, oldPath: path });
    }
  }
  return changes;
}

/** Changes from `left` to `right`; `right` undefined means the working tree, untracked files included. */
export async function diff(repo: string, left: string, right?: string): Promise<Change[]> {
  const args = ["diff", "--name-status", "-z", "-M", "--no-ext-diff", left];
  if (right) args.push(right);
  const changes = parseNameStatus(await git(repo, args));
  if (!right) {
    const seen = new Set(changes.map((c) => c.path));
    for (const path of await untracked(repo)) {
      if (!seen.has(path)) changes.push({ status: "A", path, oldPath: path });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function untracked(repo: string): Promise<string[]> {
  const out = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\x00").filter(Boolean);
}

/** Every file at `rev`; `rev` undefined means the working tree (tracked plus untracked). */
export async function listFiles(repo: string, rev?: string): Promise<string[]> {
  const out = rev
    ? await git(repo, ["ls-tree", "-r", "-z", "--name-only", rev])
    : await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(out.split("\x00").filter(Boolean))];
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ["status", "--porcelain", "--untracked-files=normal"])).trim() !== "";
}

export async function show(repo: string, rev: string, path: string): Promise<Buffer | undefined> {
  try {
    return await gitBuffer(repo, ["show", `${rev}:${path}`]);
  } catch {
    return undefined;
  }
}
