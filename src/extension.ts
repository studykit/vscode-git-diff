import * as vscode from "vscode";
import * as path from "node:path";
import * as git from "./git";
import { installCli } from "./cli";
import { CONTENT_SCHEME, ContentProvider, contentUri, SideLabelLens } from "./content";
import { ALL_STATUSES, describe, Filter, isActive } from "./filter";
import { Mode, resolve, Resolution, Resolved, StoredComparison } from "./model";
import { OpenResult, sendResult } from "./receipt";
import { allRange, Node, RangeSpec, sideUris, StatusDecorations, Tree, ViewState } from "./tree";

const KEY_COMPARISONS = "gitDiff.comparisons";
const KEY_FILTER = "gitDiff.filter";
const KEY_SHOW_ALL = "gitDiff.showAll";
const KEY_OLDEST_FIRST = "gitDiff.oldestFirst";
const KEY_FLAT = "gitDiff.flat";

export function activate(context: vscode.ExtensionContext): void {
  const store = context.globalState;
  const viewState = (): ViewState => ({
    filter: store.get<Filter>(KEY_FILTER),
    showAll: store.get<boolean>(KEY_SHOW_ALL, false),
    oldestFirst: store.get<boolean>(KEY_OLDEST_FIRST, false),
    flat: store.get<boolean>(KEY_FLAT, false),
  });
  const stored = (): StoredComparison[] => store.get<StoredComparison[]>(KEY_COMPARISONS, []);

  const log = vscode.window.createOutputChannel("Git Diff", { log: true });
  const content = new ContentProvider();
  const tree = new Tree(viewState);
  const view = vscode.window.createTreeView("gitDiff.tree", { treeDataProvider: tree, showCollapseAll: true });

  async function syncContext(): Promise<void> {
    const s = viewState();
    await vscode.commands.executeCommand("setContext", "gitDiff.filtered", isActive(s.filter));
    await vscode.commands.executeCommand("setContext", "gitDiff.showAll", s.showAll);
    await vscode.commands.executeCommand("setContext", "gitDiff.oldestFirst", s.oldestFirst);
    await vscode.commands.executeCommand("setContext", "gitDiff.flat", s.flat);
    view.message = isActive(s.filter) ? `필터: ${describe(s.filter)}` : undefined;
    const n = stored().length;
    view.badge = n ? { value: n, tooltip: `${n} comparisons` } : undefined;
  }

  let resolutions: Resolution[] = [];
  let viewQueue = Promise.resolve();
  function updateView<T>(work: () => Promise<T>): Promise<T> {
    const next = viewQueue.then(work);
    viewQueue = next.then(() => undefined, (e) => log.error(String(e)));
    return next;
  }

  async function refreshNow(): Promise<void> {
    resolutions = await Promise.all(stored().map(resolve));
    for (const r of resolutions) {
      if (r.ok) log.info(`resolved ${r.value.name}: ${r.value.left.short} (${r.value.leftRef}) ↔ ${r.value.head.short} ${r.value.branch}${r.value.dirty ? " +dirty" : ""}, ${r.value.commits.length} commits`);
      else log.warn(`unresolved ${r.stored.repo} ${r.stored.base}: ${r.error}`);
    }
    tree.setResolutions(resolutions);
    content.refreshWorktree();
    await syncContext();
  }

  function refresh(): Promise<void> {
    return updateView(refreshNow);
  }

  let pending: NodeJS.Timeout | undefined;
  function refreshSoon(): void {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => void refresh(), 300);
  }

  let openQueue: Promise<unknown> = Promise.resolve();
  function addComparison(repoPath: string, base?: string, mode: Mode = "merge-base", head?: string): Promise<OpenResult> {
    const next = openQueue.then(() => openComparison(repoPath, base, mode, head));
    openQueue = next.catch(() => undefined);
    return next;
  }

  async function openComparison(repoPath: string, base: string | undefined, mode: Mode, head: string | undefined): Promise<OpenResult> {
    const repo = await git.toplevel(repoPath);
    const ref = base || (await git.defaultBase(repo));
    const list = stored();
    let entry = list.find((c) => c.repo === repo && c.base === ref && c.head === head && c.mode === mode);
    if (!entry) {
      entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, repo, base: ref, head, mode };
      const checked = await resolve(entry);
      if (!checked.ok) throw new Error(checked.error);
      await store.update(KEY_COMPARISONS, [entry, ...list]);
    }
    // Focus/save refreshes must not replace tree elements while reveal is awaiting VS Code.
    return updateView(async () => {
      await refreshNow();
      await vscode.commands.executeCommand("workbench.view.extension.gitDiff");
      const node = tree.rootFor(entry.id);
      if (!node || node.kind !== "comparison" || !node.res.ok) {
        const failed = resolutions.find((r) => !r.ok && r.stored.id === entry.id);
        throw new Error(failed && !failed.ok ? failed.error : "Comparison could not be resolved.");
      }
      const cmp = node.res.value;
      const changes = await tree.changes(cmp, allRange(cmp));
      await view.reveal(node, { select: true, focus: false, expand: true });
      if (!view.visible) throw new Error("The comparison view is not visible.");
      return { ok: true, repo, base: ref, head: head ?? "worktree", mode, left: cmp.left.sha, right: cmp.head.sha, changedFiles: changes.length };
    });
  }

  function diffTitle(file: string, spec: RangeSpec): string {
    return `${path.posix.basename(file)}  ${spec.left.short} ↔ ${spec.right.short}`;
  }

  context.subscriptions.push(
    log,
    view,
    vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content),
    vscode.languages.registerCodeLensProvider({ scheme: CONTENT_SCHEME }, new SideLabelLens()),
    vscode.window.registerFileDecorationProvider(new StatusDecorations()),

    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== "/open") return;
        const q = new URLSearchParams(uri.query);
        let result: OpenResult;
        try {
          const repo = q.get("repo");
          if (!repo) throw new Error("repo 파라미터가 없습니다.");
          const head = q.get("head") ?? undefined;
          if (head !== undefined && !head.trim()) throw new Error("head ref가 비어 있습니다.");
          const mode = q.get("mode") ?? (head ? "direct" : "merge-base");
          if (mode !== "direct" && mode !== "merge-base") throw new Error(`Invalid comparison mode: ${mode}`);
          result = await addComparison(repo, q.get("base") ?? undefined, mode, head);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          log.error(error);
          void vscode.window.showErrorMessage(`Git Diff: ${error}`);
          result = { ok: false, error };
        }
        try {
          await sendResult(q, result);
        } catch (e) {
          log.warn(`Could not return CLI result: ${e}`);
        }
      },
    }),

    vscode.commands.registerCommand("gitDiff.noop", () => undefined),

    vscode.commands.registerCommand("gitDiff.installCli", () => installCli(context.extensionPath)),

    vscode.commands.registerCommand("gitDiff.open", () => pickComparison(false)),
    vscode.commands.registerCommand("gitDiff.compareRefs", () => pickComparison(true)),
  );

  async function pickComparison(twoRefs: boolean): Promise<void> {
    const candidates = new Set<string>([
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      ...stored().map((c) => c.repo),
    ]);
    const browse = "$(folder-opened) 폴더 선택…";
    const picked = await vscode.window.showQuickPick([...candidates, browse], { title: "Git Diff: 비교할 repo" });
    if (!picked) return;
    let repoPath = picked;
    if (picked === browse) {
      const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
      if (!dirs?.length) return;
      repoPath = dirs[0].fsPath;
    }
    try {
      const repo = await git.toplevel(repoPath);
      const def = await git.defaultBase(repo);
      if (twoRefs) {
        const validateInput = async (ref: string): Promise<string | undefined> => {
          try {
            await git.revParse(repo, ref);
            return undefined;
          } catch {
            return "Enter an existing commit, branch, or tag.";
          }
        };
        const base = await vscode.window.showInputBox({ title: "Git Diff: Base ref (left)", value: def, validateInput });
        if (base === undefined) return;
        const head = await vscode.window.showInputBox({ title: "Git Diff: Head ref (right)", value: "HEAD", validateInput });
        if (head !== undefined) await addComparison(repo, base, "direct", head);
        return;
      }
      const all = await git.refs(repo);
      const ref = await vscode.window.showQuickPick([def, ...all.filter((r) => r !== def)], {
        title: `Git Diff: ${path.basename(repo)}를 무엇과 비교할까요? (merge-base부터)`,
      });
      if (ref) await addComparison(repo, ref);
    } catch (e) {
      void vscode.window.showErrorMessage(`Git Diff: ${e instanceof Error ? e.message : e}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("gitDiff.remove", async (node?: Node) => {
      if (node?.kind !== "comparison") return;
      const id = node.res.ok ? node.res.value.stored.id : node.res.stored.id;
      await store.update(KEY_COMPARISONS, stored().filter((c) => c.id !== id));
      await refresh();
    }),

    vscode.commands.registerCommand("gitDiff.useMergeBase", (node?: Node) => setMode(node, "merge-base")),
    vscode.commands.registerCommand("gitDiff.useDirect", (node?: Node) => setMode(node, "direct")),

    vscode.commands.registerCommand("gitDiff.refresh", () => refresh()),

    vscode.commands.registerCommand("gitDiff.filter", async () => {
      const current = viewState().filter;
      const globs = await vscode.window.showInputBox({
        title: "Git Diff: 경로 필터",
        prompt: "glob을 쉼표로 구분합니다. !로 시작하면 제외입니다. 비우면 경로로 거르지 않습니다.",
        placeHolder: "**/*.kt, !**/test/**",
        value: current?.globs.join(", ") ?? "",
      });
      if (globs === undefined) return;
      const statusItems = ALL_STATUSES.map((s) => ({
        label: s,
        description: { A: "추가", M: "수정", D: "삭제", R: "이름 변경" }[s],
        picked: current ? current.statuses.includes(s) : true,
      }));
      const statuses = await vscode.window.showQuickPick(statusItems, { title: "Git Diff: 보여 줄 상태", canPickMany: true });
      if (!statuses) return;
      const filter: Filter = {
        globs: globs.split(",").map((g) => g.trim()).filter(Boolean),
        statuses: statuses.map((s) => s.label as git.Status),
      };
      await store.update(KEY_FILTER, isActive(filter) ? filter : undefined);
      await syncContext();
      tree.rerender();
    }),

    vscode.commands.registerCommand("gitDiff.clearFilter", async () => {
      await store.update(KEY_FILTER, undefined);
      await syncContext();
      tree.rerender();
    }),

    vscode.commands.registerCommand("gitDiff.showAllFiles", () => setFlag(KEY_SHOW_ALL, true)),
    vscode.commands.registerCommand("gitDiff.showChangedOnly", () => setFlag(KEY_SHOW_ALL, false)),
    vscode.commands.registerCommand("gitDiff.viewAsList", () => setFlag(KEY_FLAT, true)),
    vscode.commands.registerCommand("gitDiff.viewAsTree", () => setFlag(KEY_FLAT, false)),

    vscode.commands.registerCommand("gitDiff.expandAll", async (node?: Node) => {
      if (!node) return;
      const folders = await tree.changedFolders(node);
      await view.reveal(node, { expand: true, select: false, focus: false });
      for (const f of folders) await view.reveal(f, { expand: true, select: false, focus: false });
    }),

    vscode.commands.registerCommand("gitDiff.oldestFirst", () => setFlag(KEY_OLDEST_FIRST, true)),
    vscode.commands.registerCommand("gitDiff.newestFirst", () => setFlag(KEY_OLDEST_FIRST, false)),

    vscode.commands.registerCommand("gitDiff.openChange", async (cmp: Resolved, spec: RangeSpec, change: git.Change) => {
      const [left, right] = sideUris(cmp.stored.repo, spec, change);
      await vscode.commands.executeCommand("vscode.diff", left, right, diffTitle(change.path, spec), { preview: true });
    }),

    vscode.commands.registerCommand("gitDiff.openUnchanged", async (cmp: Resolved, spec: RangeSpec, file: string) => {
      const lens = spec.right.long.replace(/^▶/, "●") + " · 변경 없음";
      const doc = await vscode.workspace.openTextDocument(contentUri(cmp.stored.repo, spec.right.rev, file, lens));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand("gitDiff.openAll", async (node?: Node) => {
      let cmp: Resolved | undefined;
      let spec: RangeSpec | undefined;
      if (node?.kind === "comparison" && node.res.ok) {
        cmp = node.res.value;
        spec = allRange(cmp);
      } else if (node?.kind === "range") {
        cmp = node.cmp;
        spec = node.spec;
      }
      if (!cmp || !spec) return;
      const changes = await tree.visibleChanges(cmp, spec);
      if (!changes.length) {
        void vscode.window.showInformationMessage("Git Diff: 열 변경이 없습니다.");
        return;
      }
      const resources = changes.map((c) => {
        const [left, right] = sideUris(cmp.stored.repo, spec, c);
        return [right, left, right];
      });
      await vscode.commands.executeCommand("vscode.changes", `${cmp.name}  ${spec.left.short} ↔ ${spec.right.short}`, resources);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (stored().some((c) => doc.uri.fsPath.startsWith(c.repo + path.sep))) refreshSoon();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refreshSoon();
    }),
  );

  async function setFlag(key: string, value: boolean): Promise<void> {
    await store.update(key, value);
    await syncContext();
    tree.rerender();
  }

  async function setMode(node: Node | undefined, mode: Mode): Promise<void> {
    if (node?.kind !== "comparison") return;
    const id = node.res.ok ? node.res.value.stored.id : node.res.stored.id;
    await store.update(
      KEY_COMPARISONS,
      stored().map((c) => (c.id === id ? { ...c, mode } : c)),
    );
    await refresh();
  }

  void refresh();
}

export function deactivate(): void {}
