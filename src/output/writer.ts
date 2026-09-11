/**
 * postgres投入用 JSONL の出力ライター
 * Tauri command (upsert_output_records) 経由でディスク書き込み。
 * book_id をキーに upsert するため、再承認・JSONL再出力を繰り返しても行が重複しない
 * （旧 append 版の writeBookRecord/writeEntryRecords は v0.19.0 で削除。approve() の
 * 再実行で books.jsonl / entries.jsonl に重複行ができていた問題への対処）
 */
import { pipeline } from '../pipeline/api'
import type { ReviewedEntry, OutputEntry, OutputBook } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'
import type { EmbedResult } from '../ai/embeddings'
import { loadOutputConfig } from '../utils/outputConfig'

const BOOKS_FILE = 'books.jsonl'
const ENTRIES_FILE = 'entries.jsonl'

function outputDir(): string | undefined {
  const dir = loadOutputConfig().outputDir
  return dir || undefined
}

export async function upsertBookRecord(
  sruMeta: SruMetadata,
  pageCount: number,
  llmModel: string,
  processedAt: string,
  bookEmbedding?: number[]
): Promise<void> {
  const record: OutputBook = {
    book_id: sruMeta.mmsId,
    source_pdf: sruMeta.tocPdfUrl,
    isbn: sruMeta.isbn,
    title_original: sruMeta.titleOriginal,
    title_romanized: sruMeta.titleRomanized,
    subtitle: sruMeta.subtitle,
    creator_original: sruMeta.creatorOriginal,
    creator_romanized: sruMeta.creatorRomanized,
    publisher: sruMeta.publisher,
    pub_place: sruMeta.pubPlace,
    pub_year: sruMeta.pubYear,
    subjects: sruMeta.subjects,
    classification: sruMeta.classification,
    toc_pdf_url: sruMeta.tocPdfUrl,
    call_number: sruMeta.callNumber,
    location: sruMeta.location,
    holding_library: sruMeta.holdingLibrary,
    holding_status: sruMeta.holdingStatus,
    source: sruMeta.source,
    page_count: pageCount,
    ocr_model_version: '1.0.0',
    llm_model: llmModel,
    embed_model: 'bge-m3',
    embed_dim: 1024,
    processed_at: processedAt,
    embedding: bookEmbedding,
  }
  await pipeline.upsertOutputRecords(BOOKS_FILE, sruMeta.mmsId, [record], outputDir())
}

export async function upsertEntryRecords(
  bookId: string,
  entries: ReviewedEntry[],
  embedResults: EmbedResult[]
): Promise<void> {
  const embedMap = new Map(embedResults.map((e) => [e.seq, e.embedding]))
  const records: OutputEntry[] = entries.map((entry) => ({
    ...entry,
    id: `${bookId}:${entry.seq}`,
    book_id: bookId,
    embedding: embedMap.get(entry.seq),
  }))
  await pipeline.upsertOutputRecords(ENTRIES_FILE, bookId, records, outputDir())
}
