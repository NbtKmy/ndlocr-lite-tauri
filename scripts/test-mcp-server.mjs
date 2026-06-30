#!/usr/bin/env node
/**
 * MCP Server モードのテスト用モックサーバー
 *
 * 使い方:
 *   node scripts/test-mcp-server.mjs
 *
 * デフォルトで http://localhost:3456/mcp で起動します。
 * アプリの設定画面で MCP Server URL に上記URLを入力して接続テストしてください。
 *
 * tools/list → proofread_ocr ツールを返す
 * tools/call → 入力テキストの一部をダミー修正して返す（AI APIは呼ばない）
 */

import { createServer } from 'http'

const PORT = 3456
const ENDPOINT = '/mcp'

/** ダミーの校正処理（テキストの一部を置換して返す） */
function dummyProofread(text) {
  // テスト用: いくつかのパターンをダミー修正
  let corrected = text
  corrected = corrected.replace(/云ふ/g, '言ふ')
  corrected = corrected.replace(/丶/g, '、')
  corrected = corrected.replace(/ヶ所/g, '箇所')
  // 変更がなければ末尾に注記を追加して差分が見えるようにする
  if (corrected === text) {
    corrected = text + '\n[MCP mock: no corrections needed]'
  }
  return corrected
}

/** JSON-RPC リクエストを処理 */
function handleRPC(req) {
  const { method, params } = req

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
      }

    case 'tools/list':
      return {
        tools: [
          {
            name: 'proofread_ocr',
            description: 'OCRテキストを校正するダミーツール（テスト用）',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'OCRテキスト' },
                image: { type: 'string', description: '元画像（base64）' },
                prompt: { type: 'string', description: '校正プロンプト' },
              },
              required: ['text'],
            },
          },
        ],
      }

    case 'tools/call': {
      const toolName = params?.name
      const args = params?.arguments ?? {}

      if (toolName !== 'proofread_ocr') {
        throw { code: -32601, message: `Unknown tool: ${toolName}` }
      }

      const corrected = dummyProofread(args.text ?? '')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ correctedText: corrected, changes: [] }),
          },
        ],
      }
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` }
  }
}

const server = createServer((req, res) => {
  // CORS + COEP対応ヘッダー（COOP/COEPが有効なブラウザからのアクセスに必要）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST' || req.url !== ENDPOINT) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
    return
  }

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try {
      const rpc = JSON.parse(body)
      console.log(`← ${rpc.method}${rpc.params?.name ? ` (${rpc.params.name})` : ''}`)

      const result = handleRPC(rpc)

      const response = { jsonrpc: '2.0', id: rpc.id, result }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))

      console.log(`→ OK`)
    } catch (err) {
      const rpc = JSON.parse(body).id ?? null
      const error = err.code
        ? err
        : { code: -32603, message: err.message ?? 'Internal error' }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc, error }))

      console.log(`→ Error: ${error.message}`)
    }
  })
})

server.listen(PORT, () => {
  console.log(`MCP test server running at http://localhost:${PORT}${ENDPOINT}`)
  console.log(``)
  console.log(`アプリの設定画面で:`)
  console.log(`  接続モード: MCP Server`)
  console.log(`  MCP Server URL: http://localhost:${PORT}${ENDPOINT}`)
  console.log(`  → 「接続テスト」をクリック`)
  console.log(``)
  console.log(`Ctrl+C で終了`)
})
