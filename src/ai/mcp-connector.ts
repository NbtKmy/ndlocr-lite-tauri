import type { AIConnector, ProofreadResult, MCPConfig } from '../types/ai'
import { DEFAULT_PROOFREAD_PROMPT } from '../types/ai'

/**
 * MCP Server コネクタ — SSE/HTTP 経由で MCP サーバーと通信
 *
 * MCP Streamable HTTP Transport を使用:
 * - POST /message でリクエスト送信
 * - SSE ストリームでレスポンス受信
 */
export function createMCPConnector(
  config: MCPConfig,
  customPrompt?: string,
): AIConnector {
  const prompt = customPrompt || DEFAULT_PROOFREAD_PROMPT

  return {
    async proofread(ocrText: string, imageBase64: string): Promise<ProofreadResult> {
      // ツール一覧を取得して校正ツールを探す
      const toolName = config.toolName || await findProofreadTool(config.serverUrl)

      const result = await callTool(config.serverUrl, toolName, {
        text: ocrText,
        image: imageBase64,
        prompt,
      })

      return {
        correctedText: typeof result === 'string' ? result : result?.correctedText ?? ocrText,
        changes: result?.changes ?? [],
      }
    },

    async testConnection(): Promise<boolean> {
      try {
        await listTools(config.serverUrl)
        return true
      } catch {
        return false
      }
    },
  }
}

/** JSON-RPC リクエストIDカウンタ */
let rpcId = 0

/** MCP JSON-RPC リクエストを送信して結果を返す */
async function mcpRequest(serverUrl: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = ++rpcId

  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MCP server error ${res.status}: ${err}`)
  }

  const contentType = res.headers.get('content-type') ?? ''

  // SSE ストリームの場合
  if (contentType.includes('text/event-stream')) {
    return parseSSEResponse(res, id)
  }

  // 通常の JSON レスポンス
  const json = await res.json()
  if (json.error) {
    throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`)
  }
  return json.result
}

/** SSE ストリームから対応する JSON-RPC レスポンスを抽出 */
async function parseSSEResponse(res: Response, expectedId: number): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue

      try {
        const json = JSON.parse(data)
        if (json.id === expectedId) {
          reader.cancel()
          if (json.error) {
            throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`)
          }
          return json.result
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('MCP error:')) throw e
        // JSON parse error — skip this line
      }
    }
  }

  throw new Error('MCP server closed connection without response')
}

/** ツール一覧を取得 */
async function listTools(serverUrl: string): Promise<Array<{ name: string; description?: string }>> {
  const result = await mcpRequest(serverUrl, 'tools/list') as { tools?: Array<{ name: string; description?: string }> }
  return result?.tools ?? []
}

/** 校正用ツールを探す */
async function findProofreadTool(serverUrl: string): Promise<string> {
  const tools = await listTools(serverUrl)
  // proofread, ocr_proofread, correct, proofread_ocr 等を探す
  const keywords = ['proofread', 'correct', 'ocr', '校正']
  const found = tools.find((t) =>
    keywords.some((kw) => t.name.toLowerCase().includes(kw) || (t.description ?? '').toLowerCase().includes(kw))
  )
  if (found) return found.name
  // 見つからなければ最初のツールを使う
  if (tools.length > 0) return tools[0].name
  throw new Error('No tools available on MCP server')
}

/** ツールを呼び出す */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(serverUrl: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const result = await mcpRequest(serverUrl, 'tools/call', {
    name: toolName,
    arguments: args,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as { content?: Array<{ type: string; text?: string }> } | any

  // MCP ツールの結果はcontent配列形式
  if (result?.content) {
    const textContent = result.content.find((c: { type: string }) => c.type === 'text')
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text)
      } catch {
        return textContent.text
      }
    }
  }

  return result
}
