# Development notes

## Library layout

Each paper is a folder in the library (`~/Documents/Shiori/papers/<id>/`):

| File | Contents |
|---|---|
| `paper.pdf` | The original PDF |
| `meta.json` | Title, authors, venue, processing status, reading position |
| `pages/pNN.png` | Pages rendered with a 0–1000 coordinate grid, used to locate figures |
| `doc/NN.md` | The bilingual transcription |
| `figures/<id>.png` | Figures and tables cropped from the PDF |
| `info.json`, `summary.md` | Metadata and reading guide written by Claude |
| `annotations.json`, `chat.json` | Highlights, notes and the paper's conversation |

`profile.md` and `glossary.json` at the library root are included in every prompt.

## Processing

`src/main/jobs.ts` runs one paper at a time:

1. Render the pages (`src/renderer/src/worker.ts`, pdf.js in a hidden window).
2. Claude Code reads the PDF and writes `doc/*.md`, `info.json` and `summary.md` (prompt in `src/main/prompts.ts`).
3. Figures and tables are cropped from the bounding boxes in the transcription.
4. Claude checks the crops in the same session and corrects any box that is off.

Claude Code runs headless (`src/main/claude.ts`) with `--restricted` and only the file tools it needs, inside the
paper's folder. Chat (`src/main/chat.ts`) keeps one Claude Code session per paper.

## Transcription format

`doc/NN.md` is a sequence of blocks parsed by `src/shared/doc.ts`:

```
@@ p id=p-12 page=3
English paragraph with $x$ and a [Figure 3](#fig-3) link.
@@zh
中文译文，含 $x$ 和[图 3](#fig-3)。
```

Block types: `h`, `p`, `eq`, `fig`, `tab` (with an `@@table` section), `list`, `quote`, `code`, `note`, `ref`.

## Venue tags

`src/shared/ccf.ts` is the CCF recommended list, 7th edition (2026-03-31), generated from the official PDF.
`src/shared/venue.ts` turns a free-text venue into a label, colour family, CCF rank, or Findings / Workshop.
Regenerate `ccf.ts` when a new edition is published.

## Testing without Claude

- `SHIORI_USER_DATA=<dir>` uses a separate settings folder; put `{"libraryPath": "..."}` in `<dir>/settings.json`.
- `SHIORI_FAKE_CLAUDE=<dir>` makes processing copy `<dir>/<paper id>/` (`doc/`, `info.json`, `summary.md`) instead
  of calling Claude; rendering, cropping and everything after run as usual.
- `claudePath` in settings can point to a stand-in script that prints the same stream-json events.
- Start Electron with `--remote-debugging-port=9222` to drive the window over the DevTools protocol.
