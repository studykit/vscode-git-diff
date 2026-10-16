---
name: git-diff-view
description: "Open repository comparisons in the Git Diff View VS Code extension using git-diff-view. Use when the user asks to view branch, commit, or working-tree changes in VS Code, or explicitly requests git-diff-view. Ordinary textual Git diffs and code review do not require this skill."
---

# Git Diff View

Use the installed `git-diff-view` CLI to open a comparison in VS Code. It waits for the
`studykit.git-diff-view` extension to resolve and display the comparison, then reports success
or failure. It does not return diff text or review findings.

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
- To compare two commits, branches, or tags, supply both `base` and `head`. This defaults to
  **direct** mode. Use `--merge-base` explicitly for changes since the two refs diverged.

With no `head`, the right side is the repository's current working tree, including saved
uncommitted changes and untracked files. With `head`, it is that ref's committed files;
working-tree changes are excluded. Opening a comparison never requires switching branches.

## Launch

Supported syntax:

```sh
git-diff-view [repo] [base] [head] [--direct | --merge-base] [--timeout SECONDS]
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

# Compare two committed revisions directly, without checking either out.
git-diff-view . HEAD~2 HEAD~1

# Use the installed absolute path when it is missing from PATH.
"$HOME/.local/bin/git-diff-view" . origin/main
```

Use the executable located above and the user's actual repository and refs. The default wait
for confirmation is 30 seconds. File filters, timeline navigation, and **Open All Changes** are
controls in the extension's sidebar, not CLI flags.

## Report the result

On success, reply with one short confirmation in the user's language, for example
"두 커밋 비교를 열었습니다." Identify the refs only when needed to distinguish multiple requests.
Omit window-routing details, repeated repository/base/mode summaries, timeline instructions,
verification caveats, and follow-up offers unless the user asks for them.

Exit 0 confirms that the extension resolved the refs, loaded the changed-file list, and
revealed the comparison in a visible sidebar. A timeout or extension error exits nonzero;
report that concrete error briefly and resolve the cause before retrying. Never turn a
timeout into a success claim. Do not infer review findings from a successful launch.
For a textual diff or code review, inspect Git and the files separately.
