import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pipeline/api', () => ({
  pipeline: {
    readStage: vi.fn(),
    upsertOutputRecords: vi.fn(),
    appendOutputText: vi.fn(),
    readOutputFile: vi.fn(),
  },
}))
vi.mock('../ai/cinii-client', () => ({ lookupCiniiNcid: vi.fn() }))
vi.mock('../utils/outputConfig', () => ({
  loadOutputConfig: () => ({ outputDir: '/tmp/out' }),
}))

import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid } from '../ai/cinii-client'
import { exportCiniiBatch } from '../output/ciniiBatchExport'
import type { ReviewedEntry, CiniiBookRecord } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'

const readStage = vi.mocked(pipeline.readStage)
const upsert = vi.mocked(pipeline.upsertOutputRecords)
const appendText = vi.mocked(pipeline.appendOutputText)
const readOutputFile = vi.mocked(pipeline.readOutputFile)
const lookup = vi.mocked(lookupCiniiNcid)

/** ローカル時刻 2026-09-10 14:05:00 */
const FIXED = new Date(2026, 8, 10, 14, 5, 0)
const LOG_PATH = '/tmp/out/cinii_export.log'

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

function meta(isbn: string[] = ['9784167137113']): SruMetadata {
  return {
    mmsId: '991234567890',
    isbn,
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

function findAppend(fileMatcher: string | ((f: string) => boolean)) {
  const calls = appendText.mock.calls
  const call = calls.find(c =>
    typeof fileMatcher === 'string' ? c[0] === fileMatcher : fileMatcher(c[0] as string)
  )
  if (!call) throw new Error(`appendOutputText call not found for ${fileMatcher}`)
  return call
}

describe('exportCiniiBatch', () => {
  beforeEach(() => {
    readStage.mockReset()
    upsert.mockReset()
    appendText.mockReset()
    readOutputFile.mockReset()
    lookup.mockReset()
    appendText.mockResolvedValue(LOG_PATH)
    upsert.mockResolvedValue(undefined)
    readOutputFile.mockRejectedValue(new Error('read_output_file: No such file'))
  })

  it('cinii_books.jsonl にNCIDがある書籍はlookupCiniiNcidを呼ばず、upsertもしない', async () => {
    readOutputFile.mockResolvedValue(
      JSON.stringify({
        book_id: 'B1',
        cinii_ncid: 'BB00000001',
        title: 'old',
        pub_year: '2000',
        isbn: ['x'],
        exported_at: 'old',
        toc: [{ seq: 99, level: 9, heading_text: '古い見出し', page_number: 999, contributor: null }],
      }) + '\n'
    )
    readStage.mockResolvedValue([entry(1), entry(2)])

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(lookup).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
    expect(r.okCount).toBe(1)
    expect(r.items[0]).toMatchObject({ bookId: 'B1', status: 'ok', ncid: 'BB00000001', ncidReused: true })
  })

  it('未出力の書籍は照会され、cinii_books.jsonlにもupsertされる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB09999999', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBatch([{ bookId: 'B2', sruMeta: meta() }], FIXED)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
    const [file, bookId, records, dir] = upsert.mock.calls[0]
    expect(file).toBe('cinii_books.jsonl')
    expect(bookId).toBe('B2')
    expect((records as CiniiBookRecord[])[0].cinii_ncid).toBe('BB09999999')
    expect(dir).toBe('/tmp/out')
    expect(r.items[0].ncidReused).toBe(false)
  })

  it('再利用と新規照会が混在する', async () => {
    readOutputFile.mockResolvedValue(
      JSON.stringify({
        book_id: 'B1',
        cinii_ncid: 'BBOLD',
        title: null,
        pub_year: null,
        isbn: [],
        exported_at: 'x',
        toc: [],
      }) + '\n'
    )
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBNEW', hits: 1, queriedIsbns: ['9784200000000'] })

    const r = await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta() },
        { bookId: 'B2', sruMeta: meta(['9784200000000']) },
      ],
      FIXED
    )

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0][1]).toBe('B2')
    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({ ncid: 'BBOLD', ncidReused: true })
    expect(r.items.find(i => i.bookId === 'B2')).toMatchObject({ ncid: 'BBNEW', ncidReused: false })
    expect(r.okCount).toBe(2)
  })

  it('review.jsonがない書籍はnot_reviewedでスキップされ、JSON配列に含まれない', async () => {
    readStage.mockRejectedValueOnce(new Error('no review')).mockResolvedValueOnce([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta() },
        { bookId: 'B2', sruMeta: meta() },
      ],
      FIXED
    )

    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({ status: 'skipped', reason: 'not_reviewed' })
    expect(r.okCount).toBe(1)
    expect(r.skipCount).toBe(1)

    const jsonCall = findAppend(f => f.startsWith('cinii_batch_'))
    const written = JSON.parse(jsonCall[1] as string) as CiniiBookRecord[]
    expect(written.find(rec => rec.book_id === 'B1')).toBeUndefined()
    expect(written.find(rec => rec.book_id === 'B2')).toBeDefined()
  })

  it('review.jsonが空配列でもnot_reviewedになる', async () => {
    readStage.mockResolvedValue([])

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.items[0]).toMatchObject({ status: 'skipped', reason: 'not_reviewed' })
    expect(lookup).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('1書籍のapi_errorで他書籍の処理が継続する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup
      .mockResolvedValueOnce({ ncid: null, hits: 0, queriedIsbns: ['9784167137113'], error: 'http_get error: 503' })
      .mockResolvedValueOnce({ ncid: 'BBOK', hits: 1, queriedIsbns: ['9784200000000'] })

    const r = await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta(['9784167137113']) },
        { bookId: 'B2', sruMeta: meta(['9784200000000']) },
      ],
      FIXED
    )

    expect(r.items.find(i => i.bookId === 'B1')).toMatchObject({
      status: 'skipped',
      reason: 'api_error',
      detail: 'http_get error: 503',
    })
    expect(r.items.find(i => i.bookId === 'B2')).toMatchObject({ status: 'ok', ncid: 'BBOK' })
    expect(r.okCount).toBe(1)
    expect(r.skipCount).toBe(1)
  })

  it('no_isbn / no_hit も他書籍の処理を止めない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup
      .mockResolvedValueOnce({ ncid: null, hits: 0, queriedIsbns: [] })
      .mockResolvedValueOnce({ ncid: null, hits: 0, queriedIsbns: ['9784200000000'] })
      .mockResolvedValueOnce({ ncid: 'BBOK', hits: 1, queriedIsbns: ['9784300000000'] })

    const r = await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta([]) },
        { bookId: 'B2', sruMeta: meta(['9784200000000']) },
        { bookId: 'B3', sruMeta: meta(['9784300000000']) },
      ],
      FIXED
    )

    expect(r.items.find(i => i.bookId === 'B1')?.reason).toBe('no_isbn')
    expect(r.items.find(i => i.bookId === 'B2')?.reason).toBe('no_hit')
    expect(r.items.find(i => i.bookId === 'B3')?.status).toBe('ok')
    expect(r.okCount).toBe(1)
    expect(r.skipCount).toBe(2)
  })

  it('出力されるJSONは配列で、tocはreview.jsonの最新内容になる（既存jsonlの古いtocを引き継がない）', async () => {
    readOutputFile.mockResolvedValue(
      JSON.stringify({
        book_id: 'B1',
        cinii_ncid: 'BBOLD',
        title: 'old title',
        pub_year: '1999',
        isbn: ['x'],
        exported_at: 'old',
        toc: [{ seq: 99, level: 9, heading_text: '古い見出し', page_number: 999, contributor: null }],
      }) + '\n'
    )
    readStage.mockResolvedValue([entry(1), entry(2)])

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.fileName).toBeDefined()
    const jsonCall = findAppend(r.fileName!)
    const written = JSON.parse(jsonCall[1] as string) as CiniiBookRecord[]
    expect(Array.isArray(written)).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0].toc).toHaveLength(2)
    expect(written[0].toc.map(t => t.seq)).toEqual([1, 2])
    expect(Object.keys(written[0]).sort()).toEqual(
      ['book_id', 'cinii_ncid', 'exported_at', 'isbn', 'pub_year', 'title', 'toc'].sort()
    )
    // タイトル・出版年は最新のsruMetaから来ており、古いjsonl行の値を引き継がない
    expect(written[0].title).toBe('夕陽カ丘三号館')
    expect(written[0].pub_year).toBe('2012')
  })

  it('ファイル名がcinii_batch_YYYYMMDD-HHmmss.json形式（秒付き）になる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockImplementation(async (file: string) => `/tmp/out/${file}`)

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.fileName).toBe('cinii_batch_20260910-140500.json')
    expect(r.filePath).toBe('/tmp/out/cinii_batch_20260910-140500.json')
  })

  it('同一分内でも秒が異なれば別ファイル名になる（同一分2回実行での上書き・追記破損を防ぐ）', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockImplementation(async (file: string) => `/tmp/out/${file}`)

    const secondRunSameMinute = new Date(2026, 8, 10, 14, 5, 12)
    const r1 = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)
    const r2 = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], secondRunSameMinute)

    expect(r1.fileName).not.toBe(r2.fileName)
    expect(r2.fileName).toBe('cinii_batch_20260910-140512.json')
  })

  it('ログに書籍ごとの行とBATCH集計行が書かれる', async () => {
    readStage.mockResolvedValueOnce([entry(1)]).mockRejectedValueOnce(new Error('nf'))
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta() },
        { bookId: 'B2', sruMeta: meta() },
      ],
      FIXED
    )

    const logCall = findAppend('cinii_export.log')
    const logText = logCall[1] as string
    expect(logText).toMatch(/B1 OK/)
    expect(logText).toMatch(/B2 SKIP reason=not_reviewed/)
    expect(logText).toMatch(/BATCH file=cinii_batch_20260910-140500\.json ok=1 skip=1/)
    expect(r.logPath).toBe(LOG_PATH)
  })

  it('NCID再利用書籍のログ行にundefinedが含まれず、isbn=にsruMetaのISBNが入り note=ncid再利用が付く', async () => {
    readOutputFile.mockResolvedValue(
      JSON.stringify({
        book_id: 'B1',
        cinii_ncid: 'BBOLD',
        title: null,
        pub_year: null,
        isbn: [],
        exported_at: 'x',
        toc: [],
      }) + '\n'
    )
    readStage.mockResolvedValue([entry(1)])

    const r = await exportCiniiBatch(
      [{ bookId: 'B1', sruMeta: meta(['9784111111111', '9784222222222']) }],
      FIXED
    )

    expect(lookup).not.toHaveBeenCalled()
    expect(r.items[0]).toMatchObject({ status: 'ok', ncid: 'BBOLD', ncidReused: true })

    const logCall = findAppend('cinii_export.log')
    const logText = logCall[1] as string
    expect(logText).not.toContain('undefined')
    expect(logText).toContain('isbn=9784111111111,9784222222222')
    expect(logText).toContain('note=ncid再利用')
  })

  it('新規照会書籍のログ行はisbn=とhits=を含み、note=ncid再利用を含まない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBNEW', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.items[0]).toMatchObject({ status: 'ok', ncid: 'BBNEW', ncidReused: false })

    const logCall = findAppend('cinii_export.log')
    const logText = logCall[1] as string
    expect(logText).not.toContain('undefined')
    expect(logText).toContain('isbn=9784167137113')
    expect(logText).toContain('hits=1')
    expect(logText).not.toContain('note=ncid再利用')
  })

  it('成功0件のときはJSONファイルを作らない', async () => {
    readStage.mockResolvedValue([])

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.okCount).toBe(0)
    expect(r.filePath).toBeUndefined()
    expect(r.fileName).toBeUndefined()
    expect(appendText.mock.calls.some(c => (c[0] as string).startsWith('cinii_batch_'))).toBe(false)
    const logCall = findAppend('cinii_export.log')
    expect(logCall[1]).toContain('BATCH')
    expect(logCall[1]).toContain('ok=0 skip=1')
  })

  it('cinii_books.jsonlが未存在（readOutputFileがreject）でも全件照会にフォールバックする', async () => {
    readOutputFile.mockRejectedValue(new Error('read_output_file: No such file or directory'))
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(r.okCount).toBe(1)
  })

  it('cinii_books.jsonlの壊れた行は無視して続行する', async () => {
    readOutputFile.mockResolvedValue('not valid json\n{"book_id":"B2","cinii_ncid":"BBGOOD"}\n')
    readStage.mockResolvedValue([entry(1)])

    const r = await exportCiniiBatch([{ bookId: 'B2', sruMeta: meta() }], FIXED)

    expect(lookup).not.toHaveBeenCalled()
    expect(r.items[0].ncid).toBe('BBGOOD')
  })

  it('onProgressで進捗を通知する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })
    const onProgress = vi.fn()

    await exportCiniiBatch(
      [
        { bookId: 'B1', sruMeta: meta() },
        { bookId: 'B2', sruMeta: meta() },
      ],
      FIXED,
      onProgress
    )

    expect(onProgress).toHaveBeenCalledWith(1, 2)
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it('ログ書き込みが失敗してもstatusには影響せずlogWriteErrorに残す', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BBX', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockImplementation(async (file: string) => {
      if (file === 'cinii_export.log') throw new Error('disk full')
      return LOG_PATH.replace('cinii_export.log', file)
    })

    const r = await exportCiniiBatch([{ bookId: 'B1', sruMeta: meta() }], FIXED)

    expect(r.okCount).toBe(1)
    expect(r.logWriteError).toBe('Error: disk full')
    expect(r.logPath).toBeUndefined()
    // JSON配列ファイルは書けているのでレコードは失われていない
    expect(r.filePath).toBeDefined()
  })
})
