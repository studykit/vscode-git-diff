import { constants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type OpenResult =
  | { ok: true; repo: string; base: string; head: string; mode: string; left: string; right: string; changedFiles: number }
  | { ok: false; error: string };

/** Fill only an existing, private CLI receipt in an OS temporary directory. */
export async function sendResult(query: URLSearchParams, result: OpenResult): Promise<void> {
  const receipt = query.get("receipt");
  const request = query.get("request");
  if (receipt === null && request === null) return; // Older launchers do not wait for a receipt.
  if (!receipt || !request || !/^[a-f0-9]{64}$/.test(request)
    || !new RegExp(`^git-diff-view-${request}-[a-zA-Z0-9_-]+\\.json$`).test(path.basename(receipt))) {
    throw new Error("Invalid CLI receipt parameters.");
  }
  const directory = await fs.realpath(path.dirname(receipt));
  const allowed = await Promise.all([os.tmpdir(), "/tmp"].map((dir) => fs.realpath(dir).catch(() => undefined)));
  if (!allowed.includes(directory)) throw new Error("CLI receipt must be in an OS temporary directory.");
  // Do not create or truncate a path supplied by a URI, or follow a file symlink.
  const file = await fs.open(receipt, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 0 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("CLI receipt must be an empty private file owned by the current user.");
    }
    await file.writeFile(JSON.stringify({ request, ...result }) + "\n");
  } finally {
    await file.close();
  }
}
