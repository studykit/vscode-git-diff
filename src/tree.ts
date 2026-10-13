import * as vscode from "vscode";
import * as path from "node:path";
import * as git from "./git";
import { contentUri, Rev } from "./content";
import { Filter, isActive, Matcher } from "./filter";
import { Resolution, Resolved } from "./model";

export const ITEM_SCHEME = "gitdiff-item";

/** One side of a range, with what its tab title and CodeLens call it. */
export interface Side {
  rev: Rev;
  /** Short form for a tab title, e.g. `2ac41a0 (origin/develop 분기점)`. */
  short: string;
  /** Full form for the CodeLens, commit subject included. */
  long: string;
}

export interface RangeSpec {
  id: string;
  left: Side;
  right: Side;
}

type FileEntry = { name: string; path: string; status?: git.Status; change?: git.Change };
interface Dir {
  dirs: Map<string, Dir>;
  files: FileEntry[];
  changes: number;
}

export type Node =
  | { kind: "comparison"; res: Resolution }
  | { kind: "side"; parent: Node; arrow: "◀" | "▶"; side: Side; detail: string }
  | { kind: "range"; parent: Node; cmp: Resolved; spec: RangeSpec; label: string; icon: string; extra?: string; tooltip?: string }
  | { kind: "timeline"; parent: Node; cmp: Resolved }
  | { kind: "base"; parent: Node; cmp: Resolved }
  | { kind: "folder"; parent: Node; range: RangeNode; name: string; dir: Dir; key: string }
  | { kind: "file"; parent: Node; range: RangeNode; entry: FileEntry };
export type RangeNode = Extract<Node, { kind: "range" }>;

export interface ViewState {
  filter?: Filter;
  showAll: boolean;
  /** Files as one flat list, each with its folder as the description, instead of a folder tree. */
  flat: boolean;
  oldestFirst: boolean;
}

function worktreeSide(cmp: Resolved): Side {
  const tag = cmp.dirty ? `${cmp.head.short}+작업중` : cmp.head.short;
  return {
    rev: "worktree",
    short: `${tag} (${cmp.branch})`,
    long: `▶ ${tag} ${cmp.branch} · ${cmp.head.subject}${cmp.dirty ? " + 커밋 안 한 변경" : ""}`,
  };
}

export function allRange(cmp: Resolved): RangeSpec {
  return {
    id: `${cmp.stored.id}/all`,
    left: { rev: cmp.left.sha, short: `${cmp.left.short} (${cmp.leftRef})`, long: `◀ ${cmp.left.short} ${cmp.leftRef} · ${cmp.left.subject}` },
    right: worktreeSide(cmp),
  };
}

function commitRange(cmp: Resolved, c: git.CommitInfo): RangeSpec {
  const parent = c.parent === git.EMPTY_TREE ? "(root)" : `${c.short}^`;
  return {
    id: `${cmp.stored.id}/c/${c.sha}`,
    left: { rev: c.parent, short: parent, long: `◀ ${parent} 부모 커밋` },
    right: { rev: c.sha, short: c.short, long: `▶ ${c.short} · ${c.subject}` },
  };
}

function wipRange(cmp: Resolved): RangeSpec {
  return {
    id: `${cmp.stored.id}/wip`,
    left: { rev: cmp.head.sha, short: `${cmp.head.short} (HEAD)`, long: `◀ ${cmp.head.short} HEAD ${cmp.branch} · ${cmp.head.subject}` },
    right: { rev: "worktree", short: `작업중 (${cmp.branch})`, long: `▶ 작업중 ${cmp.branch} · 커밋 안 한 변경` },
  };
}

export function sideUris(repo: string, spec: RangeSpec, change: git.Change): [vscode.Uri, vscode.Uri] {
  const leftRev: Rev = change.status === "A" ? "empty" : spec.left.rev;
  const rightRev: Rev = change.status === "D" ? "empty" : spec.right.rev;
  return [contentUri(repo, leftRev, change.oldPath, spec.left.long), contentUri(repo, rightRev, change.path, spec.right.long)];
}

export class Tree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private resolutions: Resolution[] = [];
  private changeCache = new Map<string, Promise<git.Change[]>>();
  private fileCache = new Map<string, Promise<string[]>>();
  private roots: Node[] = [];

  constructor(private readonly state: () => ViewState) {}

  setResolutions(resolutions: Resolution[]): void {
    this.resolutions = resolutions;
    this.changeCache.clear();
    this.fileCache.clear();
    this.roots = resolutions.map((res) => ({ kind: "comparison", res }));
    this.changed.fire(undefined);
  }

  rerender(): void {
    this.changed.fire(undefined);
  }

  rootFor(id: string): Node | undefined {
    return this.roots.find((n) => n.kind === "comparison" && n.res.ok === true && n.res.value.stored.id === id);
  }

  changes(cmp: Resolved, spec: RangeSpec): Promise<git.Change[]> {
    let p = this.changeCache.get(spec.id);
    if (!p) {
      const right = spec.right.rev === "worktree" ? undefined : spec.right.rev;
      p = git.diff(cmp.stored.repo, spec.left.rev, right);
      this.changeCache.set(spec.id, p);
    }
    return p;
  }

  private files(cmp: Resolved, spec: RangeSpec): Promise<string[]> {
    const key = `${cmp.stored.id}:${spec.right.rev}`;
    let p = this.fileCache.get(key);
    if (!p) {
      p = git.listFiles(cmp.stored.repo, spec.right.rev === "worktree" ? undefined : spec.right.rev);
      this.fileCache.set(key, p);
    }
    return p;
  }

  /** The changes that pass the filter, for the tree and for Open All. */
  async visibleChanges(cmp: Resolved, spec: RangeSpec): Promise<git.Change[]> {
    const m = new Matcher(this.state().filter);
    return (await this.changes(cmp, spec)).filter((c) => m.matches(c.path, c.status));
  }

  /** Every folder under `node` that holds a change; Expand All reveals each of them. */
  async changedFolders(node: Node): Promise<Node[]> {
    const out: Node[] = [];
    const walk = async (n: Node): Promise<void> => {
      for (const child of await this.getChildren(n)) {
        if (child.kind === "folder" && child.dir.changes > 0) {
          out.push(child);
          await walk(child);
        } else if (child.kind === "range" || child.kind === "timeline") {
          await walk(child);
        }
      }
    };
    await walk(node);
    return out;
  }

  getParent(node: Node): Node | undefined {
    return node.kind === "comparison" ? undefined : node.parent;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.roots;
    switch (node.kind) {
      case "comparison": {
        if (!node.res.ok) return [];
        const cmp = node.res.value;
        const all = allRange(cmp);
        return [
          { kind: "side", parent: node, arrow: "◀", side: all.left, detail: `${cmp.leftRef} · ${cmp.left.subject}` },
          {
            kind: "side",
            parent: node,
            arrow: "▶",
            side: all.right,
            detail: `${cmp.branch} · ${cmp.head.subject}${cmp.dirty ? " + 커밋 안 한 변경" : ""}`,
          },
          { kind: "range", parent: node, cmp, spec: all, label: "전체 변경", icon: "layers", extra: "분기점 ↔ worktree" },
          { kind: "timeline", parent: node, cmp },
        ];
      }
      case "timeline":
        return this.timeline(node);
      case "range":
        return this.rangeChildren(node);
      case "folder":
        return this.dirChildren(node.range, node.dir, node, node.key);
      default:
        return [];
    }
  }

  private timeline(node: Extract<Node, { kind: "timeline" }>): Node[] {
    const cmp = node.cmp;
    const total = cmp.commits.length;
    const items: Node[] = [];
    if (cmp.dirty) {
      items.push({ kind: "range", parent: node, cmp, spec: wipRange(cmp), label: "커밋 안 한 변경", icon: "edit", extra: "작업중 · HEAD ↔ worktree" });
    }
    cmp.commits.forEach((c, i) => {
      items.push({
        kind: "range",
        parent: node,
        cmp,
        spec: commitRange(cmp, c),
        label: `${c.short} ${c.subject}`,
        icon: "git-commit",
        extra: `${c.date.slice(5)} · ${total - i}/${total}`,
        tooltip: `${c.sha}\n${c.date}\n${c.subject}`,
      });
    });
    items.push({ kind: "base", parent: node, cmp });
    return this.state().oldestFirst ? items.reverse() : items;
  }

  private async rangeChildren(node: RangeNode): Promise<Node[]> {
    const { cmp, spec } = node;
    const m = new Matcher(this.state().filter);
    const changes = (await this.changes(cmp, spec)).filter((c) => m.matches(c.path, c.status));
    const entries: FileEntry[] = changes.map((c) => ({ name: path.posix.basename(c.path), path: c.path, status: c.status, change: c }));
    if (this.state().showAll) {
      const changed = new Set(changes.map((c) => c.path));
      const allChanged = new Set((await this.changes(cmp, spec)).map((c) => c.path));
      for (const p of await this.files(cmp, spec)) {
        if (!changed.has(p) && !allChanged.has(p) && m.matches(p)) entries.push({ name: path.posix.basename(p), path: p });
      }
    }
    if (this.state().flat) {
      return entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => ({ kind: "file" as const, parent: node, range: node, entry }));
    }
    const root: Dir = { dirs: new Map(), files: [], changes: 0 };
    for (const e of entries) {
      const parts = e.path.split("/");
      parts.pop();
      let d = root;
      if (e.status) d.changes++;
      for (const part of parts) {
        let next = d.dirs.get(part);
        if (!next) {
          next = { dirs: new Map(), files: [], changes: 0 };
          d.dirs.set(part, next);
        }
        d = next;
        if (e.status) d.changes++;
      }
      d.files.push(e);
    }
    return this.dirChildren(node, root, node, spec.id);
  }

  private dirChildren(range: RangeNode, dir: Dir, parent: Node, key: string): Node[] {
    const folders: Node[] = [...dir.dirs.entries()]
      .map(([name, d]) => {
        // Collapse a chain of single-child folders into one row.
        while (d.files.length === 0 && d.dirs.size === 1) {
          const [k, v] = [...d.dirs.entries()][0];
          name = `${name}/${k}`;
          d = v;
        }
        return { kind: "folder" as const, parent, range, name, dir: d, key: `${key}/${name}` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const files: Node[] = [...dir.files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ kind: "file" as const, parent, range, entry }));
    return [...folders, ...files];
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case "comparison":
        return this.comparisonItem(node);
      case "side": {
        const item = new vscode.TreeItem(`${node.arrow} ${node.side.short.split(" ")[0]}`, vscode.TreeItemCollapsibleState.None);
        item.description = node.detail;
        item.tooltip = node.side.long;
        item.contextValue = "side";
        return item;
      }
      case "timeline": {
        const item = new vscode.TreeItem("타임라인", vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.cmp.stored.id}/timeline`;
        item.iconPath = new vscode.ThemeIcon("history");
        item.description = `${node.cmp.commits.length} commits · ${this.state().oldestFirst ? "과거 → 최신 ↓" : "최신 → 과거 ↓"}`;
        return item;
      }
      case "base": {
        const c = node.cmp.left;
        const item = new vscode.TreeItem(`${c.short} ${node.cmp.leftRef}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("milestone");
        item.description = `${c.date.slice(5)} · ${c.subject}`;
        item.tooltip = `${c.sha}\n${c.date}\n${c.subject}`;
        return item;
      }
      case "range":
        return this.rangeItem(node);
      case "folder": {
        // A folder holding changes opens by default, so a deep path does not take one click per level.
        const state = node.dir.changes > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.name, state);
        item.contextValue = "folder";
        item.id = node.key;
        item.iconPath = vscode.ThemeIcon.Folder;
        const dim = this.state().showAll && node.dir.changes === 0;
        item.resourceUri = vscode.Uri.from({ scheme: ITEM_SCHEME, path: "/" + node.name, query: dim ? "st=U" : "st=" });
        if (this.state().showAll && node.dir.changes > 0) item.description = `● ${node.dir.changes}`;
        return item;
      }
      case "file":
        return this.fileItem(node);
    }
  }

  private comparisonItem(node: Extract<Node, { kind: "comparison" }>): vscode.TreeItem {
    const res = node.res;
    if (!res.ok) {
      const item = new vscode.TreeItem(path.basename(res.stored.repo), vscode.TreeItemCollapsibleState.None);
      item.id = res.stored.id;
      item.iconPath = new vscode.ThemeIcon("error");
      item.description = `${res.stored.base} — ${res.error}`;
      item.tooltip = `${res.stored.repo}\n${res.error}`;
      item.contextValue = "comparison";
      return item;
    }
    const cmp = res.value;
    const item = new vscode.TreeItem(cmp.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = cmp.stored.id;
    item.iconPath = new vscode.ThemeIcon("repo");
    item.description = `${cmp.left.short} ↔ ${cmp.head.short}${cmp.dirty ? "+작업중" : ""}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${cmp.stored.repo}**`,
        "",
        `◀ \`${cmp.left.short}\` ${cmp.leftRef} · ${cmp.left.subject}`,
        "",
        `▶ \`${cmp.head.short}\` ${cmp.branch} · ${cmp.head.subject}${cmp.dirty ? " + 커밋 안 한 변경" : ""}`,
        "",
        cmp.stored.mode === "merge-base" ? "merge-base부터 비교" : "base와 직접 비교",
      ].join("\n"),
    );
    item.contextValue = "comparison";
    return item;
  }

  private async rangeItem(node: RangeNode): Promise<vscode.TreeItem> {
    const all = await this.changes(node.cmp, node.spec);
    const filter = this.state().filter;
    const count = isActive(filter) ? `${(await this.visibleChanges(node.cmp, node.spec)).length} / ${all.length}` : `${all.length}`;
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.spec.id;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.description = [count, node.extra].filter(Boolean).join(" · ");
    item.tooltip = node.tooltip ?? `${node.spec.left.long}\n${node.spec.right.long}`;
    item.contextValue = "range";
    return item;
  }

  private fileItem(node: Extract<Node, { kind: "file" }>): vscode.TreeItem {
    const { entry, range } = node;
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.id = `${range.spec.id}::${entry.path}`;
    item.iconPath = vscode.ThemeIcon.File;
    item.resourceUri = vscode.Uri.from({ scheme: ITEM_SCHEME, path: "/" + entry.path, query: `st=${entry.status ?? "U"}` });
    const dir = path.posix.dirname(entry.path);
    item.description = [this.state().flat && dir !== "." ? dir : "", entry.change?.status === "R" ? `← ${entry.change.oldPath}` : ""]
      .filter(Boolean)
      .join("  ");
    item.tooltip = entry.path;
    item.command = entry.change
      ? { command: "gitDiff.openChange", title: "Open Diff", arguments: [range.cmp, range.spec, entry.change] }
      : { command: "gitDiff.openUnchanged", title: "Open File", arguments: [range.cmp, range.spec, entry.path] };
    return item;
  }
}

const COLORS: Record<string, string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  U: "disabledForeground",
};

/** Status letter and color on tree rows; unchanged files and folders are dimmed. */
export class StatusDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ITEM_SCHEME) return undefined;
    const st = new URLSearchParams(uri.query).get("st") ?? "";
    if (!COLORS[st]) return undefined;
    return new vscode.FileDecoration(st === "U" ? undefined : st, undefined, new vscode.ThemeColor(COLORS[st]));
  }
}
