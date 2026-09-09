export type BookStatus =
  | 'resolving'
  | 'resolve_failed'
  | 'pending'
  | 'ocr_done'
  | 'llm_done'
  | 'review_pending'
  | 'approved'
  | 'exported'
  | 'exported_no_embed'

export interface BookManifest {
  book_id: string
  source_pdf: string
  status: BookStatus
  page_count?: number
  ocr_model_version?: string
  llm_model?: string
  created_at: string
  updated_at: string
  resolve_fail_reason?: string
}

/** 生OCR結果（1ページ分） */
export interface OcrPage {
  page_index: number
  full_text: string
  text_blocks: Array<{
    text: string
    confidence: number
    bbox: [number, number, number, number]
    reading_order: number
  }>
  processing_time_ms: number
}

/** LLMが出力する目次エントリ（1件） */
export interface TocEntry {
  seq: number
  level: number
  heading_text: string
  page_number: number | null
  contributor: string | null
  raw_ocr_text: string
  source_page_index: number
  confidence: number
}

/** レビュー済みエントリ（埋め込み付き） */
export interface ReviewedEntry extends TocEntry {
  reviewed: boolean
  edited: boolean
  embedding?: number[]
}

/** entries.jsonl の1レコード */
export interface OutputEntry extends ReviewedEntry {
  id: string
  book_id: string
}

/** books.jsonl の1レコード */
export interface OutputBook {
  book_id: string          // MMS ID
  source_pdf: string
  isbn: string[]
  title_original: string | null    // 880（原表記）★検索キー
  title_romanized: string | null   // 245（翻字）
  subtitle: string | null
  creator_original: string | null  // 880
  creator_romanized: string | null // 100/700
  publisher: string | null
  pub_place: string | null
  pub_year: string | null
  subjects: string[]       // 6XX 原表記優先
  classification: string[] // 084/082/050
  toc_pdf_url: string | null
  call_number: string | null
  location: string | null
  holding_library: string | null
  holding_status: string | null
  source: string
  page_count: number
  ocr_model_version: string
  llm_model: string
  embed_model: string
  embed_dim: number
  processed_at: string
  embedding?: number[]     // 書籍レベルベクトル（(a)）
}

/** cinii_books.jsonl の目次エントリ（OCR中間情報・信頼度・埋め込みを含まない） */
export interface CiniiTocEntry {
  seq: number
  level: number
  heading_text: string
  page_number: number | null
  contributor: string | null
}

/** cinii_books.jsonl の1レコード（1書籍1行、埋め込みなし） */
export interface CiniiBookRecord {
  book_id: string          // MMS ID（upsert キー）
  cinii_ncid: string       // 例 BB08395220
  title: string | null     // SRU: titleOriginal ?? titleRomanized
  pub_year: string | null
  isbn: string[]           // SRU 由来の生値
  exported_at: string      // ISO8601（cinii_export.log の行頭と同一値）
  toc: CiniiTocEntry[]
}

/** CiNii 出力（単体・一括共通）のスキップ理由 */
export type CiniiSkipReason = 'not_reviewed' | 'no_isbn' | 'no_hit' | 'api_error'

/** CiNii JSON一括出力（cinii_batch_*.json）の1書籍分の処理結果 */
export interface CiniiBatchItemResult {
  bookId: string
  status: 'ok' | 'skipped'
  reason?: CiniiSkipReason
  detail?: string
  ncid?: string
  /** cinii_books.jsonl から既存NCIDを再利用したか（true ならCiNii照会せず・upsertもしない） */
  ncidReused?: boolean
  entryCount?: number
}

/** CiNii JSON一括出力の全体結果 */
export interface CiniiBatchResult {
  exportedAt: string
  /** 出力したJSON配列ファイルの絶対パス。成功0件なら未設定 */
  filePath?: string
  /** 出力したJSON配列ファイル名（cinii_batch_YYYYMMDD-HHmmss.json、秒まで含む）。成功0件なら未設定 */
  fileName?: string
  okCount: number
  skipCount: number
  items: CiniiBatchItemResult[]
  logPath?: string
  logWriteError?: string
}
