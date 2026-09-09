/**
 * CiNii Books ID 付き目次JSONL（埋め込みなし）の出力
 *
 * 出力対象は承認時に確定した review.json のみ。ReviewView の画面 state は使わない。
 * ReviewedEntry の reviewed フラグはエントリ単位の人的チェック印として機能していないため
 * （一括で書き換えられる）、「承認を通ったか」を review.json の存在で書籍単位に判定する。
 * 詳細は docs/superpowers/specs/2026-09-09-cinii-toc-export-design.md の決定 D1。
 */
import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid } from '../ai/cinii-client'
import type { SruMetadata } from '../ai/sru-client'
import type { ReviewedEntry, CiniiBookRecord, CiniiTocEntry, CiniiSkipReason } from '../pipeline/types'
import { loadOutputConfig } from '../utils/outputConfig'

/** cinii_books.jsonl / cinii_export.log のファイル名。バッチ出力（ciniiBatchExport.ts）と共有する */
export const CINII_FILE = 'cinii_books.jsonl'
export const LOG_FILE = 'cinii_export.log'

// 単体出力時代からの型はそのまま re-export し、既存の import 経路を壊さない。
// 実体は pipeline/types.ts（ciniiBatchExport.ts の CiniiBatchItemResult と共有するため）。
export type { CiniiSkipReason }

export interface CiniiExportResult {
  status: 'ok' | 'skipped'
  reason?: CiniiSkipReason
  detail?: string
  ncid?: string
  hits?: number
  queriedIsbns?: string[]
  entryCount?: number
  /** ログファイルの絶対パス */
  logPath?: string
  /** 書き込んだ cinii_books.jsonl の絶対パス。成功時のみ設定 */
  jsonlPath?: string
  /** レコードは出力できたがログ書き込みが失敗した場合のみ設定 */
  logWriteError?: string
  exportedAt: string
}

/** logPath をディレクトリと区切り文字に分解する（Windows は \ 区切り） */
function splitLogPath(path: string): { dir: string; sep: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return { dir: path, sep: '/' }
  return { dir: path.slice(0, cut), sep: path[cut] }
}

/** 出力先ディレクトリ設定を読む。バッチ出力（ciniiBatchExport.ts）と共有する */
export function outputDir(): string | undefined {
  const dir = loadOutputConfig().outputDir
  return dir || undefined
}

/** オフセット付き ISO8601。toISOString() は UTC の Z 表記になりログの可読性が落ちるため使わない */
export function toIsoWithOffset(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** ReviewedEntry から出力用の5項目のみを取り出す */
function toCiniiTocEntry(e: ReviewedEntry): CiniiTocEntry {
  return {
    seq: e.seq,
    level: e.level,
    heading_text: e.heading_text,
    page_number: e.page_number,
    contributor: e.contributor,
  }
}

/**
 * review.json + sruMeta + 採用済み NCID から CiniiBookRecord を組み立てる。
 * 単体出力（exportCiniiBook）とバッチ出力（ciniiBatchExport.ts）で共有する。
 * toc は毎回 entries から作り直すため、既存 jsonl 行の古い toc を引き継がない。
 */
export function buildCiniiRecord(
  bookId: string,
  sruMeta: SruMetadata,
  entries: ReviewedEntry[],
  ncid: string,
  exportedAt: string
): CiniiBookRecord {
  return {
    book_id: bookId,
    cinii_ncid: ncid,
    title: sruMeta.titleOriginal ?? sruMeta.titleRomanized,
    pub_year: sruMeta.pubYear,
    isbn: sruMeta.isbn,
    exported_at: exportedAt,
    toc: entries.map(toCiniiTocEntry),
  }
}

/** ログは1イベント1行のため、値に含まれる改行を空白に畳む */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

/** ログ1行を組み立てる（設計仕様 §3.2）。'OK  ' の末尾スペースは SKIP と桁を揃えるため */
export function formatLogLine(r: CiniiExportResult, bookId: string): string {
  const parts = [r.exportedAt, bookId]
  if (r.status === 'ok') {
    parts.push('OK  ')
    parts.push(`ncid=${r.ncid}`)
    // バッチ出力でNCIDを再利用した場合は照会していないため queriedIsbns/hits が undefined になる。
    // SKIP分岐と同様に値がある場合のみ push し、ログに "undefined" という文字列を出さない。
    if (r.queriedIsbns?.length) parts.push(`isbn=${r.queriedIsbns.join(',')}`)
    if (r.hits !== undefined) parts.push(`hits=${r.hits}`)
    parts.push(`entries=${r.entryCount}`)
    if ((r.hits ?? 0) > 1) {
      parts.push(`note=複数${r.hits}件ヒット→先頭採用`)
    }
  } else {
    parts.push('SKIP')
    parts.push(`reason=${r.reason}`)
    if (r.queriedIsbns?.length) parts.push(`isbn=${r.queriedIsbns.join(',')}`)
    if (r.hits !== undefined) parts.push(`hits=${r.hits}`)
    // detail は値にスペースを含みうるため必ず行末に置く
    if (r.detail) parts.push(`detail=${oneLine(r.detail)}`)
  }
  return parts.join(' ')
}

/**
 * 1書籍分を cinii_books.jsonl に upsert し、結果を cinii_export.log に追記する
 * スキップは業務上の正常な結果なので例外を投げず CiniiExportResult で返す
 * @param now テスト時に固定時刻を注入する
 */
export async function exportCiniiBook(
  bookId: string,
  sruMeta: SruMetadata,
  now?: Date
): Promise<CiniiExportResult> {
  const exportedAt = toIsoWithOffset(now ?? new Date())
  const dir = outputDir()

  const skip = async (
    reason: CiniiSkipReason,
    extra: Partial<CiniiExportResult> = {}
  ): Promise<CiniiExportResult> => {
    const result: CiniiExportResult = { status: 'skipped', reason, exportedAt, ...extra }
    result.logPath = await pipeline.appendOutputText(LOG_FILE, formatLogLine(result, bookId), dir)
    return result
  }

  // ① 承認時に確定した review.json のみを出力対象とする
  let entries: ReviewedEntry[]
  try {
    entries = await pipeline.readStage<ReviewedEntry[]>(bookId, 'review')
  } catch {
    return skip('not_reviewed')
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return skip('not_reviewed')
  }

  // ② CiNii 照会
  const lookup = await lookupCiniiNcid(sruMeta.isbn)
  if (lookup.error) {
    return skip('api_error', {
      queriedIsbns: lookup.queriedIsbns,
      detail: lookup.error,
    })
  }
  if (lookup.queriedIsbns.length === 0) {
    return skip('no_isbn')
  }
  if (!lookup.ncid) {
    return skip('no_hit', { queriedIsbns: lookup.queriedIsbns, hits: lookup.hits })
  }

  // ③ レコード組立と書き込み
  const record: CiniiBookRecord = buildCiniiRecord(bookId, sruMeta, entries, lookup.ncid, exportedAt)
  await pipeline.upsertOutputRecords(CINII_FILE, bookId, [record], dir)

  const result: CiniiExportResult = {
    status: 'ok',
    exportedAt,
    ncid: lookup.ncid,
    hits: lookup.hits,
    queriedIsbns: lookup.queriedIsbns,
    entryCount: entries.length,
  }
  // レコード(cinii_books.jsonl)は既に書き込み済み。ここでのログ書き込み失敗を
  // 呼び出し元に伝播させると「何も書けなかった」ように見えてしまい実際と食い違うため、
  // status は ok のまま保ち logWriteError に詳細を残して呼び出し元に正直に伝える。
  try {
    result.logPath = await pipeline.appendOutputText(LOG_FILE, formatLogLine(result, bookId), dir)
    const { dir: logDir, sep } = splitLogPath(result.logPath)
    result.jsonlPath = `${logDir}${sep}${CINII_FILE}`
  } catch (e) {
    result.logWriteError = String(e)
  }
  return result
}
