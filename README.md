# Git Diff (VS Code extension)

Review a branch against a base ref in VS Code: a file tree of what changed, a commit timeline, and
read-only side-by-side diffs whose panes each name the commit they show. Design: [SPEC.md](SPEC.md).

## Build and install

```sh
npm install
npm run compile
npm run package        # → artifacts/git-diff.vsix
npm run install-ext    # code --install-extension artifacts/git-diff.vsix --force
```

After reinstalling, run **Developer: Reload Window** in windows that were already open.

## Install the terminal command

On macOS or Linux, run **Git Diff: Install git-diff-view in ~/.local/bin** from the Command
Palette (or the empty Comparisons view). This copies the bundled script to
`~/.local/bin/git-diff-view` and makes it executable. Run the command again after updating the
extension to update the installed script; replacing a different existing file requires confirmation.

If `~/.local/bin` is not on your `PATH`, add this to your shell startup file (for example, `~/.zshrc`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer also offers to copy this command when the directory is missing from `PATH`.
The [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)
specifies `$HOME/.local/bin` for user executables, but defines no environment variable for it.
The shell helper requires `git` and `python3`, plus `open` on macOS or `code` on Linux.

## Open a comparison

```sh
git-diff-view [repo] [base] [--direct]
```

`repo` defaults to the current directory and `base` to the remote's default branch. The
comparison opens in the last active VS Code window. From VS Code: **Git Diff: Compare Repo with
Ref…**.
