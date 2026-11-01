# Shiori 栞

**English** | [简体中文](README.zh-CN.md)

Shiori is a paper reader for macOS. Drop in a PDF or an arXiv link, and Claude transcribes and translates the whole
paper in the background. It comes back as a typeset Chinese–English article you can read, annotate and ask
questions about.

![Shiori reading a paper](docs/reader.png)

## Features

- **Readable papers** – PDFs are re-typeset as articles with figures, tables and KaTeX formulas, in Chinese,
  the original English, or side by side.
- **Reading guide** – the story of the paper before you read it: the problem and why it matters, what earlier work
  tried, the idea, and one concrete example.
- **Cross-references** – hover a figure, table, equation or citation to preview it; click to jump, swipe back to
  return.
- **Original page** – every paragraph links to its page in the PDF.
- **Highlights and notes** – four highlight colours and margin notes, plus a block-editor note for each paper with
  tables, formulas and images. Both export as Markdown.
- **Ask Claude** – select any passage to have it explained or translated, or chat about the paper. Each paper
  keeps its own conversation.
- **Library** – arXiv import, reading progress, hearts for the papers you like, research directions to file them
  under with a suggestion from Claude, and venue tags with their CCF rank.
- **Contacts** – keep a favourite character on the line while you read. They chat with you by voice, with Chinese
  subtitles, and tell you when a paper is ready. Personality, picture and voice are all yours to set. Voices need
  your own Fish Audio key.
- **Glossary** – your preferred translations of terms, used for every paper.
- **Themes and fonts** – light, dark and sepia; any installed font for the interface.

One contact comes built in: Yachiyo Runami from *Cosmic Princess Kaguya!*. Her pictures are non-commercial fan art;
the character belongs to its rights holders.

## Screenshots

Your library, with research directions, hearts and venue tags:

![The library](docs/library.png)

Chinese and the original English, side by side:

![A paper in side-by-side view](docs/side-by-side.png)

A call while you read, with subtitles on the desktop:

![A call in its capsule, with subtitles, over a paper](docs/call-capsule.png)

The call opened up, with the record of past calls:

<img src="docs/call-screen.png" alt="The call screen" width="380">

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

## Built with

Electron, React, pdf.js, KaTeX, markdown-it and Tiptap. Voices by Fish Audio. Fonts: Geist, Inter, Space Grotesk,
IBM Plex, Manrope and JetBrains Mono (SIL Open Font License).
