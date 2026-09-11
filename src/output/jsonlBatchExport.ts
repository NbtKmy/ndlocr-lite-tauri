/**
 * JSONL（books.jsonl / entries.jsonl、埋め込み付き）の一括再出力
 *
 * ReviewView.exportJsonlWithEmbeddings() の複数書籍版。InboxView でチェックボックス選択した
 * 複数書籍を対象に、review.json の最新内容から埋め込みを再計算して upsert する。
 *
 * - 順次処理（並列にしない）: 埋め込み計算はOllamaへのHTTPリクエストがボトルネックであり、
 *   複数書籍を並列に投げるとOllamaを叩き過ぎてしまうため
 * - 1書籍のエラーで全体を止めない（exportCiniiBatch と同じ方針）
 * - 埋め込み失敗は致命的エラーにせず、その書籍だけ exported_no_embed として記録を続行する
 *   （ReviewView.exportJsonlWithEmbeddings() と同じ挙動）
 * - ログファイルは書かない（books.jsonl / entries.jsonl はもともとログを書いてこなかった。
 *   結果パネルがフィードバック手段、とユーザーと合意済み）
 */
import { pipeline } from '../pipeline/api'
import { embedEntries, embedBook } from '../ai/embeddings'
import { loadOllamaConfig } from '../utils/ollamaConfig'
import { upsertBookRecord, upsertEntryRecords } from './writer'
import type { ReviewedEntry, OcrPage } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'

/** `error` は上記3種のどれにも該当しない想定外の失敗（upsert・setStatus の書き込み失敗等） */
export type JsonlBatchSkipReason = 'not_reviewed' | 'no_meta' | 'no_ocr' | 'error'

export interface JsonlBatchItemResult {
  bookId: string
  status: 'ok' | 'no_embed' | 'skipped'
  reason?: JsonlBatchSkipReason
  entryCount?: number
  detail?: string
}

export interface JsonlBatchResult {
  okCount: number
  noEmbedCount: number
  skipCount: number
  aborted: boolean
  items: JsonlBatchItemResult[]
}

export interface JsonlBatchProgress {
  bookDone: number
  bookTotal: number
  bookId: string
  entryDone: number
  entryTotal: number
}

export async function exportJsonlBatch(
  bookIds: string[],
  opts: {
    onProgress?: (progress: JsonlBatchProgress) => void
    shouldAbort?: () => boolean
  } = {}
): Promise<JsonlBatchResult> {
  const { onProgress, shouldAbort } = opts
  const total = bookIds.length
  const items: JsonlBatchItemResult[] = []
  let aborted = false

  for (let i = 0; i < bookIds.length; i++) {
    // 書籍と書籍の間でのみ中断を確認する（埋め込み計算の途中では確認しない）。
    // これにより、すでに書き終えた書籍は upsert 済みのまま残り、未処理の書籍には一切触れない
    if (shouldAbort?.()) {
      aborted = true
      break
    }

    const bookId = bookIds[i]
    onProgress?.({ bookDone: i, bookTotal: total, bookId, entryDone: 0, entryTotal: 0 })

    try {
      // ① review.json（承認時の確定データ）を読む。無い・空・配列でない場合はスキップ
      let entries: ReviewedEntry[]
      try {
        entries = await pipeline.readStage<ReviewedEntry[]>(bookId, 'review')
      } catch {
        entries = []
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        items.push({ bookId, status: 'skipped', reason: 'not_reviewed' })
        continue
      }

      // ② sru_meta を読む
      let sruMeta: SruMetadata
      try {
        sruMeta = await pipeline.readStage<SruMetadata>(bookId, 'sru_meta')
      } catch (e) {
        items.push({ bookId, status: 'skipped', reason: 'no_meta', detail: String(e) })
        continue
      }

      // ③ ocr.json はページ数取得のためだけに読む（manifest.page_count は null のことがあるため使えない）
      let ocrPages: OcrPage[]
      try {
        ocrPages = await pipeline.readStage<OcrPage[]>(bookId, 'ocr')
      } catch (e) {
        items.push({ bookId, status: 'skipped', reason: 'no_ocr', detail: String(e) })
        continue
      }

      // ④ entries を reviewed: true としてメモリ上でマークする（review.json は書き直さない）
      const markedEntries = entries.map(e => ({ ...e, reviewed: true }))

      const ollamaConfig = loadOllamaConfig()
      const bookTitle = sruMeta.titleOriginal ?? sruMeta.titleRomanized

      // ⑤ チャンクレベル埋め込み・書籍レベル埋め込み（それぞれ失敗しても致命的にしない）
      let embedResults: Awaited<ReturnType<typeof embedEntries>> = []
      let embedError = false
      try {
        embedResults = await embedEntries(markedEntries, bookTitle, {
          model: ollamaConfig.embedModel,
          ollamaUrl: ollamaConfig.baseUrl,
          onProgress: (done, entryTotal) =>
            onProgress?.({ bookDone: i, bookTotal: total, bookId, entryDone: done, entryTotal }),
        })
      } catch (e) {
        console.warn('[jsonlBatchExport] エントリ埋め込み失敗 (スキップ):', bookId, e)
        embedError = true
      }

      let bookEmbedding: number[] | undefined
      try {
        bookEmbedding = await embedBook(sruMeta, {
          model: ollamaConfig.embedModel,
          ollamaUrl: ollamaConfig.baseUrl,
        })
      } catch (e) {
        console.warn('[jsonlBatchExport] 書籍埋め込み失敗 (スキップ):', bookId, e)
        embedError = true
      }

      // ⑥ upsert
      const now = String(Math.floor(Date.now() / 1000))
      await upsertBookRecord(sruMeta, ocrPages.length, ollamaConfig.model, now, bookEmbedding)
      await upsertEntryRecords(bookId, markedEntries, embedResults)

      // ⑦ ステータス更新
      const newStatus = embedError ? 'exported_no_embed' : 'exported'
      await pipeline.setStatus(bookId, newStatus)

      items.push({
        bookId,
        status: embedError ? 'no_embed' : 'ok',
        entryCount: markedEntries.length,
      })
    } catch (e) {
      // 想定外のエラー（upsert/setStatus 等での失敗）は1件のスキップとして扱い、全体は止めない。
      // 理由は専用の 'error' とし（no_meta に丸めると書き込み失敗が「書誌情報未取得」と
      // 誤表示される）、detail に実際の内容を残す
      items.push({ bookId, status: 'skipped', reason: 'error', detail: String(e) })
    } finally {
      onProgress?.({ bookDone: i + 1, bookTotal: total, bookId, entryDone: 0, entryTotal: 0 })
    }
  }

  const okCount = items.filter(i => i.status === 'ok').length
  const noEmbedCount = items.filter(i => i.status === 'no_embed').length
  const skipCount = items.filter(i => i.status === 'skipped').length

  return { okCount, noEmbedCount, skipCount, aborted, items }
}
