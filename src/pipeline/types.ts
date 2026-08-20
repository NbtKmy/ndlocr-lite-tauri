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
