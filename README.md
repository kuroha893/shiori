# Shiori 栞

Shiori is a paper reader for macOS. Drop in a PDF or an arXiv link, and Claude transcribes and translates the whole
paper in the background. It comes back as a typeset Chinese–English article you can read, annotate and ask
questions about.

![Shiori reading a paper](docs/reader.png)

## Features

- **Readable papers** – PDFs are re-typeset as articles with figures, tables and KaTeX formulas, in Chinese,
  the original English, or side by side.
- **Cross-references** – hover a figure, table, equation or citation to preview it; click to jump, swipe back to
  return.
- **Original page** – every paragraph links to its page in the PDF.
- **Highlights and notes** – four highlight colours and notes, exportable as Markdown.
- **Ask Claude** – select any passage to have it explained or translated, or chat about the paper. Each paper
  keeps its own conversation.
- **Reading guide** – a short summary of the problem, method, results and what to read first.
- **Library** – arXiv import, reading progress, and venue tags with their CCF rank.
- **Glossary** – your preferred translations of terms, used for every paper.
- **Themes and fonts** – light, dark and sepia; any installed font for the interface.

## Requirements

- macOS on Apple silicon
- Node.js 20.19+ or 22.12+
- [Claude Code](https://claude.com/claude-code), signed in with a Claude account

## Getting started

```bash
git clone https://github.com/kuroha893/shiori.git
cd shiori
npm install
npm run dev
```

To build the app:

```bash
npm run pack
```

The app is written to `dist/mac-arm64/Shiori.app`.

On first launch, open **Settings → Claude** to check that Claude Code is found and signed in. Papers are stored in
`~/Documents/Shiori`, one folder per paper.

## Project structure

```
src/
  main/       Electron main process: library, processing queue, Claude Code runs, chat
  preload/    API exposed to the window
  renderer/   React UI: library, reader, side panel, settings
  shared/     Types, the transcription format, venue and CCF data
```

See [docs/development.md](docs/development.md) for how processing works and how to test without Claude.

## Built with

Electron, React, pdf.js, KaTeX and markdown-it. Fonts: Geist, Inter, Space Grotesk, IBM Plex, Manrope and
JetBrains Mono (SIL Open Font License).
