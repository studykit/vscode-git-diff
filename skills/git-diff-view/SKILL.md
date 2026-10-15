---
name: git-diff-view
description: "Open repository comparisons in the Git Diff View VS Code extension using git-diff-view. Use when the user asks to view branch or working-tree changes in VS Code, or explicitly requests git-diff-view. Ordinary textual Git diffs and code review do not require this skill."
---

# Git Diff View

Use the installed `git-diff-view` CLI to request a comparison in VS Code. It dispatches a URI
to the `studykit.git-diff-view` extension; it does not return diff text or review findings.

## Find the command

This workflow requires a local macOS or Linux environment, the Git Diff View extension in VS Code,
`git`, and `python3`. The launcher uses `open` on macOS or `code --open-url` on Linux.

Locate `git-diff-view` on `PATH`. If it is absent, check whether
`$HOME/.local/bin/git-diff-view` is executable and use that absolute path. If neither is
available, tell the user to run **Git Diff: Install git-diff-view in ~/.local/bin** in VS Code.

## Choose the comparison

- Use the repository named by the user, or the current repository if none is named. Resolve
  its root with `git -C "${repo}" rev-parse --show-toplevel` when needed, and quote paths.
- Use the base ref supplied by the user. If none is supplied, omit it so the extension chooses
  its default: `origin/HEAD`, then available `origin/develop`, `origin/main`, `origin/master`,
  `develop`, `main`, or `master`, then `HEAD`.
- Use the default **merge-base** mode for changes since the current branch diverged from the
  base. Add `--direct` when the user wants the base ref's current commit compared directly
  with the working tree.

The right side is always the selected repository's current working tree, including saved
uncommitted changes and untracked files. Unsaved editor buffers are not included. The command
does not select another head branch; opening a comparison does not require switching branches
or modifying the repository.

## Launch

Supported syntax:

```sh
git-diff-view [repo] [base] [--direct]
```

Always supply the repository argument when supplying a base ref. For the current repository,
use `.` rather than passing the ref as the first argument.

```sh
# Current repository, automatically selected base, merge-base mode.
git-diff-view .

# Explicit repository and base; quote a path containing spaces.
git-diff-view "/path/to/my repo" origin/main

# Compare the selected base commit directly with the current files.
git-diff-view . origin/main --direct

# Use the installed absolute path when it is missing from PATH.
"$HOME/.local/bin/git-diff-view" . origin/main
```

Use the executable located above and the user's actual repository and ref. Available options
are `--direct` and `--help`. File filters, timeline navigation, and **Open All Changes** are
controls in the extension's sidebar, not CLI flags.

## Report the result

The comparison is sent to the last active VS Code window, even when that window has a
different workspace open. Report the repository, requested base (or automatic selection),
and comparison mode.

A successful CLI exit means the launcher accepted the URI. The extension handles it
asynchronously, so only claim that the comparison is visibly open if you have verified it in
VS Code. Do not infer file changes or review findings from the command's output.

If launching fails, report the concrete error and the missing prerequisite when identifiable.
If VS Code shows a repository or ref error, resolve that cause before sending the request
again. For a textual diff or code review, inspect Git and the files separately.
