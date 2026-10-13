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

## Open a comparison

```sh
bin/git-diff-view [repo] [base] [--direct]
```

`repo` defaults to the current directory and `base` to the remote's default branch. The
comparison opens in the last active VS Code window. From VS Code: **Git Diff: Compare Repo with
Ref…**.
