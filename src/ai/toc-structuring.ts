/**
 * Ollama を使った目次OCR結果の校正＋構造化
 * Rust command (ollama_chat) 経由で呼び出すことでCORSを回避
 */
import { pipeline } from '../pipeline/api'
import type { OcrPage, TocEntry } from '../pipeline/types'

const DEFAULT_MODEL = 'qwen2.5:3b'

const SYSTEM_PROMPT = `あなたは日本語書籍の目次データ抽出の専門家です。
OCRした目次テキストから目次エントリだけを抽出し、JSONで返してください。

## 目次エントリの見分け方
目次エントリは「見出し…ページ番号」または「見出し　ページ番号」の形式です。
例1: 「高僧の幽霊済度…35」→ heading_text="高僧の幽霊済度", page_number=35
例2: 「死者との遭遇… 10」→ heading_text="死者との遭遇", page_number=10
例3: 「第三章　近代の成立　　45」→ heading_text="第三章　近代の成立", page_number=45

## 抽出しないもの（必ず無視）
- 書名・著者名・出版社・シリーズ名などの書誌情報
- ◦ ・ * 一 などで始まるサブ項目・本文内容の要約行
- ページ番号が付いていない行（章タイトル単独行は level で判断）
- あとがき・参考文献・索引・奥付

## 階層レベル
level=1: 部（「第一部」など）
level=2: 章（「第一章」「プロローグ」「エピローグ」など）
level=3: 節（章の下位項目）
level=4: 項（節の下位項目）

## 出力形式（JSONのみ・説明文不要）
{"entries": [
  {"seq": 1, "level": 2, "heading_text": "見出し", "page_number": 10, "source_page_index": 1},
  {"seq": 2, "level": 3, "heading_text": "節の見出し", "page_number": 15, "source_page_index": 1}
]}`

interface StructureResult {
  entries: TocEntry[]
  raw_response: string
  model: string
}

/**
 * 目次らしいページだけを残すフィルタ。
 * 「見出し…数字」パターンが1件もなく文字数も少ないページ（タイトル・奥付等）を除外する。
 */
function filterTocPages(pages: OcrPage[]): OcrPage[] {
  const TOC_PATTERN = /[^\s][….]{1,3}\s*\d+|[^\s]\s{2,}\d+\s*$/m
  const filtered = pages.filter(p => TOC_PATTERN.test(p.full_text) || p.full_text.length > 200)
  // フィルタ後に1件も残らない場合は全ページを送る（フォールバック）
  return filtered.length > 0 ? filtered : pages
}

export async function structureToc(
  pages: OcrPage[],
  opts: {
    model?: string
    ollamaUrl?: string
    /** ページ画像のbase64（マルチモーダルモデル使用時、省略可） */
    pageImages?: Record<number, string>
  } = {}
): Promise<StructureResult> {
  const model = opts.model ?? DEFAULT_MODEL

  // タイトルページ等の非TOCページを除外してからLLMに送る
  const tocPages = filterTocPages(pages)
  if (tocPages.length < pages.length) {
    console.info(`[structureToc] ${pages.length}ページ中 ${tocPages.length}ページを目次候補として送信`)
  }

  const pageTexts = tocPages
    .map((p) => `--- ページ ${p.page_index + 1} ---\n${p.full_text}`)
    .join('\n\n')

  const userPrompt = `以下の目次OCRテキストを構造化してください。\n\n${pageTexts}`

  // ビジョンモード: 全ページ画像をbase64に変換して渡す（data:...プレフィックスを除去）
  const images = opts.pageImages
    ? tocPages
        .map(p => opts.pageImages![p.page_index])
        .filter(Boolean)
        .map(url => url.replace(/^data:[^;]+;base64,/, ''))
    : undefined

  const raw = await pipeline.ollamaChat({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    images,
    jsonMode: true,
    ollamaUrl: opts.ollamaUrl,
  })

  const entries = parseEntries(raw, tocPages)
  return { entries, raw_response: raw, model }
}

function mapRawEntries(arr: Partial<TocEntry>[], pages: OcrPage[]): TocEntry[] {
  return arr.map((e, i) => ({
    seq: e.seq ?? i + 1,
    level: e.level ?? 2,
    heading_text: e.heading_text ?? '',
    page_number: e.page_number ?? null,
    contributor: e.contributor ?? null,
    raw_ocr_text: e.raw_ocr_text ?? '',
    source_page_index: e.source_page_index ?? pages[0]?.page_index ?? 0,
    confidence: e.confidence ?? 0.8,
  }))
}

function parseEntries(raw: string, pages: OcrPage[]): TocEntry[] {
  // コードフェンス除去（```json ... ``` 形式に対応）
  let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim()

  try {
    const parsed = JSON.parse(cleaned)

    // { "entries": [...] } 形式
    if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      return mapRawEntries(parsed.entries, pages)
    }

    // 素の配列 [...]
    if (Array.isArray(parsed) && parsed.length > 0) {
      return mapRawEntries(parsed, pages)
    }

    // 他キー名（toc, items, data, results 等）を探す
    if (parsed && typeof parsed === 'object') {
      const arrKey = Object.keys(parsed).find(
        k => Array.isArray(parsed[k]) && parsed[k].length > 0
      )
      if (arrKey) return mapRawEntries(parsed[arrKey], pages)
    }
  } catch {
    console.error('[structureToc] JSON parse failed. Raw response:', raw)
  }

  return []
}
