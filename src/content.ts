import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as git from "./git";

export const CONTENT_SCHEME = "gitdiff";

/** `worktree` reads the file on disk; `empty` stands for the missing side of an add or delete. */
export type Rev = string | "worktree" | "empty";

interface Query {
  r: string;
  v: Rev;
  /** Text of the CodeLens shown above line 1. */
  l: string;
}

export function contentUri(repo: string, rev: Rev, file: string, lens: string): vscode.Uri {
  const query: Query = { r: repo, v: rev, l: lens };
  return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: "/" + file, query: JSON.stringify(query) });
}

function parse(uri: vscode.Uri): Query & { file: string } {
  return { ...(JSON.parse(uri.query) as Query), file: uri.path.replace(/^\//, "") };
}

/** Serves both sides of every diff, read-only: a commit through `git show`, the working tree from disk. */
export class ContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { r, v, file } = parse(uri);
    if (v === "empty") return "";
    if (v === "worktree") {
      try {
        return await fs.readFile(path.join(r, file), "utf8");
      } catch {
        return "";
      }
    }
    return (await git.show(r, v, file))?.toString("utf8") ?? "";
  }

  /** Re-reads the open working-tree documents, which change under us. */
  refreshWorktree(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === CONTENT_SCHEME && parse(doc.uri).v === "worktree") {
        this.changed.fire(doc.uri);
      }
    }
  }
}

/** One CodeLens above line 1 of each side, naming the revision that side shows. */
export class SideLabelLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== CONTENT_SCHEME) return [];
    const { l } = parse(doc.uri);
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: l, command: "gitDiff.noop" })];
  }
}
