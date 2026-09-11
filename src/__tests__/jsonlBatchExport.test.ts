import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pipeline/api', () => ({
  pipeline: {
    readStage: vi.fn(),
    setStatus: vi.fn(),
  },
}))
vi.mock('../ai/embeddings', () => ({
  embedEntries: vi.fn(),
  embedBook: vi.fn(),
}))
vi.mock('../utils/ollamaConfig', () => ({
  loadOllamaConfig: () => ({
    model: 'qwen2.5:3b',
    embedModel: 'bge-m3:latest',
    baseUrl: 'http://localhost:11434',
    useVision: false,
  }),
}))
vi.mock('../output/writer', () => ({
  upsertBookRecord: vi.fn(),
  upsertEntryRecords: vi.fn(),
}))

import { pipeline } from '../pipeline/api'
import { embedEntries, embedBook } from '../ai/embeddings'
import { upsertBookRecord, upsertEntryRecords } from '../output/writer'
import { exportJsonlBatch } from '../output/jsonlBatchExport'
import type { ReviewedEntry, OcrPage } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'

const readStage = vi.mocked(pipeline.readStage)
const setStatus = vi.mocked(pipeline.setStatus)
const mockEmbedEntries = vi.mocked(embedEntries)
const mockEmbedBook = vi.mocked(embedBook)
const mockUpsertBookRecord = vi.mocked(upsertBookRecord)
const mockUpsertEntryRecords = vi.mocked(upsertEntryRecords)

function entry(seq: number): ReviewedEntry {
  return {
    seq,
    level: 1,
    heading_text: `見出し${seq}`,
    page_number: seq * 5,
    contributor: null,
    raw_ocr_text: 'OCR原文',
    source_page_index: 0,
    confidence: 0.87,
    reviewed: false,
    edited: false,
  }
}

function meta(mmsId: string): SruMetadata {
  return {
    mmsId,
    isbn: ['9784167137113'],
    titleOriginal: '夕陽カ丘三号館',
    titleRomanized: 'Yuhigaoka sangokan',
    subtitle: null,
    creatorOriginal: null,
    creatorRomanized: null,
    publisher: null,
    pubPlace: null,
    pubYear: '2012',
    subjects: [],
    classification: [],
    tocPdfUrl: 'https://example.org/toc.pdf',
    callNumber: null,
    location: null,
    holdingLibrary: null,
    holdingStatus: null,
    source: 'alma',
  }
}

function ocrPages(n: number): OcrPage[] {
  return Array.from({ length: n }, (_, i) => ({
    page_index: i,
    full_text: `page ${i}`,
    text_blocks: [],
    processing_time_ms: 10,
  }))
}

/** readStage の (bookId, stage) 呼び出しに応じて応答を切り替えるヘルパー */
function stubReadStage(byBook: Record<string, { review?: ReviewedEntry[]; sru_meta?: SruMetadata; ocr?: OcrPage[] }>) {
  readStage.mockImplementation(async (bookId: string, stage: string) => {
    const book = byBook[bookId]
    if (!book) throw new Error(`no stub for ${bookId}`)
    if (stage === 'review') {
      if (book.review === undefined) throw new Error('no review.json')
      return book.review as never
    }
    if (stage === 'sru_meta') {
      if (book.sru_meta === undefined) throw new Error('no sru_meta.json')
      return book.sru_meta as never
    }
    if (stage === 'ocr') {
      if (book.ocr === undefined) throw new Error('no ocr.json')
      return book.ocr as never
    }
    throw new Error(`unexpected stage ${stage}`)
  })
}

describe('exportJsonlBatch', () => {
  beforeEach(() => {
    readStage.mockReset()
    setStatus.mockReset()
    mockEmbedEntries.mockReset()
    mockEmbedBook.mockReset()
    mockUpsertBookRecord.mockReset()
    mockUpsertEntryRecords.mockReset()
    mockEmbedEntries.mockResolvedValue([{ seq: 1, embedding: [0.1], embed_text: 'x' }])
    mockEmbedBook.mockResolvedValue([0.1, 0.2])
    setStatus.mockResolvedValue(undefined)
    mockUpsertBookRecord.mockResolvedValue(undefined)
    mockUpsertEntryRecords.mockResolvedValue(undefined)
  })

  it('review.jsonがない書籍はnot_reviewedでスキップされ、upsertは呼ばれない', async () => {
    stubReadStage({ B1: {} })

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'skipped', reason: 'not_reviewed' })
    expect(r.skipCount).toBe(1)
    expect(r.okCount).toBe(0)
    expect(mockUpsertBookRecord).not.toHaveBeenCalled()
    expect(mockUpsertEntryRecords).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('review.jsonが空配列でもnot_reviewedになる', async () => {
    stubReadStage({ B1: { review: [] } })

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ status: 'skipped', reason: 'not_reviewed' })
  })

  it('sru_metaが読めない書籍はno_metaでスキップされる', async () => {
    stubReadStage({ B1: { review: [entry(1)] } })

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'skipped', reason: 'no_meta' })
    expect(mockUpsertBookRecord).not.toHaveBeenCalled()
  })

  it('ocr.jsonが読めない書籍はno_ocrでスキップされる', async () => {
    stubReadStage({ B1: { review: [entry(1)], sru_meta: meta('B1') } })

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'skipped', reason: 'no_ocr' })
    expect(mockUpsertBookRecord).not.toHaveBeenCalled()
  })

  it('正常な書籍はokになり、entriesがreviewed:trueでupsertされ、page_countはocr.jsonの長さ、statusはexported', async () => {
    stubReadStage({
      B1: { review: [entry(1), entry(2)], sru_meta: meta('B1'), ocr: ocrPages(7) },
    })

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'ok', entryCount: 2 })
    expect(r.okCount).toBe(1)

    expect(mockUpsertBookRecord).toHaveBeenCalledTimes(1)
    const [sruMetaArg, pageCount, llmModel] = mockUpsertBookRecord.mock.calls[0]
    expect(sruMetaArg).toMatchObject({ mmsId: 'B1' })
    expect(pageCount).toBe(7)
    expect(llmModel).toBe('qwen2.5:3b')

    expect(mockUpsertEntryRecords).toHaveBeenCalledTimes(1)
    const [bookIdArg, entriesArg] = mockUpsertEntryRecords.mock.calls[0]
    expect(bookIdArg).toBe('B1')
    expect((entriesArg as ReviewedEntry[]).every(e => e.reviewed === true)).toBe(true)

    expect(setStatus).toHaveBeenCalledWith('B1', 'exported')
  })

  it('埋め込み失敗時はno_embedになり、レコードはupsertされ、statusはexported_no_embed', async () => {
    stubReadStage({
      B1: { review: [entry(1)], sru_meta: meta('B1'), ocr: ocrPages(3) },
    })
    mockEmbedEntries.mockRejectedValue(new Error('ollama down'))

    const r = await exportJsonlBatch(['B1'])

    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'no_embed' })
    expect(r.noEmbedCount).toBe(1)
    expect(mockUpsertBookRecord).toHaveBeenCalledTimes(1)
    expect(mockUpsertEntryRecords).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledWith('B1', 'exported_no_embed')
  })

  it('1書籍のエラーが後続書籍の処理を妨げない', async () => {
    stubReadStage({
      B1: { review: [entry(1)], sru_meta: meta('B1') }, // ocr.json 無し → no_ocr でスキップ
      B2: { review: [entry(1)], sru_meta: meta('B2'), ocr: ocrPages(2) },
    })

    const r = await exportJsonlBatch(['B1', 'B2'])

    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({ status: 'skipped', reason: 'no_ocr' })
    expect(r.items.find(i => i.bookId === 'B2')).toMatchObject({ status: 'ok' })
    expect(setStatus).toHaveBeenCalledWith('B2', 'exported')
    expect(setStatus).not.toHaveBeenCalledWith('B1', expect.anything())
  })

  it('予期しないエラーでも1件のスキップとして扱い、他の書籍の処理を止めない', async () => {
    stubReadStage({
      B1: { review: [entry(1)], sru_meta: meta('B1'), ocr: ocrPages(2) },
      B2: { review: [entry(1)], sru_meta: meta('B2'), ocr: ocrPages(2) },
    })
    mockUpsertBookRecord.mockRejectedValueOnce(new Error('disk full'))

    const r = await exportJsonlBatch(['B1', 'B2'])

    // 書き込み失敗は no_meta（書誌情報未取得）に丸めず専用の error として報告する
    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({ status: 'skipped', reason: 'error' })
    expect(r.items.find(i => i.bookId === 'B1')?.detail).toContain('disk full')
    expect(r.items.find(i => i.bookId === 'B2')).toMatchObject({ status: 'ok' })
  })

  it('書籍間でabortすると、それ以降の書籍は一切処理されない', async () => {
    stubReadStage({
      B1: { review: [entry(1)], sru_meta: meta('B1'), ocr: ocrPages(2) },
      B2: { review: [entry(1)], sru_meta: meta('B2'), ocr: ocrPages(2) },
    })
    let calls = 0
    const shouldAbort = () => {
      calls++
      return calls > 1 // B1 処理前は false、B2 処理前は true
    }

    const r = await exportJsonlBatch(['B1', 'B2'], { shouldAbort })

    expect(r.aborted).toBe(true)
    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({ status: 'ok' })
    expect(r.items.find(i => i.bookId === 'B2')).toBeUndefined()
    expect(mockUpsertBookRecord).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus).not.toHaveBeenCalledWith('B2', expect.anything())
  })

  it('onProgressで書籍位置が単調増加して通知される', async () => {
    stubReadStage({
      B1: { review: [entry(1)], sru_meta: meta('B1'), ocr: ocrPages(2) },
      B2: { review: [entry(1)], sru_meta: meta('B2'), ocr: ocrPages(2) },
    })
    const onProgress = vi.fn()

    await exportJsonlBatch(['B1', 'B2'], { onProgress })

    const bookDoneValues = onProgress.mock.calls.map(c => c[0].bookDone)
    for (let i = 1; i < bookDoneValues.length; i++) {
      expect(bookDoneValues[i]).toBeGreaterThanOrEqual(bookDoneValues[i - 1])
    }
    expect(bookDoneValues[0]).toBe(0)
    expect(bookDoneValues[bookDoneValues.length - 1]).toBe(2)
    expect(onProgress.mock.calls.some(c => c[0].bookTotal === 2)).toBe(true)
  })
})
