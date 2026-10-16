const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { sendResult } = require("../out/receipt");

test("legacy requests without a receipt are supported", async () => {
  await sendResult(new URLSearchParams(), { ok: false, error: "test" });
});

test("receipts cannot create files, overwrite content, follow symlinks or write outside temp", async () => {
  const request = "b".repeat(64);
  const receipt = path.join(os.tmpdir(), `git-diff-view-${request}-security.json`);
  const other = path.join(os.tmpdir(), `git-diff-view-${request}-other.json`);
  const q = new URLSearchParams({ request, receipt });
  const result = { ok: false, error: "test" };
  try {
    await assert.rejects(sendResult(q, result), /ENOENT/);
    await fs.writeFile(receipt, "keep", { mode: 0o600, flag: "wx" });
    await assert.rejects(sendResult(q, result), /empty private file/);
    assert.equal(await fs.readFile(receipt, "utf8"), "keep");
    await fs.rm(receipt);
    await fs.writeFile(other, "", { mode: 0o600, flag: "wx" });
    await fs.symlink(other, receipt);
    await assert.rejects(sendResult(q, result), /ELOOP/);
    assert.equal(await fs.readFile(other, "utf8"), "");
    const elsewhere = new URLSearchParams({ request, receipt: path.join(__dirname, path.basename(receipt)) });
    await assert.rejects(sendResult(elsewhere, result), /OS temporary directory/);
    await assert.rejects(sendResult(new URLSearchParams({ request: "invalid", receipt }), result), /Invalid/);
  } finally {
    await fs.rm(receipt, { force: true });
    await fs.rm(other, { force: true });
  }
});
