/**
 * CiNii Books ID 付き目次JSON一括出力（複数書籍 → 1つのJSON配列ファイル）
 *
 * 単体出力（src/output/ciniiExport.ts）とレコード組立・出力先解決を共有する。異なる点:
 * - 実行開始時に cinii_books.jsonl を1回だけ読み、既知の NCID を再利用する
 *   （ヒットした書籍は CiNii に照会しない・cinii_books.jsonl への upsert もしない）
 * - 出力は集約した JSON 配列を新規ファイル（cinii_batch_YYYYMMDD-HHmmss.json）に書く。
 *   append_output_text は追記のため、分単位のファイル名だと同一分内の2回目の実行が
 *   既存ファイル末尾に配列を追記し `[...]\n[...]` という不正JSONになる。秒まで含めて回避する
 * - ログは書籍ごとの行を溜めてから1回の追記でまとめて書く（末尾に BATCH 集計行を追加）。
 *   これにより cinii_export.log への書き込み失敗が単一の logWriteError に集約され、
 *   exportCiniiBook と同じ「レコードは書けたがログ書き込みに失敗した」という区別ができる。
 */
import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid } from '../ai/cinii-client'
import type { SruMetadata } from '../ai/sru-client'
import type {
  ReviewedEntry,
  CiniiBookRecord,
  CiniiBatchItemResult,
  CiniiBatchResult,
} from '../pipeline/types'
import {
  CINII_FILE,
  LOG_FILE,
  buildCiniiRecord,
  formatLogLine,
  outputDir,
  toIsoWithOffset,
} from './ciniiExport'

export interface CiniiBatchTarget {
  bookId: string
  sruMeta: SruMetadata
}

/** cinii_books.jsonl を読み、book_id → cinii_ncid の Map を作る。未存在・壊れた行は無視して空Map/スキップで続行する */
async function loadKnownNcids(dir: string | undefined): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let text: string
  try {
    text = await pipeline.readOutputFile(CINII_FILE, dir)
  } catch {
    return map
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as Partial<CiniiBookRecord>
      if (typeof rec.book_id === 'string' && typeof rec.cinii_ncid === 'string') {
        map.set(rec.book_id, rec.cinii_ncid)
      }
    } catch {
      // 壊れた行はスキップして続行する
    }
  }
  return map
}

/**
 * cinii_batch_YYYYMMDD-HHmmss.json 形式のファイル名を組み立てる。
 * 秒まで含めるのは、分単位だと同一分内の2回目の実行で既存ファイルへの追記になり
 * JSON配列として不正な内容（`[...]\n[...]`）になってしまうため。
 */
function batchFileName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `cinii_batch_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`
}

export async function exportCiniiBatch(
  targets: CiniiBatchTarget[],
  now?: Date,
  onProgress?: (done: number, total: number) => void
): Promise<CiniiBatchResult> {
  const nowDate = now ?? new Date()
  const exportedAt = toIsoWithOffset(nowDate)
  const dir = outputDir()
  const total = targets.length

  const knownNcids = await loadKnownNcids(dir)

  const items: CiniiBatchItemResult[] = []
  const records: CiniiBookRecord[] = []
  const logLines: string[] = []
  let done = 0

  for (const { bookId, sruMeta } of targets) {
    try {
      // ① 承認時に確定した review.json のみを出力対象とする
      let entries: ReviewedEntry[]
      try {
        entries = await pipeline.readStage<ReviewedEntry[]>(bookId, 'review')
      } catch {
        entries = []
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        items.push({ bookId, status: 'skipped', reason: 'not_reviewed' })
        logLines.push(formatLogLine({ status: 'skipped', reason: 'not_reviewed', exportedAt }, bookId))
        continue
      }

      // ② NCID解決（ハイブリッド）: 既知ならCiNii照会せず再利用、なければ照会する
      const knownNcid = knownNcids.get(bookId)
      let ncid: string
      let ncidReused: boolean
      let queriedIsbns: string[] | undefined
      let hits: number | undefined

      if (knownNcid) {
        ncid = knownNcid
        ncidReused = true
      } else {
        const lookup = await lookupCiniiNcid(sruMeta.isbn)
        queriedIsbns = lookup.queriedIsbns
        hits = lookup.hits
        if (lookup.error) {
          items.push({ bookId, status: 'skipped', reason: 'api_error', detail: lookup.error })
          logLines.push(
            formatLogLine(
              { status: 'skipped', reason: 'api_error', exportedAt, queriedIsbns, detail: lookup.error },
              bookId
            )
          )
          continue
        }
        if (lookup.queriedIsbns.length === 0) {
          items.push({ bookId, status: 'skipped', reason: 'no_isbn' })
          logLines.push(formatLogLine({ status: 'skipped', reason: 'no_isbn', exportedAt }, bookId))
          continue
        }
        if (!lookup.ncid) {
          items.push({ bookId, status: 'skipped', reason: 'no_hit' })
          logLines.push(
            formatLogLine({ status: 'skipped', reason: 'no_hit', exportedAt, queriedIsbns, hits }, bookId)
          )
          continue
        }
        ncid = lookup.ncid
        ncidReused = false
      }

      // ③ レコードは毎回 review.json + sruMeta から組み立てる（既存jsonl行の古い toc を引き継がない）
      const record = buildCiniiRecord(bookId, sruMeta, entries, ncid, exportedAt)
      records.push(record)

      // 新規に照会して得たNCIDの書籍のみ、従来ファイルにも upsert する（次回の再利用のため）
      if (!ncidReused) {
        await pipeline.upsertOutputRecords(CINII_FILE, bookId, [record], dir)
      }

      items.push({ bookId, status: 'ok', ncid, ncidReused, entryCount: entries.length })
      // NCID再利用時は照会していないため queriedIsbns/hits を持たない。ログの isbn= には
      // 「どの書籍のISBNか」が追える情報として sruMeta.isbn を代わりに使う。
      // note=ncid再利用 を末尾に付けて新規照会分と区別する（hits>1時の既存noteとは互いに排他）。
      const okLine = formatLogLine(
        {
          status: 'ok',
          exportedAt,
          ncid,
          queriedIsbns: ncidReused ? sruMeta.isbn : queriedIsbns,
          hits: ncidReused ? undefined : hits,
          entryCount: entries.length,
        },
        bookId
      )
      logLines.push(ncidReused ? `${okLine} note=ncid再利用` : okLine)
    } catch (e) {
      // 1件のエラーで全体を止めない
      items.push({ bookId, status: 'skipped', reason: 'api_error', detail: String(e) })
      logLines.push(
        formatLogLine({ status: 'skipped', reason: 'api_error', exportedAt, detail: String(e) }, bookId)
      )
    } finally {
      done++
      onProgress?.(done, total)
    }
  }

  const okCount = items.filter(i => i.status === 'ok').length
  const skipCount = items.length - okCount

  const result: CiniiBatchResult = {
    exportedAt,
    okCount,
    skipCount,
    items,
  }

  if (records.length > 0) {
    const fileName = batchFileName(nowDate)
    result.filePath = await pipeline.appendOutputText(fileName, JSON.stringify(records, null, 2), dir)
    result.fileName = fileName
  }

  logLines.push(`${exportedAt} BATCH file=${result.fileName ?? '(none)'} ok=${okCount} skip=${skipCount}`)

  try {
    result.logPath = await pipeline.appendOutputText(LOG_FILE, logLines.join('\n'), dir)
  } catch (e) {
    result.logWriteError = String(e)
  }

  return result
}
