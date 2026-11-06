// Prompts for conference work. Instructions are in English; whatever the owner reads is written in Chinese.

const today = () => new Date().toISOString().slice(0, 10)

export const MAX_ROUNDS = 14

/** How fetch scripts are written and tested; every task that writes scripts gets this. */
const SCRIPTS = (edition: string) => `
## Fetch scripts

A channel's script is channels/<id>.js (id: short, lowercase, letters and dashes) and defines

    async function fetchPapers({ fetchText, fetchJSON, fetch, parseHTML, sleep, log }) {
      ...
      return papers
    }

It runs in a sandbox: plain JavaScript, no require or import, no files, no process. The tools:
- fetchText(url, init?) and fetchJSON(url, init?): the body of a request (GET unless init.method says otherwise);
  they throw on a status that isn't 2xx. fetch(url, init?) gives the raw Response.
- parseHTML(html): a node-html-parser root, with querySelector, querySelectorAll, getAttribute, .text, .innerHTML.
- sleep(ms), up to 10 s; log(...): shown to you after a test run.
A run may take 10 minutes and 3000 requests. Keep at most 4 requests in flight at a time.

It returns every accepted paper the channel lists for ${edition}, as an array of
    { title, authors: [..], abstract?, track?, kind?, area?, url?, pdf?, arxiv? }
- title and abstract as published, markup included: LaTeX as the authors wrote it, math as TeX in $...$ (turn
  <tex-math> or MathML into $...$), bold and italic as <b> and <i>. Never strip them to plain text; decode HTML
  entities. Authors in order, as full names.
- track: the conference's own name for the track, short, in English: "Main", "Findings", "Datasets & Benchmarks",
  "Position", "Industry", "Demo". Leave it out when the edition has one track.
- kind: how the paper is presented, when the channel says: "Oral", "Spotlight", "Poster".
- area: the subject area the channel files it under, if any.
- url: the paper's own page there; pdf: a direct link to its PDF; arxiv: its arXiv id.
Only papers accepted at ${edition}: no rejected or withdrawn submissions, no other years, no workshop papers.
A list that has only titles today may get abstracts and PDFs later; write scripts that pick those up when they
appear, and never hard-code counts or paper lists.

## Testing

You cannot run code; Shiori runs it for you. End a reply with a line
    RUN: channels/a.js probe.js
naming any .js files in this folder (scratch files like probe.js are fine, e.g. one that only logs part of a raw
page or API response) and Shiori answers with what each returned: the count, how many papers have each field,
samples, the error if it failed, and the log. WebFetch shows you a summary of a page, not its raw HTML or JSON;
probe with a script before writing a parser for it. Sites that refuse scripts are common: test before relying on
one, and drop it if it refuses. You have up to ${MAX_ROUNDS} rounds; when you are finished, end with a line DONE.

## channels.json

Every channel that is kept, in order of preference:
    [{ "id": "anthology", "name": "ACL Anthology", "url": "<the page or API it reads>", "kind": "script",
       "provides": ["authors", "abstract", "pdf", "track", "kind"], "note": "一句中文：它提供什么" }]
"provides" lists what it actually returned in your last test. Only when papers are listed on a page no script can
read (and only then) write them yourself as channels/<id>.json, { "papers": [...] }, with "kind": "data".
`

/** The first look at a conference: what it is called, its latest edition with results, and the one after. */
export function setupPrompt(typed: string): string {
  return `The owner of Shiori, a paper reader, wants to follow the academic conference "${typed}". Today is ${today()}.

Search the web and find:
- the conference's usual short name and its full name;
- its most recent edition whose accepted papers are already known (decisions sent, or a list published), and the
  day decisions came out;
- the edition after that, with the day its decisions are expected (from its call for papers or important dates;
  if not announced yet, estimate from last year and say so).
- the conference's graphic mark: the symbol of its logo without the lettering, as on its official site (often
  the small icon in the site's navigation bar or its favicon in SVG); a direct link to an SVG or a transparent PNG.

Write setup.json:
{"name": "NeurIPS", "fullName": "Conference on Neural Information Processing Systems",
 "latest": {"year": 2026, "releaseDate": "YYYY-MM-DD", "source": "<URL>"},
 "next": {"year": 2027, "releaseDate": "YYYY-MM-DD" or null, "estimated": true, "source": "<URL>"},
 "mark": "<URL of the mark>" or null}
The year is the edition's own (ICLR 2027 decides in early 2027). If "${typed}" is not an academic conference you
can identify, write {"error": "一句中文原因"} instead.

Write nothing else, then reply with the single word DONE.`
}

/** Whether an edition's decisions are out yet, and when they will be. */
export function datePrompt(o: { name: string; fullName?: string; year: number; known?: string }): string {
  return `When are the decisions (the accepted papers) of ${o.name} ${o.year}${o.fullName ? ` (${o.fullName})` : ''} announced? Today is ${today()}.${o.known ? `\nLast time it was expected on ${o.known}.` : ''}

Search the official site (important dates, call for papers, news), OpenReview and recent announcements. Write
date.json:
{"released": true or false, "releaseDate": "YYYY-MM-DD" or null, "source": "<URL>", "note": "一句中文"}
- releaseDate: the day decisions were or will be sent; the expected day when they are not out yet.
- released: true only if the accepted papers are known today (decision notifications sent, or a list published).
- If ${o.name} has no ${o.year} edition (some run every other year), add "nextYear": <the year of the next one>.

Write nothing else, then reply with the single word DONE.`
}

/** Pairs that may be one paper listed twice, for Claude to decide, looking them up when it must. */
export function samePrompt(o: { edition: string; count: number; input: string; out: string }): string {
  return `The papers of ${o.edition} come from more than one list (the official site, the proceedings, ...), merged by
title. ${o.input} holds ${o.count} pairs, a and b, that may be one paper listed twice: a title can change for the
camera-ready or be spelt differently, and the same authors also often write two different papers. For each paper:
key, title, authors, the start of its abstract, its track and presentation, the list it came from, and where it is
(page, PDF, arXiv).

Decide every pair. Compare the authors and the abstracts first; when that doesn't settle it, look the papers up
(their pages and PDFs, the proceedings, OpenReview, arXiv, a web search). When they are one paper, say which title it
was published under (usually the proceedings' or the camera-ready's). When you can't tell, call them different: two
rows are better than one wrong merge.

Write ${o.out}: [{"a": "<key>", "b": "<key>", "same": true or false, "title": "<the key whose title it was published
under, when same>"}, ...], covering every pair. Write nothing else, then reply with the single word DONE.`
}

/** Finding where an edition's papers are listed, and writing a script for each place. */
export function discoverPrompt(o: { edition: string; fullName?: string; releaseDate?: string; past?: boolean; existing?: string }): string {
  return `Shiori, a paper reader, follows the accepted papers of ${o.edition}${o.fullName ? ` (${o.fullName})` : ''}. Today is ${today()}.${
    o.past ? ' This edition is in the past; its papers have long been published.' : o.releaseDate ? ` Decisions came out on ${o.releaseDate}.` : ''
  }

Your job: find every place on the web that lists this edition's accepted papers, and write a fetch script for each
one worth having, so that together they give for every paper its title, authors, abstract, PDF link, track and
presentation type.

Search the web. Places worth checking: the official site's list of accepted papers and its virtual-conference data
(often a JSON file the site itself loads), OpenReview (api2.openreview.net, by venue id), the ACL Anthology
(aclanthology.org/events/...), proceedings sites (proceedings.mlr.press, papers.nips.cc, openaccess.thecvf.com),
and third-party lists that add abstracts or PDF links. A channel that only repeats what another gives adds nothing;
one that fills a gap (abstracts, PDFs, orals) is worth keeping. OpenReview hands out PDFs only to signed-in visitors
or after a human check, so direct PDF links elsewhere (proceedings, PMLR, the ACL Anthology, arXiv) fill a gap even
when another channel already gives OpenReview links.
${o.existing ? `\nChannels already kept, which you may improve or replace:\n${o.existing}\n` : ''}
If no place lists the papers yet, write channels.json as [] and say why in one line before DONE.
${SCRIPTS(o.edition)}`
}

/** The daily look while an edition is fresh: news, new channels, broken scripts, duplicates. */
export function patrolPrompt(o: { edition: string; state: string; failing: string[]; search: boolean }): string {
  const tasks = [
    o.search &&
      `- Search the web, briefly (a few searches are enough when nothing changed): how many papers the conference
  says it accepted; places that started listing this edition's papers since (proceedings published, OpenReview or
  a site that adds abstracts or PDFs). If one gives something the channels below lack, add a channel for it.`,
    o.failing.length &&
      `- These channels failed or suddenly found nothing: ${o.failing.join(', ')}. out/<id>.json holds the last run;
  find out why and fix the script, or drop the channel if its source is gone.`
  ].filter(Boolean)
  return `A check on ${o.edition}, whose papers are still being published. Today is ${today()}.

Where things stand:
${o.state}

To do:
${tasks.join('\n')}

Write patrol.json:
{"officialCount": <number or null>, "note": "一句中文：今天有什么变化；没有就留空"}
Then keep channels.json up to date with anything you added, changed or dropped.
${SCRIPTS(o.edition)}`
}

/** The theme map of an edition, from all its titles. */
export function themesPrompt(o: { edition: string; count: number; glossary: string }): string {
  return `${o.edition} accepted ${o.count} papers. titles.txt lists them, one per line: key<TAB>title<TAB>track and type.
Read all of it, in parts (it is long), before writing anything.

Write themes.json, the map of this edition for a Chinese researcher who wants to see what the field is working on
and find their own way in: 20 to 30 themes (主题) that cover every paper, each with 2 to 7 branches (分支), the
distinct lines of work inside the theme.

[{"id": "t1", "name": "视频生成", "note": "一句话：这一主题的论文在做什么",
  "branches": [{"id": "t1.1", "name": "长视频与时序一致性", "note": "超过一分钟的视频怎么保持人物和场景不漂",
                "keywords": ["long video generation", "temporal consistency"]}]}]

- Themes follow the research problems and areas as researchers would name them, sized by the papers they hold:
  split a crowded area, merge thin ones. Biggest first.
- Names are short Chinese; established English terms (Transformer, KV cache, RLHF, LLM) stay as they are.
- note: one plain sentence on what these papers do, not a textbook definition.
- keywords: 3 to 8 English words or phrases that the branch's papers use in titles and abstracts.
- Every paper must fit some branch: add a branch "其他" inside a theme where needed, and a last theme "其他" for what
  fits nowhere.
${o.glossary}
Write nothing else, then reply with the single word DONE.`
}

/** Sorting a batch of papers into the theme map and the owner's directions, with Chinese titles. */
export function assignPrompt(o: { edition: string; map: string; follows: string; lines: number; glossary: string; batch: string; out: string }): string {
  return `Sort papers of ${o.edition} into its theme map, and mark the directions the owner follows that they belong to.

Theme map (branch id: theme › branch: note):
${o.map}

The owner's directions (id: name: note; keywords):
${o.follows || '(none yet)'}

${o.batch} has one paper per line: key<TAB>title<TAB>beginning of the abstract (may be empty). For every line, write
one line to ${o.out}:
key<TAB>branch id<TAB>direction ids separated by commas, or -<TAB>Chinese title

- Exactly one branch, the one that fits best; a "其他" branch only when nothing else fits.
- A direction only when the paper is clearly about it, not merely nearby.
- The Chinese title is a natural translation; model and method names and acronyms stay as they are.
${o.glossary}
Write all ${o.lines} lines and nothing else, then reply with the single word DONE.`
}

/** Which of the papers found by a direction's keywords really belong to it. */
export function followTagPrompt(o: { edition: string; name: string; note?: string; keywords: string[]; file: string; out: string }): string {
  return `The owner follows the research direction "${o.name}"${o.note ? `: ${o.note}` : ''} (keywords: ${o.keywords.join(', ')}).
${o.file} lists papers of ${o.edition} that mention those keywords, one per line: key<TAB>title<TAB>beginning of the
abstract. Write ${o.out} with the keys of the papers that are really about this direction, one per line, and
nothing else; leave out papers that only touch it in passing. Then reply with the single word DONE.`
}

/** A direction typed by the owner, or made from a folder, turned into a description and keywords. */
export function followPrompt(o: { name: string; titles?: string[] }): string {
  return `The owner of a paper reader wants to follow the research direction "${o.name}" in conference papers.${
    o.titles?.length ? `\nThey filed these papers under it:\n${o.titles.map((t) => `- ${t}`).join('\n')}` : ''
  }

Reply with JSON only, no code fence:
{"name": "<the direction's name as the owner wrote it, tidied>", "note": "一句中文：这个方向在研究什么",
 "keywords": ["8 to 15 English words or phrases that papers in this direction use in their titles and abstracts"]}
Keywords should find the direction's papers without dragging in neighbours: prefer specific phrases
("kv cache compression") over broad words ("efficiency").`
}

/** A Chinese search turned into English phrases the local search can match. */
export function queryPrompt(text: string): string {
  return `Turn this search for conference papers into English phrases that paper titles and abstracts would use.
Reply with 2 to 6 phrases separated by " | " and nothing else. Each phrase is a few words that must all appear.

Search: ${text}`
}

export function abstractPrompt(o: { title: string; abstract: string; glossary: string }): string {
  return `Translate the abstract of the paper "${o.title}" into fluent Chinese for a researcher. The title is there for
context only: don't translate it or start with it. Keep model and method names, acronyms, $...$ formulas and
**bold** or *italic* marks as they are. Reply with the translated abstract and nothing else.
${o.glossary}
${o.abstract}`
}

/** What the authors' own macros and broken formulas stand for, paper by paper. */
export function leftoversPrompt(o: { edition: string; count: number; input: string; out: string }): string {
  return `Some titles and abstracts of ${o.edition} still hold LaTeX that can't be shown as it is: macros the authors
defined for themselves (\\ours, \\method, or \\by inside a formula) and formulas that don't compile. ${o.input} lists
these ${o.count} papers: key, title, abstract, the tokens to explain, and where the paper is (page, PDF, arXiv).

For every token, find what it stands for in that paper:
- Most are the paper's own name for its method, model, dataset or benchmark. The title or abstract often says it
  ("We propose HALO (\\ours)", or a title starting "HALO: ..."). When they don't, look the paper up: its PDF, arXiv
  page or project page shows the name. Read the paper itself; never guess a name.
- A macro inside a formula is notation: answer with what it prints, as TeX in $...$ ("$\\times$", "$\\mathbf{z}$").
- A formula that doesn't compile (a token in $...$): answer with the formula corrected, in $...$.
- A macro that prints nothing, or marks left from the authors' editing (\\reviseTo, colour switches): answer "".
- If you can't find out, answer null.

Write ${o.out}: {"<key>": {"<token>": "<what it stands for>", ...}, ...}, covering every listed key and token.
Write nothing else, then reply with the single word DONE.`
}
