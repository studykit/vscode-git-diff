const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const cli = path.resolve(__dirname, "../bin/git-diff-view");
let directory, repo, launcherDir;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "git-diff-view-cli-"));
  repo = path.join(directory, "repo with spaces 한글");
  launcherDir = path.join(directory, "bin");
  await fs.mkdir(repo); await fs.mkdir(launcherDir);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q", "--initial-branch=main");
  git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "Initial");
  git("branch", "topic/한글");
  const launcher = `#!/usr/bin/env node
const {sendResult} = require(${JSON.stringify(path.resolve(__dirname, "../out/receipt"))});
const q = new URL(process.argv.at(-1)).searchParams;
async function main() {
  if (process.env.GDV_TEST_MODE === "silent") return;
  if (process.env.GDV_TEST_MODE === "launch-error") { console.error("launcher failed"); process.exitCode = 3; return; }
  if (process.env.GDV_TEST_MODE === "extension-error") return sendResult(q, {ok:false, error:"Comparison view could not be revealed"});
  const result = {ok:true, repo:q.get("repo"), base:q.get("base") || "HEAD", head:q.get("head") || "worktree", mode:q.get("mode"), left:"a".repeat(40), right:"b".repeat(40), changedFiles:2};
  if (process.env.GDV_TEST_MODE === "wrong-request") q.set("request", "0".repeat(64));
  if (process.env.GDV_TEST_MODE === "wrong-head") result.head = "wrong";
  await sendResult(q, result).catch(() => {});
}
main().catch(error => { console.error(error); process.exitCode=1; });
`;
  await fs.writeFile(path.join(launcherDir, "open"), launcher, { mode: 0o755 });
  await fs.writeFile(path.join(launcherDir, "code"), launcher, { mode: 0o755 });
});
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function run(args = [], mode = "success") {
  return spawnSync(cli, [repo, ...args], {
    env: { ...process.env, PATH: launcherDir + path.delimiter + process.env.PATH, GDV_TEST_MODE: mode },
    encoding: "utf8", timeout: 5000,
  });
}

test("CLI waits for a valid extension receipt, including Unicode paths and refs", () => {
  const result = run(["HEAD", "topic/한글"]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "Opened comparison: aaaaaaaa ↔ bbbbbbbb (2 changed files).\n");
  assert.equal(result.stderr, "");
});

test("legacy default and direct working-tree commands still receive confirmation", () => {
  for (const args of [[], ["HEAD"], ["HEAD", "--direct"], ["HEAD", "topic/한글", "--merge-base"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("launcher exit zero without an extension receipt is a failure", () => {
  const result = run(["--timeout", "0.5"], "silent");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /timed out waiting for VS Code/);
});

test("errors from the extension and launcher are reported as failures", () => {
  const extension = run([], "extension-error");
  assert.equal(extension.status, 1);
  assert.match(extension.stderr, /Comparison view could not be revealed/);
  const launcher = run([], "launch-error");
  assert.equal(launcher.status, 1);
  assert.match(launcher.stderr, /launcher failed/);
});

test("receipts for a different request or comparison cannot confirm success", () => {
  for (const mode of ["wrong-request", "wrong-head"]) {
    const result = run(["--timeout", "0.5"], mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /timed out|Invalid comparison confirmation/);
  }
});

test("invalid refs, unknown flags, extra arguments and invalid timeouts fail early", () => {
  for (const args of [["missing-ref"], ["HEAD", "missing-ref"], ["--unknown"], ["HEAD", "HEAD", "ignored"], ["--timeout", "0"], ["--timeout", "nan"], ["--timeout", "inf"]]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});
