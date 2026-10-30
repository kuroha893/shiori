import { randomUUID } from 'node:crypto'
import type { ChatEvent, ChatMessage } from '../shared/types'
import { loadChat, paperDir, readMeta, readRootText, saveChat } from './library'
import { runClaude } from './claude'
import { chatSystemPrompt } from './prompts'
import { getSettings } from './settings'

const active = new Map<string, AbortController>()

/**
 * One question = one headless Claude Code turn in the paper's own session, so follow-ups
 * ("and the second term?") keep their context. The session lives in Claude Code's own
 * transcript store; chat.json keeps what the reader sees.
 */
export async function ask(
  paper: string,
  input: { text: string; quote?: { block: string; text: string }; model?: string },
  emit: (e: ChatEvent) => void
): Promise<ChatMessage> {
  const meta = readMeta(paper)
  if (!meta) throw new Error('论文不存在')
  if (active.has(paper)) throw new Error('上一个问题还在回答中')

  const chat = await loadChat(paper)
  const model = input.model || getSettings().chatModel
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: input.text,
    quote: input.quote,
    createdAt: new Date().toISOString()
  }
  chat.messages.push(userMsg)
  const resume = !!chat.sessionId
  const sessionId = chat.sessionId || randomUUID()
  chat.sessionId = sessionId
  await saveChat(paper, chat)

  const prompt = input.quote
    ? `The reader selected this passage (block ${input.quote.block}):\n<selection>\n${input.quote.text}\n</selection>\n\n${input.text}`
    : input.text

  const abort = new AbortController()
  active.set(paper, abort)
  let streamed = ''
  let answer: ChatMessage
  try {
    const result = await runClaude({
      cwd: paperDir(paper),
      prompt,
      model,
      tools: ['Read', 'Grep', 'Glob'],
      sessionId,
      resume,
      partial: true,
      systemPrompt: chatSystemPrompt({
        profile: readRootText('profile.md'),
        glossary: readRootText('glossary.md'),
        title: meta.titleZh || meta.title
      }),
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === 'stream_event') {
          const d = event.event
          if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
            streamed += d.delta.text
            emit({ paper, kind: 'delta', text: d.delta.text })
          } else if (d?.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
            const name = d.content_block.name
            emit({ paper, kind: 'status', text: name === 'Read' ? '正在翻阅论文…' : name === 'Grep' ? '正在查找…' : '正在思考…' })
          }
        } else if (event.type === 'assistant') {
          // A new assistant message after tool use: separate it from what streamed before.
          if (streamed && !streamed.endsWith('\n\n')) {
            streamed += '\n\n'
            emit({ paper, kind: 'delta', text: '\n\n' })
          }
        }
      }
    })
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
    // A session that failed to start can't be resumed.
    if (!resume && !streamed) chat.sessionId = undefined
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
