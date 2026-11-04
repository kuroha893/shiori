import { randomUUID } from 'node:crypto'
import type { ChatEvent, ChatMessage } from '../shared/types'
import { parseModel } from '../shared/models'
import { loadChat, paperDir, readMeta, saveChat } from './library'
import { modelFor, runAgent } from './ai'
import { ensurePaperText, sourceFor } from './jobs'
import { chatSystemPrompt } from './prompts'
import { glossaryPrompt } from './glossary'
import { getSettings } from './settings'

const active = new Map<string, AbortController>()

/** The conversation so far, for a session that can't continue the earlier one. */
function history(messages: ChatMessage[]): string {
  const lines = messages
    .filter((m) => !m.error)
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'Reader' : 'You'}: ${m.quote ? `(about the passage "${m.quote.text}") ` : ''}${m.text}`)
  return lines.length ? `Earlier in this conversation:\n<history>\n${lines.join('\n\n')}\n</history>\n\n` : ''
}

/**
 * One question = one headless agent turn. With Claude Code the paper keeps one session, so follow-ups
 * ("and the second term?") keep their context; the session lives in Claude Code's own transcript store,
 * and chat.json keeps what the reader sees. Codex threads aren't kept, and a change of service can't continue
 * a session, so those start a new one from the messages so far.
 */
export async function ask(
  paper: string,
  input: { text: string; quote?: { block: string; text: string }; model?: string; effort?: string },
  emit: (e: ChatEvent) => void
): Promise<ChatMessage> {
  const meta = readMeta(paper)
  if (!meta) throw new Error('论文不存在')
  if (active.has(paper)) throw new Error('上一个问题还在回答中')

  const chat = await loadChat(paper)
  const earlier = chat.messages.slice()
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: input.text,
    quote: input.quote,
    createdAt: new Date().toISOString()
  }
  chat.messages.push(userMsg)
  await saveChat(paper, chat)

  let prompt = input.quote
    ? `The reader selected this passage (block ${input.quote.block}):\n<selection>\n${input.quote.text}\n</selection>\n\n${input.text}`
    : input.text

  const abort = new AbortController()
  active.set(paper, abort)
  let streamed = ''
  let model = input.model || getSettings().chatModel
  let answer: ChatMessage
  let resume = false
  try {
    model = await modelFor(model, 'chat')
    const { provider } = parseModel(model)
    resume = !!chat.sessionId && (chat.sessionProvider ?? 'claude') === provider && provider !== 'openai'
    if (!resume) prompt = history(earlier) + prompt
    const source = sourceFor(model)
    if (source === 'pages') await ensurePaperText(paper)
    const result = await runAgent({
      cwd: paperDir(paper),
      prompt,
      model,
      effort: input.effort ?? getSettings().chatEffort,
      write: false,
      session: resume ? chat.sessionId : undefined,
      instructions: chatSystemPrompt({ glossary: glossaryPrompt(), title: meta.titleZh || meta.title, source }),
      signal: abort.signal,
      onText: (text) => {
        streamed += text
        emit({ paper, kind: 'delta', text })
      },
      onActivity: (a) =>
        emit({ paper, kind: 'status', text: a.kind === 'read' ? '正在翻阅论文…' : a.kind === 'find' ? '正在查找…' : a.kind === 'search' ? '正在搜索…' : '正在思考…' })
    })
    if (provider === 'openai') {
      chat.sessionId = chat.sessionProvider = undefined
    } else if (!result.isError || resume) {
      chat.sessionId = result.session
      chat.sessionProvider = provider
    }
    answer = {
      id: randomUUID(),
      role: 'assistant',
      text: result.text || streamed,
      createdAt: new Date().toISOString(),
      model,
      error: result.isError || undefined
    }
  } catch (e) {
    answer = {
      id: randomUUID(),
      role: 'assistant',
      text: streamed ? `${streamed}\n\n（中断：${(e as Error).message}）` : `出错了：${(e as Error).message}`,
      createdAt: new Date().toISOString(),
      model,
      error: true
    }
  } finally {
    active.delete(paper)
  }
  chat.messages.push(answer)
  await saveChat(paper, chat)
  emit({ paper, kind: 'done', message: answer })
  return answer
}

export function stopAsking(paper: string): void {
  active.get(paper)?.abort()
}

export async function resetChat(paper: string): Promise<void> {
  await saveChat(paper, { messages: [] })
}
