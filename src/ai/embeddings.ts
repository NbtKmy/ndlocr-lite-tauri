/**
 * Ollama bge-m3 による埋め込み計算
 * - embedBook: 書籍レベル（タイトル + サブジェクト）
 * - embedEntries: 目次エントリ単位（親見出し前置）
 */
import { pipeline } from '../pipeline/api'
import type { TocEntry } from '../pipeline/types'
import type { SruMetadata } from './sru-client'

const DEFAULT_EMBED_MODEL = 'bge-m3:latest'
const DEFAULT_EMBED_DIM = 1024

/**
 * エントリのテキストを埋め込み用に組み立てる。
 * 「書籍タイトル / 親見出し / 見出しタイトル」の形式で
 * コンテキストを持たせることで検索精度を上げる。
 */
function buildEmbedText(
  entry: TocEntry,
  bookTitle: string | null,
  parentHeadings: Map<number, string>
): string {
  const parts: string[] = []
  if (bookTitle) parts.push(bookTitle)
  // level-1 の親見出しがあれば付加
  for (let lvl = 1; lvl < entry.level; lvl++) {
    const parent = parentHeadings.get(lvl)
    if (parent) parts.push(parent)
  }
  parts.push(entry.heading_text)
  if (entry.contributor) parts.push(entry.contributor)
  return parts.join(' / ')
}

/** 書籍レベルのベクトル: title_original + subtitle + subjects を入力とする */
export async function embedBook(
  meta: SruMetadata,
  opts: { model?: string; ollamaUrl?: string } = {}
): Promise<number[]> {
  const parts: string[] = []
  const title = meta.titleOriginal ?? meta.titleRomanized
  if (title) parts.push(title)
  if (meta.subtitle) parts.push(meta.subtitle)
  if (meta.subjects.length > 0) parts.push(meta.subjects.join(' '))
  const text = parts.join(' / ')
  return pipeline.ollamaEmbed(opts.model ?? DEFAULT_EMBED_MODEL, text, opts.ollamaUrl)
}

export interface EmbedResult {
  seq: number
  embedding: number[]
  embed_text: string
}

export async function embedEntries(
  entries: TocEntry[],
  bookTitle: string | null,
  opts: {
    model?: string
    ollamaUrl?: string
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<EmbedResult[]> {
  const model = opts.model ?? DEFAULT_EMBED_MODEL
  const results: EmbedResult[] = []
  const parentHeadings = new Map<number, string>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const embedText = buildEmbedText(entry, bookTitle, parentHeadings)
    const embedding = await pipeline.ollamaEmbed(model, embedText, opts.ollamaUrl)

    if (embedding.length !== DEFAULT_EMBED_DIM) {
      console.warn(`Unexpected embedding dim: ${embedding.length} (expected ${DEFAULT_EMBED_DIM})`)
    }

    results.push({ seq: entry.seq, embedding, embed_text: embedText })
    // 親見出しマップを更新
    parentHeadings.set(entry.level, entry.heading_text)
    opts.onProgress?.(i + 1, entries.length)
  }

  return results
}
