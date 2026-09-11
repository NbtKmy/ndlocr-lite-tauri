import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pipeline/api', () => ({
  pipeline: {
    readStage: vi.fn(),
    upsertOutputRecords: vi.fn(),
    appendOutputText: vi.fn(),
  },
}))
vi.mock('../ai/cinii-client', () => ({ lookupCiniiNcid: vi.fn() }))
vi.mock('../utils/outputConfig', () => ({
  loadOutputConfig: () => ({ outputDir: '/tmp/out' }),
}))

import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid } from '../ai/cinii-client'
import { exportCiniiBook, toIsoWithOffset, formatLogLine } from '../output/ciniiExport'
import type { ReviewedEntry, CiniiBookRecord } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'

const readStage = vi.mocked(pipeline.readStage)
const upsert = vi.mocked(pipeline.upsertOutputRecords)
const appendText = vi.mocked(pipeline.appendOutputText)
const lookup = vi.mocked(lookupCiniiNcid)

/** ローカル時刻 2026-09-09 20:52:26 */
const FIXED = new Date(2026, 8, 9, 20, 52, 26)
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

const META: SruMetadata = {
  mmsId: '991234567890',
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

describe('toIsoWithOffset', () => {
  it('オフセット付き ISO8601 になり Z を含まない', () => {
    const s = toIsoWithOffset(FIXED)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(s).not.toContain('Z')
  })

  it('ローカルの年月日時分秒をそのまま使う', () => {
    expect(toIsoWithOffset(FIXED).startsWith('2026-09-09T20:52:26')).toBe(true)
  })
})

describe('formatLogLine', () => {
  it('OK 行（1件ヒット）', () => {
    expect(
      formatLogLine(
        {
          status: 'ok',
          exportedAt: '2026-09-09T20:52:26+09:00',
          ncid: 'BB08395220',
          queriedIsbns: ['9784167137113'],
          hits: 1,
          entryCount: 42,
        },
        '991234567890'
      )
    ).toBe(
      '2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 isbn=9784167137113 hits=1 entries=42'
    )
  })

  it('OK 行（複数ISBNを照会した場合は isbn がカンマ区切りになる）', () => {
    expect(
      formatLogLine(
        {
          status: 'ok',
          exportedAt: '2026-09-09T20:52:26+09:00',
          ncid: 'BB08395220',
          queriedIsbns: ['9784167137113', '9784101132150'],
          hits: 1,
          entryCount: 42,
        },
        '991234567890'
      )
    ).toBe(
      '2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 isbn=9784167137113,9784101132150 hits=1 entries=42'
    )
  })

  it('OK 行（複数ヒットは note を付ける）', () => {
    expect(
      formatLogLine(
        {
          status: 'ok',
          exportedAt: '2026-09-09T20:53:44+09:00',
          ncid: 'BA12345678',
          queriedIsbns: ['9784200000000'],
          hits: 3,
          entryCount: 18,
        },
        '991236000000'
      )
    ).toBe(
      '2026-09-09T20:53:44+09:00 991236000000 OK   ncid=BA12345678 isbn=9784200000000 hits=3 entries=18 note=複数3件ヒット→先頭採用'
    )
  })

  it('OK 行（queriedIsbns/hitsが無い場合は isbn=/hits= を出さず、undefinedという文字列も出さない）', () => {
    const line = formatLogLine(
      {
        status: 'ok',
        exportedAt: '2026-09-09T20:52:26+09:00',
        ncid: 'BB08395220',
        entryCount: 42,
      },
      '991234567890'
    )
    expect(line).toBe('2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 entries=42')
    expect(line).not.toContain('undefined')
  })

  it('SKIP 行（no_hit）', () => {
    expect(
      formatLogLine(
        {
          status: 'skipped',
          reason: 'no_hit',
          exportedAt: '2026-09-09T20:53:01+09:00',
          queriedIsbns: ['9784100000000'],
          hits: 0,
        },
        '991235000000'
      )
    ).toBe('2026-09-09T20:53:01+09:00 991235000000 SKIP reason=no_hit isbn=9784100000000 hits=0')
  })

  it('SKIP 行（no_isbn は isbn も hits も付けない）', () => {
    expect(
      formatLogLine(
        { status: 'skipped', reason: 'no_isbn', exportedAt: '2026-09-09T20:54:10+09:00' },
        '991237000000'
      )
    ).toBe('2026-09-09T20:54:10+09:00 991237000000 SKIP reason=no_isbn')
  })

  it('SKIP 行（not_reviewed）', () => {
    expect(
      formatLogLine(
        { status: 'skipped', reason: 'not_reviewed', exportedAt: '2026-09-09T20:55:02+09:00' },
        '991238000000'
      )
    ).toBe('2026-09-09T20:55:02+09:00 991238000000 SKIP reason=not_reviewed')
  })

  it('SKIP 行（detail はスペースを含みうるので必ず行末）', () => {
    const line = formatLogLine(
      {
        status: 'skipped',
        reason: 'api_error',
        exportedAt: '2026-09-09T20:56:33+09:00',
        queriedIsbns: ['9784300000000'],
        detail: 'http_get error: 503',
      },
      '991239000000'
    )
    expect(line).toBe(
      '2026-09-09T20:56:33+09:00 991239000000 SKIP reason=api_error isbn=9784300000000 detail=http_get error: 503'
    )
    expect(line.endsWith('detail=http_get error: 503')).toBe(true)
  })

  it('detail に改行が含まれても1行に畳む', () => {
    const line = formatLogLine(
      {
        status: 'skipped',
        reason: 'api_error',
        exportedAt: '2026-09-09T20:56:33+09:00',
        detail: 'http_get failed:\nconnection refused\r\nretry later',
      },
      '991239000000'
    )
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toBe(
      '2026-09-09T20:56:33+09:00 991239000000 SKIP reason=api_error detail=http_get failed: connection refused retry later'
    )
  })
})

describe('exportCiniiBook', () => {
  beforeEach(() => {
    readStage.mockReset()
    upsert.mockReset()
    appendText.mockReset()
    lookup.mockReset()
    appendText.mockResolvedValue(LOG_PATH)
    upsert.mockResolvedValue(undefined)
  })

  it('toc は5項目のみで、OCR中間情報・信頼度・埋め込みを含まない', async () => {
    readStage.mockResolvedValue([entry(1), entry(2)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', META, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    expect(Object.keys(record.toc[0]).sort()).toEqual([
      'contributor',
      'heading_text',
      'level',
      'page_number',
      'seq',
    ])
    expect(record.toc[0]).not.toHaveProperty('raw_ocr_text')
    expect(record.toc[0]).not.toHaveProperty('confidence')
    expect(record.toc[0]).not.toHaveProperty('embedding')
  })

  it('書誌フィールドを SRU メタデータから組み立てる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', META, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    expect(record.book_id).toBe('991234567890')
    expect(record.cinii_ncid).toBe('BB08395220')
    expect(record.title).toBe('夕陽カ丘三号館')
    expect(record.pub_year).toBe('2012')
    expect(record.isbn).toEqual(['9784167137113'])
  })

  it('titleOriginal が null なら titleRomanized を使う', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', { ...META, titleOriginal: null }, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    expect(record.title).toBe('Yuhigaoka sangokan')
  })

  it('exported_at とログ行のタイムスタンプが同一値になる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    const logLine = appendText.mock.calls[0][1]
    expect(record.exported_at).toBe(r.exportedAt)
    expect(logLine.startsWith(r.exportedAt)).toBe(true)
  })

  it('upsertOutputRecords を cinii_books.jsonl と book_id で呼ぶ', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', META, FIXED)

    expect(upsert).toHaveBeenCalledTimes(1)
    const [file, bookId, records, outputDir] = upsert.mock.calls[0]
    expect(file).toBe('cinii_books.jsonl')
    expect(bookId).toBe('991234567890')
    expect(records).toHaveLength(1)
    expect(outputDir).toBe('/tmp/out')
  })

  it('成功時は jsonlPath をログパスから導出する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('ok')
    expect(r.entryCount).toBe(1)
    expect(r.logPath).toBe(LOG_PATH)
    expect(r.jsonlPath).toBe('/tmp/out/cinii_books.jsonl')
  })

  it('Windows形式のログパスでも jsonlPath を正しく組み立てる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockResolvedValue(
      'C:\\Users\\nobu\\AppData\\Roaming\\com.nobu.ndltococr\\data\\output\\cinii_export.log'
    )

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.jsonlPath).toBe(
      'C:\\Users\\nobu\\AppData\\Roaming\\com.nobu.ndltococr\\data\\output\\cinii_books.jsonl'
    )
  })

  it('review.json が読めなければ JSONL を書かず not_reviewed をログに残す', async () => {
    readStage.mockRejectedValue(new Error('read_stage_json: No such file'))

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('skipped')
    expect(r.reason).toBe('not_reviewed')
    expect(upsert).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(appendText).toHaveBeenCalledTimes(1)
    expect(r.logPath).toBe(LOG_PATH)
  })

  it('review.json が空配列でも not_reviewed になる', async () => {
    readStage.mockResolvedValue([])

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('not_reviewed')
    expect(upsert).not.toHaveBeenCalled()
    expect(r.logPath).toBe(LOG_PATH)
  })

  it('有効な ISBN がなければ no_isbn で JSONL を書かない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: null, hits: 0, queriedIsbns: [] })

    const r = await exportCiniiBook('991234567890', { ...META, isbn: [] }, FIXED)

    expect(r.reason).toBe('no_isbn')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('ヒット0件なら no_hit で JSONL を書かない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: null, hits: 0, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('no_hit')
    expect(r.queriedIsbns).toEqual(['9784167137113'])
    expect(upsert).not.toHaveBeenCalled()
    expect(r.logPath).toBe(LOG_PATH)
  })

  it('NCID解析不能（hits>0）でも no_hit で JSONL を書かず、ログに hits を残す', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: null, hits: 1, queriedIsbns: ['9784167137113'] })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('no_hit')
    expect(upsert).not.toHaveBeenCalled()
    expect(appendText.mock.calls[0][1]).toContain('hits=1')
  })

  it('通信失敗なら api_error で detail を残す', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({
      ncid: null,
      hits: 0,
      queriedIsbns: ['9784167137113'],
      error: 'http_get error: 503',
    })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('api_error')
    expect(r.detail).toBe('http_get error: 503')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('複数ヒット時は hits を保持する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BA12345678', hits: 3, queriedIsbns: ['9784200000000'] })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('ok')
    expect(r.hits).toBe(3)
    expect(appendText.mock.calls[0][1]).toContain('note=複数3件ヒット→先頭採用')
  })

  it('成功時にログ書き込みが失敗しても status は ok のままで logWriteError を持つ', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockRejectedValue(new Error('disk full'))

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('ok')
    expect(r.logWriteError).toBe('Error: disk full')
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('成功時にログ書き込みが失敗した場合、jsonlPath と logPath は未設定になる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })
    appendText.mockRejectedValue(new Error('disk full'))

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.jsonlPath).toBeUndefined()
    expect(r.logPath).toBeUndefined()
  })

  it('内部seqに欠番があってもtoc.seqは1始まりに詰め直され、heading_textの順序は保たれる', async () => {
    const gapped: ReviewedEntry[] = [2, 3, 6, 8].map(seq => ({ ...entry(seq), heading_text: `見出し${seq}` }))
    readStage.mockResolvedValue(gapped)
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', META, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    expect(record.toc.map(t => t.seq)).toEqual([1, 2, 3, 4])
    expect(record.toc.map(t => t.heading_text)).toEqual(['見出し2', '見出し3', '見出し6', '見出し8'])
  })

  it('buildCiniiRecordはentries配列を変更しない（非破壊）', async () => {
    const gapped: ReviewedEntry[] = [2, 3, 6, 8].map(seq => entry(seq))
    const snapshot = gapped.map(e => ({ ...e }))
    readStage.mockResolvedValue(gapped)
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbns: ['9784167137113'] })

    await exportCiniiBook('991234567890', META, FIXED)

    expect(gapped).toEqual(snapshot)
  })
})
