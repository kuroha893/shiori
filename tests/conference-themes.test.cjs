const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const themes = ['语言模型', '视觉', '其他'].map((name) => ({
  name, note: '研究主题',
  branches: [{ name: '方法', note: '研究分支', keywords: ['methods'] }]
}))

function load(file, mocks = {}) {
  const subject = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
  }).outputText
  vm.runInNewContext(code, {
    module: subject, exports: subject.exports,
    require: (name) => name in mocks ? mocks[name] : require(name),
    console
  }, { filename: file })
  return subject.exports
}

function harness(t, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-themes-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const requests = []
  let papers = [{ key: 'one', title: 'A paper', branch: 'old.1', titleZh: '论文' }]
  const original = JSON.stringify(papers)
  const prompts = load(path.join(__dirname, '../src/main/conferences/prompts.ts'))
  const api = load(path.join(__dirname, '../src/main/conferences/tasks.ts'), {
    '../../shared/conferences': { editionRef: (conf, year) => `${conf}/${year}` },
    '../../shared/tex': {},
    '../ai': {
      modelFor: async () => 'openai:test',
      runAgent: async (request) => {
        requests.push(request)
        return { text: '', session: 'test', isError: false, ...await respond(request) }
      }
    },
    '../glossary': { glossaryPrompt: () => '(empty)' },
    '../settings': { getSettings: () => ({ processModel: 'openai:test' }) },
    './prompts': prompts,
    './scripts': {},
    './store': {
      editionDir: () => dir,
      loadPapers: () => papers,
      savePapers: (_conf, _year, next) => { papers = next },
      saveThemes: (_conf, _year, next) => fs.writeFileSync(path.join(dir, 'themes.json'), JSON.stringify(next))
    }
  })
  return {
    dir, requests, original,
    run: (signal) => api.makeThemes({ conf: 'test', year: 2026, name: 'Test 2026' }, signal),
    papers: () => JSON.parse(JSON.stringify(papers)),
    saved: () => JSON.parse(fs.readFileSync(path.join(dir, 'themes.json'), 'utf8')),
    diagnostic: () => JSON.parse(fs.readFileSync(path.join(dir, 'themes-error.json'), 'utf8'))
  }
}

test('persists themes returned by the model without requiring the model to write a file', async (t) => {
  const h = harness(t, async (request) => {
    assert.match(fs.readFileSync(path.join(request.cwd, 'titles.txt'), 'utf8'), /A paper/)
    return { text: JSON.stringify(themes) }
  })
  await h.run()
  assert.equal(h.saved().length, 3)
  assert.equal(h.saved()[0].branches[0].id, 't1.1')
  assert.equal(h.papers()[0].branch, undefined)
  assert.equal(h.papers()[0].titleZh, '论文')
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].write, false)
  assert.match(h.requests[0].prompt, /final reply/i)
  assert.equal(fs.existsSync(path.join(h.dir, 'titles.txt')), false)
})

test('accepts a JSON reply wrapped in a single Markdown code fence', async (t) => {
  const h = harness(t, async () => ({ text: '```json\n' + JSON.stringify(themes) + '\n```' }))
  await h.run()
  assert.equal(h.saved().length, 3)
})

for (const [name, reply] of [
  ['empty', ''],
  ['malformed JSON', '[{"name":'],
  ['a JSON object instead of an array', '{"themes":[]}'],
  ['incomplete themes', JSON.stringify(themes.slice(0, 2))],
  ['invalid branches', JSON.stringify(themes.map((theme) => ({ ...theme, branches: [null] })))]]
) {
  test(`rejects ${name} replies, preserving existing data and diagnostics without retrying`, async (t) => {
    const h = harness(t, async () => ({ text: reply }))
    const previous = JSON.stringify(themes)
    fs.writeFileSync(path.join(h.dir, 'themes.json'), previous)
    await assert.rejects(h.run(), /主题/)
    assert.equal(fs.readFileSync(path.join(h.dir, 'themes.json'), 'utf8'), previous)
    assert.equal(JSON.stringify(h.papers()), h.original)
    assert.equal(h.diagnostic().response, reply)
    assert.equal(h.diagnostic().model, 'openai:test')
    assert.ok(h.diagnostic().error)
    assert.equal(h.requests.length, 1)
  })
}

test('keeps the model error message in both the user error and diagnostics', async (t) => {
  const h = harness(t, async () => ({ text: 'Usage limit reached', isError: true }))
  await assert.rejects(h.run(), /Usage limit reached/)
  assert.equal(h.diagnostic().response, 'Usage limit reached')
  assert.equal(JSON.stringify(h.papers()), h.original)
  assert.equal(h.requests.length, 1)
})

test('records transport failures without replacing existing paper assignments', async (t) => {
  const h = harness(t, async () => { throw new Error('Connection closed') })
  await assert.rejects(h.run(), /Connection closed/)
  assert.match(h.diagnostic().error, /Connection closed/)
  assert.equal(JSON.stringify(h.papers()), h.original)
})

test('does not retry or record cancellation as a model failure', async (t) => {
  const controller = new AbortController()
  const h = harness(t, async () => {
    controller.abort()
    throw new Error('已取消')
  })
  await assert.rejects(h.run(controller.signal), /已取消/)
  assert.equal(h.requests.length, 1)
  assert.equal(fs.existsSync(path.join(h.dir, 'themes-error.json')), false)
  assert.equal(fs.existsSync(path.join(h.dir, 'titles.txt')), false)
})

test('a successful manual retry clears the previous diagnostic', async (t) => {
  let attempts = 0
  const h = harness(t, async () => ({ text: ++attempts === 1 ? 'DONE' : JSON.stringify(themes) }))
  await assert.rejects(h.run(), /主题/)
  assert.equal(h.diagnostic().response, 'DONE')
  await h.run()
  assert.equal(h.saved().length, 3)
  assert.equal(h.requests.length, 2)
  assert.equal(fs.existsSync(path.join(h.dir, 'themes-error.json')), false)
})

test('an already cancelled request never starts a model call', async (t) => {
  const h = harness(t, async () => ({ text: JSON.stringify(themes) }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(h.run(controller.signal), /已取消/)
  assert.equal(h.requests.length, 0)
  assert.equal(JSON.stringify(h.papers()), h.original)
})

test('does not save a reply that arrives after cancellation', async (t) => {
  const controller = new AbortController()
  const h = harness(t, async () => {
    controller.abort()
    return { text: JSON.stringify(themes) }
  })
  await assert.rejects(h.run(controller.signal), /已取消/)
  assert.equal(fs.existsSync(path.join(h.dir, 'themes.json')), false)
  assert.equal(fs.existsSync(path.join(h.dir, 'themes-error.json')), false)
  assert.equal(JSON.stringify(h.papers()), h.original)
})
