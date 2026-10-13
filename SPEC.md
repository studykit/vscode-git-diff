# vscode-git-diff — SPEC (v1)

A VS Code extension for reviewing a branch against a base ref: a file tree of what changed, a
side-by-side diff per file, and every pane labelled with the commit it shows.

UI mock: [`mock/ui.html`](mock/ui.html).

## Scope

v1 compares branches and refs only.

Out of v1:

- PR comparison (base/head from a PR number). Planned next.
- A "reviewed" check per file. It belongs to PR comparison and comes with it.
- A custom diff view. v1 uses VS Code's own diff editor.

## Distribution

- Source lives in `~/Github/vscode-git-diff`.
- Installed locally from a `.vsix`; not published to the marketplace.
- No runtime dependency beyond the `git` CLI.

## Launching a comparison

- URI: `vscode://studykit.git-diff/open?repo=<abs path>&base=<ref>`, sent with `open`.
  The last active VS Code window handles it; no attempt is made to route it to the window that
  has the repo open.
- A shell helper, `git-diff-view <repo> [base]`, builds that URI and sends it.
- A command palette entry picks a repo and a ref.

## Comparison range

- Default: merge-base of `base` and `HEAD` → working tree, including uncommitted changes and
  untracked files.
- Option: compare against `base` directly instead of the merge-base.

## View

- A dedicated Activity Bar icon opens the extension's sidebar. Its badge counts the stacked
  comparisons.
- Toolbar: new comparison, filter, commit order toggle, refresh, collapse all.

### Comparisons

- Each comparison is a top-level node. They stack; each has Open All and close (✕) actions.
- The stacked list persists across VS Code restarts.
- A comparison node shows both sides on separate lines:
  - `◀ <short sha> <ref> · <commit subject>`
  - `▶ <short sha> <branch> · <commit subject>`, plus `+ uncommitted changes` when the working
    tree differs from `HEAD`.
- When the left side is a merge-base, its label says so ("origin/develop 분기점"), so it is not
  read as the tip of `base`.

### Children of a comparison

1. **All changes** — merge-base ↔ working tree.
2. **Timeline** — the history from the merge-base to the working tree, drawn like a commit graph:
   one lane line joins every row, so the direction reads at a glance.
   - One end is the **merge-base** row (◆, tagged "분기점"); it has no files.
   - One row per commit in `merge-base..HEAD` — that commit's parent ↔ that commit. A merge
     commit compares against its first parent.
   - The other end is **Uncommitted changes** (dashed ●, tagged "작업중") — `HEAD` ↔ working
     tree.
   - Every commit row shows its committer date and its position, `n / total`, where `1` is the
     oldest.
   - Newest first by default; the toolbar toggle switches to oldest first. The timeline node's
     label states the current direction (`최신 → 과거 ↓` or `과거 → 최신 ↓`).

Each node shows its file count, or `visible / total` while a filter is active.

### File tree

- Grouped by folder. A chain of single-child folders collapses into one row, as IntelliJ shows it.
- Each file carries its status letter and color: A, M, D, R. File icons follow the active icon
  theme.
- Refreshes on save; the toolbar also has a refresh button.
- A toolbar toggle switches between **changed files only** (default) and **all files** in the
  repo at that node's right-hand revision.
  - In all-files mode, changed files keep their status letter; a folder that contains changes
    shows `● <count>`; everything else is dimmed.
  - Clicking an unchanged file opens that revision of the file in a single read-only editor,
    not a diff.
  - The file list comes from one `git ls-files` / `git ls-tree` call per revision; folders
    render only when expanded.
  - The filter applies to unchanged files by path; the status toggles apply to changed files
    only.
  - The node's count stays the number of changed files; in all-files mode its label also shows
    the repo's file count.

### Filter

- Path globs, comma-separated; a leading `!` excludes. Example: `**/*.kt, !**/test/**`.
- Status toggles for A, M, D, R.
- While a filter is active, a bar above the tree shows it and the `visible / total` count.
- The filter applies to the tree and to Open All.

## Diff

- Clicking a file opens VS Code's side-by-side diff.
- Both sides are read-only; the extension does not edit files. Both are served by the extension's
  own content provider: `git show <ref>:<path>` for a commit, the file on disk for the working
  tree.
- The whole file is shown, not only the changed hunks. VS Code's own collapse-unchanged-regions
  toggle stays available in the editor toolbar; the extension opens diffs with it off.
- Syntax highlighting follows the language mode of the file's extension.
- Added files have an empty left side; deleted files an empty right side.

### Telling the sides apart

VS Code's diff editor has a single title for both panes and no per-pane header. The sides are
labelled in three places:

1. **Tab title** — `<file>  <sha> (<ref>) ↔ <sha>+작업중 (<branch>)`. The extension cannot set a
   diff tab's tooltip (VS Code builds it from the two URIs), so commit subjects live in the
   CodeLens below.
2. **Per-pane line above line 1** — a CodeLens on each side:
   `◀ <sha> <ref> · <subject>` and `▶ <sha> <branch> · <subject>`.
   Both sides use the extension's own URI scheme, so the CodeLens provider is registered for that
   scheme only and never appears in an ordinary editor. To be confirmed by a prototype: that a
   CodeLens renders on both panes of a diff editor.
3. **Sidebar comparison node** — as above.

## Open All

Opens every file that passes the filter in VS Code's multi-diff editor (`vscode.changes`), titled
in the same form as a diff tab.

## Open questions

- Whether the CodeLens per-pane label works on both diff panes (see above).
- Whether opening a diff can force collapse-unchanged-regions off per editor, or only through the
  user setting `diffEditor.hideUnchangedRegions.enabled`.
- The shell helper's name and where it is installed.
