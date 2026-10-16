const { vscode, state } = require("./vscode.cjs");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolve } = require("../out/model");
const { allRange, Tree, sideUris } = require("../out/tree");
const { ContentProvider } = require("../out/content");
const { activate } = require("../out/extension");

let repo, base, target, current;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const write = (file, content) => fs.writeFile(path.join(repo, file), content);
const stored = (extra = {}) => ({ id: "test", repo, base, mode: "direct", ...extra });
const viewState = () => ({ flat: true, showAll: true, oldestFirst: false });

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-diff-view-test-"));
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.invalid");
  await write("shared.txt", "base\n");
  await write("removed.txt", "rename me\n");
  git("add", "."); git("commit", "-qm", "Base"); base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "topic");
  await write("shared.txt", "topic\n");
  git("mv", "removed.txt", "renamed.txt");
  await write("topic.txt", "topic only\n");
  git("add", "."); git("commit", "-qm", "Topic"); target = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await write("shared.txt", "main\n");
  await write("main.txt", "main only\n");
  git("add", "."); git("commit", "-qm", "Main"); current = git("rev-parse", "HEAD");
  await write("shared.txt", "unsaved to git\n");
  await write("untracked.txt", "untracked\n");
});
after(async () => { await fs.rm(repo, { recursive: true, force: true }); });

async function resolved(extra) {
  const result = await resolve(stored(extra));
  assert.equal(result.ok, true, result.error);
  return result.value;
}

test("two refs use the selected commit, excluding current HEAD and all dirty files", async () => {
  const status = git("status", "--porcelain");
  const cmp = await resolved({ head: "topic" });
  assert.equal(cmp.head.sha, target);
  assert.equal(cmp.dirty, false);
  assert.deepEqual(cmp.commits.map(c => c.sha), [target]);
  const spec = allRange(cmp);
  assert.equal(spec.right.rev, target);
  const tree = new Tree(viewState);
  tree.setResolutions([{ ok: true, value: cmp }]);
  const changes = await tree.changes(cmp, spec);
  assert.deepEqual(changes.map(c => [c.status, c.path]), [["R", "renamed.txt"], ["M", "shared.txt"], ["A", "topic.txt"]]);
  const provider = new ContentProvider();
  const [, uri] = sideUris(repo, spec, changes.find(c => c.path === "shared.txt"));
  assert.equal(await provider.provideTextDocumentContent(uri), "topic\n");
  const root = tree.rootFor("test");
  const children = await tree.getChildren(root);
  assert.equal(children.find(n => n.kind === "range").extra, `${base} ↔ topic`);
  const timeline = await tree.getChildren(children.find(n => n.kind === "timeline"));
  assert.equal(timeline.some(n => n.spec?.right.rev === "worktree"), false);
  const entries = await tree.getChildren(children.find(n => n.kind === "range"));
  assert.equal(entries.some(n => ["main.txt", "untracked.txt"].includes(n.entry.path)), false);
  assert.equal(git("rev-parse", "HEAD"), current);
  assert.equal(git("status", "--porcelain"), status);
});

test("merge-base is calculated against the selected head on a diverged branch", async () => {
  const cmp = await resolved({ base: "main", head: "topic", mode: "merge-base" });
  assert.equal(cmp.left.sha, base);
  assert.equal(cmp.leftRef, "main 분기점");
  assert.equal(cmp.head.sha, target);
  assert.deepEqual(cmp.commits.map(c => c.sha), [target]);
});

test("an explicit HEAD compares committed files even with a dirty worktree", async () => {
  const cmp = await resolved({ head: "HEAD" });
  assert.equal(cmp.head.sha, current);
  assert.equal(cmp.dirty, false);
  assert.equal(allRange(cmp).right.rev, current);
});

test("legacy saved comparisons still include saved worktree and untracked files", async () => {
  const cmp = await resolved({});
  assert.equal(cmp.dirty, true);
  const spec = allRange(cmp);
  assert.equal(spec.right.rev, "worktree");
  const tree = new Tree(viewState);
  assert.ok((await tree.changes(cmp, spec)).some(c => c.path === "untracked.txt"));
  const provider = new ContentProvider();
  const [, uri] = sideUris(repo, spec, { status: "M", path: "shared.txt", oldPath: "shared.txt" });
  assert.equal(await provider.provideTextDocumentContent(uri), "unsaved to git\n");
});

test("invalid head and option-shaped refs return a resolution error", async () => {
  assert.equal((await resolve(stored({ head: "missing-ref" }))).ok, false);
  assert.equal((await resolve(stored({ head: "--all" }))).ok, false);
});

test("URI receipts follow successful display, report failures, and persist distinct heads", async () => {
  const values = new Map();
  activate({ subscriptions: [], globalState: { get: (key, def) => values.get(key) ?? def, update: async (key, value) => values.set(key, value) } });
  const request = "a".repeat(64);
  const receipt = path.join(os.tmpdir(), `git-diff-view-${request}-test.json`);
  const open = async (head, extra = {}) => {
    await fs.writeFile(receipt, "", { mode: 0o600, flag: "wx" });
    try {
      const query = new URLSearchParams({ repo, base, head, receipt, request, ...extra });
      await state.uriHandler.handleUri(vscode.Uri.parse("vscode://studykit.git-diff-view/open?" + query));
      return JSON.parse(await fs.readFile(receipt, "utf8"));
    } finally {
      await fs.rm(receipt, { force: true });
    }
  };
  try {
    const response = await open("topic");
    assert.equal(response.ok, true);
    assert.equal(response.right, target);
    assert.equal(response.mode, "direct");
    assert.equal(response.changedFiles, 3);
    assert.equal(state.view.visible, true);
    assert.equal(state.view.selection[0].res.value.head.sha, target);
    let queuedRefresh;
    state.onReveal = async () => {
      const before = await state.view.treeDataProvider.getChildren();
      queuedRefresh = state.commands.get("gitDiff.refresh")();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await state.view.treeDataProvider.getChildren())[0], before[0], "a focus refresh must wait until reveal finishes");
    };
    await open("topic");
    state.onReveal = undefined;
    await queuedRefresh;
    assert.equal(values.get("gitDiff.comparisons").length, 1);
    await open("main");
    assert.equal(values.get("gitDiff.comparisons").length, 2);
    assert.equal(values.get("gitDiff.comparisons")[0].head, "main");
    const failed = await open("missing-ref");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /missing-ref/);
    assert.equal(values.get("gitDiff.comparisons").length, 2);
    state.failReveal = true;
    assert.match((await open("topic")).error, /Reveal failed/);
    state.failReveal = false;
    state.view.visible = false;
    state.hideView = true;
    assert.match((await open("topic")).error, /not visible/);
    state.hideView = false;
    state.onReveal = undefined;
    assert.equal((await open("topic", { mode: "unknown" })).ok, false);
    const children = await state.view.treeDataProvider.getChildren();
    assert.equal(children.length, 2);
  } finally {
    state.failReveal = false;
    state.hideView = false;
  }
});
