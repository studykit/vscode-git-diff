// Run with VS Code's --extensionTestsPath, using an isolated user-data directory.
const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { contentUri } = require("../out/content");

exports.run = async () => {
  const extension = vscode.extensions.getExtension("studykit.git-diff-view");
  await extension.activate();
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-diff-view-host-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(repo, "file.txt"), "before\n");
    git("add", "."); git("commit", "-qm", "Before");
    const base = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "file.txt"), "after\n");
    git("commit", "-qam", "After");
    const head = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "file.txt"), "dirty\n");

    async function open(extra) {
      const request = crypto.randomBytes(32).toString("hex");
      const receipt = path.join(os.tmpdir(), `git-diff-view-${request}-host.json`);
      await fs.writeFile(receipt, "", { mode: 0o600, flag: "wx" });
      try {
        const query = new URLSearchParams({ repo, base, head, mode: "direct", receipt, request, ...extra });
        const uri = vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: extension.id, path: "/open", query: query.toString() });
        const external = await vscode.env.asExternalUri(uri);
        assert.equal(await vscode.env.openExternal(external), true);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const data = await fs.readFile(receipt, "utf8");
          if (data.endsWith("\n")) return JSON.parse(data);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("No receipt from the real VS Code URI handler");
      } finally { await fs.rm(receipt, { force: true }); }
    }

    const direct = await open({});
    assert.equal(direct.ok, true, direct.error);
    assert.equal(direct.left, base);
    assert.equal(direct.right, head);
    assert.equal(direct.changedFiles, 1);
    const left = await vscode.workspace.openTextDocument(contentUri(repo, base, "file.txt", "before"));
    const right = await vscode.workspace.openTextDocument(contentUri(repo, head, "file.txt", "after"));
    assert.equal(left.getText(), "before\n");
    assert.equal(right.getText(), "after\n");
    await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, "Host verification");
    assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputTextDiff));
    const merge = await open({ mode: "merge-base" });
    assert.equal(merge.ok, true, merge.error);
    const invalid = await open({ head: "missing-ref" });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /missing-ref/);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(await fs.readFile(path.join(repo, "file.txt"), "utf8"), "dirty\n");
    console.log("HOST PASS: visible comparisons, commit contents, diff editor, merge-base, and error receipt");
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
};
