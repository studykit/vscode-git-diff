import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function installCli(extensionPath: string): Promise<void> {
  if (process.platform === "win32") {
    void vscode.window.showErrorMessage("Git Diff: git-diff-view 설치는 macOS와 Linux에서 지원합니다.");
    return;
  }

  const directory = path.join(os.homedir(), ".local", "bin");
  const destination = path.join(directory, "git-diff-view");
  let temporary: string | undefined;
  try {
    const script = await fs.readFile(path.join(extensionPath, "bin", "git-diff-view"));
    let exists = false;
    try {
      const stat = await fs.lstat(destination);
      if (stat.isDirectory()) throw new Error(`${destination} 경로에 폴더가 있습니다.`);
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (exists) {
      const current = await fs.readFile(destination).catch(() => undefined);
      if (!current?.equals(script)) {
        const replace = await vscode.window.showWarningMessage(
          `Git Diff: ${destination} 파일이 이미 있습니다. 교체할까요?`,
          { modal: true },
          "Replace",
        );
        if (replace !== "Replace") return;
      }
    }

    await fs.mkdir(directory, { recursive: true });
    // Replace the entry atomically, without writing through an existing symlink.
    temporary = await fs.mkdtemp(path.join(directory, ".git-diff-view-"));
    const staged = path.join(temporary, "git-diff-view");
    await fs.writeFile(staged, script, { mode: 0o755 });
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, destination);

    const onPath = (process.env.PATH ?? "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === directory);
    if (onPath) {
      void vscode.window.showInformationMessage(`Git Diff: ${destination} 설치 완료. 터미널에서 git-diff-view를 실행하세요.`);
    } else {
      const copy = await vscode.window.showInformationMessage(
        `Git Diff: ${destination} 설치 완료. 터미널에서 사용하려면 ~/.local/bin을 PATH에 추가하세요.`,
        "Copy PATH Command",
      );
      if (copy) await vscode.env.clipboard.writeText('export PATH="$HOME/.local/bin:$PATH"');
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Git Diff: git-diff-view 설치 실패: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
