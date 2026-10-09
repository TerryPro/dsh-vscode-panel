# DSH Workbench Layout

[简体中文](README.zh.md) | English

A three-column workspace for DeepSeek Harness Web: navigation on the left, files, editor, Git and terminals in the middle, and the native DSH conversation on the right.

![DSH Workbench Layout showing the file explorer, editor, and native conversation](https://raw.githubusercontent.com/TerryPro/dsh-vscode-panel/main/assets/workbench-files-and-chat.png)

![DSH Workbench Layout showing the Git changes view, a side-by-side diff, and the native conversation](https://raw.githubusercontent.com/TerryPro/dsh-vscode-panel/main/assets/workbench-git-diff.png)

## Background

DeepSeek Harness (DSH) Web is an AI coding-agent client whose official AppFrame is centered on the conversation. Out of the box it has no code workbench beside the chat — no file explorer, no editor, no Git panel, no terminal.

This plugin exists to fill that gap **additively**. Rather than forking or replacing DSH's interface, it registers into the client's public slots (the sidebar footer, the sidebar workspace area, and the right-hand session column) and reshapes the existing AppFrame into a VS Code-style three-column workbench. The native conversation, task status, tools, and composer are left exactly as DSH ships them — this project started life as a "VS Code-like panel" for DSH and has grown from a bare three-column layout into a full editing environment.

It is a two-part ("dual-half") plugin:

- **Host half (Node)** — a trusted JSON API mounted on DSH's web server. It exposes workspace file operations and a hardened Git command layer, and serves the lazily loaded Mermaid runtime bundle. Every request is origin-checked and confined to an official Workspace id plus a workspace-relative path.
- **Client half (React)** — the browser UI. It renders the sidebar, editor, Git views, terminals, and structured viewers, and talks only to the host API. It reuses official DSH components and design tokens wherever the client exposes them, so the workbench looks and behaves native.

This release is built and tested against DSH Web 0.2.0-rc.2; the peer ranges still accept 0.1.5-rc.1, which declares the same sidebar, right-column, and footer slot contracts.

## Overview

| Area | What it provides |
| --- | --- |
| Left sidebar | Sessions, file explorer, Git changes and Commit Graph, terminal list |
| Middle editor | Multi-tab and multi-pane editing, Markdown/Mermaid/HTML/CSV/JSON/image viewers, per-file Diff, interactive terminals |
| Right column | The original DSH conversation, task status, tools, and composer |

Files, Git state, editor tabs, and terminals follow the selected **Workspace**; chat remains owned by the current **Session**. Layout, icons, colors, menus, dialogs, tooltips, and responsive behavior reuse DSH components and design tokens wherever the official client exposes them.

## Features

### Files and editing

- Browse directories lazily and create, rename, or delete files and folders.
- Color file-tree entries and middle-editor tabs from Workspace Git state: untracked, deleted, or conflicted files are red; added files are green; modified and renamed files use the warning color. Untracked state decorates only the file itself; directories aggregate the highest-priority remaining descendant state.
- Open multiple files in one tab strip; use the mouse wheel over overflowing tabs to scroll horizontally.
- Right-click any tab for a VS Code-style menu: Close, Close Others, Close Tabs to the Right, Close Saved, Close All, Save, Revert File, Copy Path, Copy Relative Path, Reveal in File Tree, and Split Right / Split Down. Batch closes still confirm each unsaved draft one at a time, and the middle mouse button closes the tab it lands on.
- Save the active file with `Ctrl/Cmd + S`. Writes use DSH version tokens so an externally changed file is not silently overwritten.
- While the page is visible, open files are checked in one batch about once a second, with an immediate check when focus returns. Clean tabs update automatically; a dirty draft receives explicit Reload or Keep Current choices after an external change.
- The editor compares CodeMirror's canonical text and preserves the file's existing CRLF, LF, or CR style when saving, preventing line-ending normalization from creating a false yellow dirty marker.
- Copy workspace-relative or absolute paths from the file context menu, and open file references produced by DSH tools directly in the middle editor.
- Syntax highlighting for 24+ grammars resolved from the file path — C/C++/C#, CSS/SCSS/Less, Go, HTML/Vue, Java, JavaScript (incl. JSX/MJS/CJS), TypeScript (incl. TSX), JSON/JSONC/JSON5, Markdown, Mermaid, PHP, Python, Rust, SQL, Shell, Dockerfile, TOML, INI/`.env`, XML/XHTML, YAML, and CSV/TSV. The status bar shows the resolved language; unknown types fall back to Plain Text.
- Common images open as a rendered preview instead of raw bytes. Other binary files show a binary-change notice.

### Multi-pane editing

- Split the middle column into two panes, each with its own tab strip, status bar, and view toggles.
- New files open into the focused pane; drag any tab across panes to move it, with a soft drop-zone overlay marking the target.
- Closing the last tab in the secondary pane collapses it automatically.
- Terminals participate too: arrange `terminal | file` or `terminal | terminal` side by side, and a running terminal keeps its session when moved between panes.

### Inline Git changes

- The source editor compares the current buffer with Git `HEAD` and shows additions in green, modifications in blue, and deletion positions in red in a clickable change gutter, without tinting code content.
- Click a marker to open a local Unified Diff with context, paired old/new line numbers, `-`/`+` rows, and character-level emphasis; navigate between changes, or revert only that block (a revert edits the draft and stays undoable).
- Drag the popup's right edge to resize it, or focus the edge and use the arrow keys; the viewport-safe width is remembered across changes, files, and reloads. Clicking outside closes it.
- Staged, unstaged, and unsaved edits are combined, then refreshed while typing, after saves or external changes, and across branch switches. Rendered Markdown Preview stays clean; the markers appear in Source mode.

### Markdown

- Open Markdown in rendered Preview mode by default and switch to Source when editing; a Split view shows both with synchronized scrolling.
- Toggle an optional right-hand outline (table of contents) panel per file tab, in both Preview and Split modes; clicking a heading smooth-scrolls the preview to it. Fenced code blocks are skipped and inline markup is stripped when building the outline.

### Structured data: CSV/TSV and JSON

- **CSV/TSV table viewer** with a frozen row-number column, a filter toolbar (case-insensitive substring match across all cells with a live match count), column sorting, and a footer summary row that detects numeric, date, and text columns and reports sum/min/max/average.
- **Editing in table mode:** in-place cell editing, insert/append/delete rows and columns relative to the active cell, double-click a header to rename it, and `Ctrl+V` region paste parsed with the current delimiter. Undo/redo (`Ctrl/Cmd + Z`, `Ctrl/Cmd + Shift + Z`) and per-file column-width persistence round it out. Edits flow through the same version-checked draft/save pipeline as text files, preserving end-of-line style, trailing newlines, and BOM.
- **JSON viewer** for `.json`/`.jsonc`, powered by a zero-dependency, offset-aware parser that tolerates comments, trailing commas, and partial input. Four views — an interactive node-link **Graph** canvas (zoom, pan, collapsible cards, click to locate), an indented **Tree** (search keeps the ancestor chain, large arrays page in groups of 200, expand/collapse presets persist per file), a **Split** view that links the structured pane to the source editor, and raw **Source**. Size and depth are capped so huge documents stay responsive.
- Both viewers offer Table/Tree, Split, and Source modes behind one status-bar switch, and remember their split ratio per view.

### Diagrams and documents: Mermaid and HTML

- **Mermaid** files (`.mmd`/`.mermaid`) render live to SVG, debounced so only the newest edit wins, with zoom in/out/fit/reset, a dark/light theme that follows the shell, and error messages that point at the offending line. The runtime bundle is served by the host and loaded on demand.
- **HTML** files (`.html`/`.htm`/`.xhtml`) open in preview with three modes: **Static** (a locked-down `sandbox=""` iframe with a strict CSP that never runs scripts), **Interactive** (a script-capable opaque-origin sandbox that auto-bundles relative `.js`/`.css` dependencies into blob URLs at runtime, under file-size and resource-count caps), and **Source**. Editing the draft reflects live in the preview.

### Git workspace

- View staged and unstaged changes as a list or directory tree.
- Stage, unstage, discard, and commit through explicit actions. Long filenames use the full row at rest, then contract by the exact one- or two-button action width on row hover; direct button hover shows a circular fill.
- Open each working-tree, staged, commit, or comparison Diff as its own editor tab.
- Render text Diffs with CodeMirror MergeView, line numbers, character-level changes, collapsed unchanged regions, always-available Side by side, Unified, and Inline modes, and long-line wrapping.
- Explore local and remote refs as a lane-based Commit Graph with branches, merges, tags, authors, timestamps, and file statistics; older commits load automatically in 40-entry pages while scrolling.
- Expand a commit in place, arrange its files as a list or tree, and open one file at a time.
- Create, switch, rename, and safely delete local branches; create a branch from a selected ref or commit.
- Configure remotes and run Fetch, fast-forward Pull, Push, Publish, and Sync against an upstream or an explicit remote and branch.
- Use commit actions for copying a hash, Cherry-pick, Revert, branch creation, and comparison with the current Workspace.

### Terminals

- Run interactive xterm.js terminals through DSH's **official** terminal service (`@deepseek-ai/dsh-api-terminal-controller` and the host's `webTerminals`), so nothing is bundled that needs a native build. The plugin's surface is a thin emulator; process spawning, transport, and screen recovery belong to DSH.
- Transport rides the Gateway Remote stream — WebSocket-multiplexed on the web profile and an IPC bridge on desktop.
- Terminal tabs belong to the **Workspace**: switching tabs preserves the screen, and switching Workspaces or Sessions preserves both the tabs **and their processes**. The Host resolves any Session's Agent on demand, so a tab keeps being driven through the Session that allocated its process even after the Workspace has moved on — the terminal never disconnects when you change Session. A tab with no Session to address at all reports **No session yet** (hollow status dot) rather than pretending to run.
- **Name a terminal.** The pencil action on a row renames it, and the name is pushed to the Host as the terminal's own title so the process carries it rather than only this window's label. A named terminal is called the same thing in the sidebar row, the collapsed rail, the editor tab strip, and its accessible label; unnamed ones fall back to `Terminal N`.
- **Each terminal reports its process.** Under the row, a status line mirrors what the Host actually reports: the shell its process resolved (which also names a restored terminal), the PTY grid, and the *launch* directory. The Host documents that a shell changing directory never updates that field, so it is labelled as the start directory rather than pretending to track `cd`. An exited process also reports its exit code.
- **A focused terminal reports it at its foot too.** The same facts appear in a status strip along the bottom of the terminal's pane, sized and coloured exactly like the editor's so switching between a file and a terminal never moves that edge. It leads with the phase and its dot, then the shell, grid, and launch directory as bare values (the labels move to the tooltip), and pins the exit code to the right once the process has ended. Both surfaces resolve through one shared vocabulary, so the strip, the sidebar row, and the tab and rail dots cannot disagree about the same terminal — and a fact the Host has not reported is dropped rather than shown as a placeholder.
- **Pick a shell per terminal.** The new-terminal button lists the shells the Host verifies in the Session's execution environment — PowerShell (`pwsh` and Windows PowerShell), CMD, `bash`, `zsh`, `fish` — and the row then shows the shell its process actually resolved. Choosing one also remembers it as this browser's default, so the workbench and DSH's own terminal follow the same preference. Without a choice the host's default applies: `ComSpec` on Windows and `SHELL` on Unix-like systems, and a restored process always keeps the shell it started with.

### Conversation and layout

- Keep the official DSH conversation and input flow intact in the right column.
- Resize the middle and right columns with the official AppFrame divider behavior. The initial conversation width scales with the viewport, and its drag range grows on large displays while preserving the middle editor's usable width.
- Collapse the middle editor from the activity dock; selecting a file, Diff, or terminal opens it again. The conversation-collapse action sits beside it on the same dock rail, so both stay reachable even when the middle editor is closed.
- The sidebar foot keeps DSH's native stacked order: a contributed widget (such as a quota reader) stays above the account/Settings row instead of being squeezed onto one line beside it.
- When a global `main` panel opens — the Plugins page, or one registered by another plugin such as the Qoder quota page — it appears in the right column as DSH intends while the middle column keeps showing your open files instead of going blank; closing the panel restores the conversation.
- Return from any global panel with the **Back to conversation** control the workbench adds. DSH's own sidebar rows only ever *select* a panel — their handler is `selectPanel(id)`, never `selectPanel(null)` — so once the workbench shadows the session list, the shell offers no control that leaves a panel. On the Plugins page it joins that page's own header actions (refresh and add); for every other panel, and for the Plugins detail view, it sits on the activity dock below the view icons. Only one copy ever shows, and the dock's cluster never shifts.
- Drag the left sidebar to resize it within a clamped range; the sidebar keeps a visible boundary with the editor and a divider under the menu bar.
- Keep files and Git available for a Workspace even before its Session contains messages.
- Adapt the composer, menus, failure messages, and assistant timing statistics when the conversation becomes narrow.
- Return the conversation to the official center layout and surface colors when the middle editor is collapsed.

## Installation

Install the public package into the DSH Web profile:

```sh
dsh plugin --profile web add @lsq64737/dsh-workbench-layout
```

Restart DSH Web if it is already running.

Terminals reuse the host's own terminal service, so there is no native module (such as `node-pty`) to approve or build — terminal support is available wherever DSH's built-in terminal works.

Run the same add command to update an existing installation. Remove the plugin with:

```sh
dsh plugin --profile web remove @lsq64737/dsh-workbench-layout
```

## Basic use

1. Select a DSH Workspace.
2. Use the sidebar modes to switch among Sessions, Files, Git, and Terminal.
3. Select a file, Diff, commit file, or terminal to open it in the middle column; use the status-bar switches to change a Markdown/CSV/JSON/Mermaid/HTML file between its structured, split, and source views.
4. Drag the middle/right divider to choose the amount of space assigned to editing and conversation.
5. Use the activity dock to collapse or restore the middle column and the conversation.

Git features require the selected Workspace root to be a Git repository. Remote operations use credentials already configured for Git on the machine running DSH; the plugin does not request or store remote credentials.

## Safety and privacy

- Host APIs resolve an official Workspace id and workspace-relative path; browser-provided absolute paths are not accepted as file targets.
- Traversal outside the Workspace and symbolic-link access are rejected.
- File creation is atomic, saves use version checks, and rename does not intentionally replace an existing entry.
- External refreshes compare versions through the official DSH filesystem in one batch and never replace an unsaved draft automatically.
- Recursive folder deletion and destructive Git actions require confirmation. File and folder deletion is permanent.
- Pull and Sync are fast-forward only. Cherry-pick and Revert require a clean worktree and abort automatically when Git reports a conflict.
- Git commands use fixed arguments without a shell, and terminal credential prompts are disabled for Git operations.
- HTML previews run inside a sandboxed iframe; interactive previews stay in an opaque origin and only bundle size-capped relative resources.
- Logs use Workspace ids and relative paths instead of recording host file paths.
- A terminal grants shell access to the machine running DSH. Only expose DSH Web to users and networks you trust.

## Limitations

- Open tabs and unsaved drafts live in the current page and are lost on refresh. Terminal processes are the exception: the Host keeps them, but this plugin does not rebuild their tabs, so an orphaned process is reclaimed by the Host after roughly two hours idle (`unattendedTimeoutMs`, default 7200000 ms) or immediately when DSH restarts.
- The file editor reads text files; images render as a preview, and other binary files show a binary-change notice instead of rendered content.
- Closing a terminal tab ends its process. Each Session caps terminals at the host's `maxTerminals` (default 8), and **exited terminals still count toward it** — a tab left behind by a Session switch holds its old Session's slot until you close it. A Session's terminals also end when the Host or that Session's owner is disposed. Availability and concurrency follow the host's own terminal configuration.
- The plugin reorders the official AppFrame through stable client markers because DSH does not currently expose a dedicated conversation-column placement API. A future AppFrame rewrite may require a plugin update.
- Structured viewers apply size, node, and depth caps so very large CSV/JSON documents stay responsive; content beyond a cap is shown as source or truncated rather than fully rendered.
- In the Windows desktop app a collapsed sidebar has zero width and DSH hides the sidebar's browser and footer rows, so the account/Settings row is unavailable until the sidebar is expanded again. The activity dock is an independent column, so the mode switch, the middle-editor and conversation toggles, and Settings stay reachable in every fold state on every platform.
- On very narrow windows, the official AppFrame concession temporarily closes the middle editor and restores it when enough width is available.

## Development

Requirements: Node.js 24 or newer and a compatible DSH development workspace.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:bundle
```

`npm run typecheck` covers the plugin sources plus the test harnesses that stub DSH snapshots (`workspace-binding`, `workbench-sidebar`, `workbench-editor`), so a host shape change fails the build instead of silently switching those checks off. Some remaining specs are not type-checked yet.

Source changes only take effect in DSH after `npm run build` regenerates `lib/client.js`; the client loads the bundle, not `src`.

## License

[MIT](LICENSE)
