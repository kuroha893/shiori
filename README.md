# Shiori 栞

A personal paper reader for macOS. A PDF goes in; Claude transcribes and translates it in the background; it comes
back as a typeset bilingual article (中文 / 原文 / 对照) with figures, formulas, cross-reference previews,
highlights, notes and a Claude side panel. Visual style follows kuroha.xyz.

All AI goes through the user's own, unmodified Claude Code CLI signed in with their Claude subscription
(`claude -p`, never the Agent SDK or an API key), for personal use only.

## Run

```bash
npm install
npm run dev        # development
npm run pack       # dist/mac-arm64/Shiori.app (unsigned, for this Mac)
```

Needs Claude Code installed (`curl -fsSL https://claude.ai/install.sh | bash`) and signed in (`claude auth login`).
Settings → Claude shows the status and opens the login in Terminal.

## How it fits together

- `src/main/library.ts`: the library folder (default `~/Documents/Shiori`). One folder per paper:
  `paper.pdf`, `meta.json` (app state), `thumb.png`, `pages/pNN.png` (pages with a 0–1000 coordinate grid),
  `doc/NN.md` (the transcription), `figures/<id>.png`, `info.json`, `summary.md` (reading guide),
  `annotations.json`, `chat.json`. `profile.md` and `glossary.md` at the library root go into every prompt.
- `src/main/jobs.ts`: the processing queue. Render pages → Claude (Opus by default) reads the PDF and writes
  `doc/*.md`, `info.json`, `summary.md` → crop figures/tables from the bbox values → Claude checks the crops in
  the same session and fixes boxes → ready.
- `src/main/claude.ts`: finds the CLI, checks `claude auth status`, runs headless turns with `--restricted`
  (no code execution, file tools confined to the paper folder), `--strict-mcp-config`, a clean environment
  (no `ANTHROPIC_*` / `CLAUDE*` variables, so an API key can never take over billing).
- `src/main/chat.ts`: one Claude session per paper (`--session-id`, then `--resume`), streamed to the panel.
- `src/main/prompts.ts`: the processing, crop-check and chat prompts, including the document format.
- `src/main/worker.ts` + `src/renderer/src/worker.ts`: a hidden window running pdf.js for page renders and crops.
- `src/shared/venue.ts` + `src/shared/ccf.ts`: venue tags. `ccf.ts` is the CCF list, 7th edition (2026-03-31),
  parsed from the official PDF; `venue.ts` maps free-text venues to a label, family colour (ML / ACL / AI / CV),
  CCF rank, or Findings / Workshop (which CCF doesn't rank). Update `ccf.ts` when CCF publishes a new edition.
- `src/shared/doc.ts`: parser for the document format (`@@ <type> key=value` blocks, `@@zh` / `@@table` sections).
- `src/renderer/`: React UI. `lib/markdown.ts` renders Markdown + KaTeX, sanitizes with DOMPurify (paper text
  and answers are untrusted) and applies typographic fixes; highlights use the CSS Custom Highlight API with
  text offsets per block (`lib/anchors.ts`), so they never modify the DOM.

## Testing without Claude

- `SHIORI_USER_DATA=<dir>`: separate settings/profile (put `{"libraryPath": "..."}` in `<dir>/settings.json`).
- `SHIORI_FAKE_CLAUDE=<dir>`: processing copies `<dir>/<paper id>/` (doc/, info.json, summary.md) instead of
  calling Claude; pages, crops and everything after run for real.
- Settings → `claudePath` can point at a stand-in script that prints the same stream-json events.
- Launch with `--remote-debugging-port=9222` to drive the window over the DevTools protocol.
