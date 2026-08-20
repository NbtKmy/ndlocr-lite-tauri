/**
 * Tauri コマンドのフロント側ラッパー
 * invoke の型付けとエラー変換をここで集約
 */
import { invoke } from '@tauri-apps/api/core'
import type { BookManifest, BookStatus, OcrPage, TocEntry, ReviewedEntry, OutputEntry, OutputBook } from './types'

export const pipeline = {
  readFileBytes: (path: string) => invoke<number[]>('read_file_bytes', { path }),

  listInbox: () => invoke<string[]>('list_inbox'),

  listBooks: () => invoke<BookManifest[]>('list_books'),

  getOrCreateBook: (bookId: string, sourcePdf: string) =>
    invoke<BookManifest>('get_or_create_book', { bookId, sourcePdf }),

  setStatus: (bookId: string, status: BookStatus) =>
    invoke<void>('set_book_status', { bookId, status }),

  readStage: <T>(bookId: string, stage: string) =>
    invoke<T>('read_stage_json', { bookId, stage }),

  writeStage: (bookId: string, stage: string, data: unknown) =>
    invoke<void>('write_stage_json', { bookId, stage, data }),

  moveToDone: (pdfPath: string) =>
    invoke<void>('move_to_done', { pdfPath }),

  ollamaChat: (opts: {
    model: string
    systemPrompt: string
    userPrompt: string
    images?: string[]
    jsonMode?: boolean
    ollamaUrl?: string
  }) =>
    invoke<string>('ollama_chat', {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      images: opts.images ?? null,
      jsonMode: opts.jsonMode ?? false,
      ollamaUrl: opts.ollamaUrl ?? null,
    }),

  ollamaEmbed: (model: string, text: string, ollamaUrl?: string) =>
    invoke<number[]>('ollama_embed', { model, text, ollamaUrl: ollamaUrl ?? null }),

  appendOutputRecord: (file: string, record: unknown, outputDir?: string) =>
    invoke<void>('append_output_record', { file, record, outputDir: outputDir ?? null }),

  upsertOutputRecords: (file: string, bookId: string, records: unknown[], outputDir?: string) =>
    invoke<void>('upsert_output_records', { file, bookId, records, outputDir: outputDir ?? null }),

  readOutputFile: (file: string, outputDir?: string) =>
    invoke<string>('read_output_file', { file, outputDir: outputDir ?? null }),

  writeOutputPdf: (bookId: string, bytes: Uint8Array, outputDir?: string) =>
    invoke<string>('write_output_pdf', { bookId, bytes: Array.from(bytes), outputDir: outputDir ?? null }),

  httpGet: (url: string) =>
    invoke<string>('http_get', { url }),

  downloadPdf: (url: string, filename: string) =>
    invoke<string>('download_pdf', { url, filename }),

  deleteBook: (bookId: string) =>
    invoke<void>('delete_book', { bookId }),

  getDefaultOutputDir: () =>
    invoke<string>('get_default_output_dir'),
}

export type { BookManifest, BookStatus, OcrPage, TocEntry, ReviewedEntry, OutputEntry, OutputBook }
