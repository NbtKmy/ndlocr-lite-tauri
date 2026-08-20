import { useState, useEffect, useCallback } from 'react'
import { pipeline } from '../pipeline/api'
import type { OcrPage, TocEntry, ReviewedEntry } from '../pipeline/types'
import { structureToc } from '../ai/toc-structuring'
import { embedEntries, embedBook } from '../ai/embeddings'
import { loadOllamaConfig } from '../utils/ollamaConfig'
import { loadOutputConfig, saveOutputConfig } from '../utils/outputConfig'
import { pickFolder } from '../utils/folderPicker'
import { writeBookRecord, writeEntryRecords, upsertBookRecord, upsertEntryRecords } from '../output/writer'
import { generateTocPdf } from '../output/tocPdf'
import { EntryEditor } from './EntryEditor'
import { ImageViewer } from '../components/viewer/ImageViewer'
import { pdfToProcessedImages } from '../utils/pdfLoader'
import { imageDataToDataUrl } from '../utils/imageLoader'
import type { SruMetadata } from '../ai/sru-client'

interface ReviewViewProps {
  bookId: string
  onBack: () => void
}

type Phase = 'loading' | 'ocr_missing' | 'structuring' | 'review' | 'approving' | 'retrying_embed' | 'done' | 'error'

/** SRUメタデータが無い本（手動追加）用のフォールバック */
function makeFallbackMeta(bookId: string): SruMetadata {
  return {
    mmsId: bookId,
    isbn: [],
    titleOriginal: null,
    titleRomanized: null,
    subtitle: null,
    creatorOriginal: null,
    creatorRomanized: null,
    publisher: null,
    pubPlace: null,
    pubYear: null,
    subjects: [],
    classification: [],
    tocPdfUrl: `${bookId}.pdf`,
    callNumber: null,
    location: null,
    holdingLibrary: null,
    holdingStatus: null,
    source: 'manual',
  }
}

export function ReviewView({ bookId, onBack }: ReviewViewProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [ocrPages, setOcrPages] = useState<OcrPage[]>([])
  const [entries, setEntries] = useState<ReviewedEntry[]>([])
  const [currentPageIdx, setCurrentPageIdx] = useState(0)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [sruMeta, setSruMeta] = useState<SruMetadata | null>(null)
  const [pageImages, setPageImages] = useState<string[]>([])
  const [imageLoading, setImageLoading] = useState(false)
  const [rawLlmResponse, setRawLlmResponse] = useState<string | null>(null)
  const [showRawResponse, setShowRawResponse] = useState(false)
  const [outputConfirm, setOutputConfirm] = useState<{ defaultDir: string } | null>(null)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [embedFailed, setEmbedFailed] = useState(false)
  const [pdfMessage, setPdfMessage] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const ocr = await pipeline.readStage<OcrPage[]>(bookId, 'ocr')
        setOcrPages(ocr)

        // SRUメタデータを読む（ない場合はフォールバック）
        try {
          const meta = await pipeline.readStage<SruMetadata>(bookId, 'sru_meta')
          setSruMeta(meta)
        } catch {
          setSruMeta(makeFallbackMeta(bookId))
        }

        // PDF画像を非同期ロード（バックグラウンドで表示更新）
        pipeline.listBooks().then(async (allBooks) => {
          const manifest = allBooks.find(b => b.book_id === bookId)
          if (!manifest?.source_pdf) return
          setImageLoading(true)
          try {
            const bytes = await pipeline.readFileBytes(manifest.source_pdf)
            const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
            const file = new File([blob], `${bookId}.pdf`, { type: 'application/pdf' })
            const processed = await pdfToProcessedImages(file, 2.0)
            setPageImages(processed.map(p => imageDataToDataUrl(p.imageData)))
          } catch (e) {
            console.warn('[ReviewView] PDF画像読み込み失敗:', e)
          } finally {
            setImageLoading(false)
          }
        })

        // exported_no_embed の書籍は review.json からエントリを読み込んで再埋め込み画面へ
        const allBooks = await pipeline.listBooks().catch(() => [] as typeof pipeline extends { listBooks: () => Promise<infer T> } ? T : never[])
        const manifest = (allBooks as Awaited<ReturnType<typeof pipeline.listBooks>>).find(b => b.book_id === bookId)
        if (manifest?.status === 'exported_no_embed') {
          try {
            const reviewed = await pipeline.readStage<ReviewedEntry[]>(bookId, 'review')
            setEntries(reviewed)
          } catch {
            // review.json がなければ draft.json にフォールバック
            try {
              const draft = await pipeline.readStage<TocEntry[]>(bookId, 'draft')
              setEntries(draft.map(e => ({ ...e, reviewed: true, edited: false })))
            } catch { /* ignore */ }
          }
          setEmbedFailed(true)
          setPhase('done')
          return
        }

        try {
          const draft = await pipeline.readStage<TocEntry[]>(bookId, 'draft')
          const reviewed: ReviewedEntry[] = draft.map(e => ({ ...e, reviewed: false, edited: false }))
          setEntries(reviewed)
          setPhase('review')
        } catch {
          setPhase('ocr_missing')
        }
      } catch {
        setPhase('ocr_missing')
      }
    }
    load()
  }, [bookId])

  // entries が変わるたびにデバウンスして draft.json へ自動保存
  useEffect(() => {
    if (phase !== 'review') return
    if (entries.length === 0) return
    setSaveStatus('unsaved')
    const timer = setTimeout(async () => {
      setSaveStatus('saving')
      try {
        await pipeline.writeStage(bookId, 'draft', entries)
        setSaveStatus('saved')
      } catch {
        setSaveStatus('unsaved')
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [entries, bookId, phase])

  const runStructuring = useCallback(async () => {
    setPhase('structuring')
    setProgress('Ollama に目次構造化を依頼中…')
    try {
      const ollamaConfig = loadOllamaConfig()
      const pageImageMap = ollamaConfig.useVision && pageImages.length > 0
        ? Object.fromEntries(ocrPages.map((p, i) => [p.page_index, pageImages[i] ?? '']))
        : undefined
      const result = await structureToc(ocrPages, {
        model: ollamaConfig.model,
        ollamaUrl: ollamaConfig.baseUrl || undefined,
        pageImages: pageImageMap,
      })

      // エントリが空の場合は生レスポンスを保持（デバッグ用）
      if (result.entries.length === 0) {
        setRawLlmResponse(result.raw_response)
      } else {
        setRawLlmResponse(null)
      }

      await pipeline.writeStage(bookId, 'draft', result.entries)
      await pipeline.setStatus(bookId, 'review_pending')
      const reviewed: ReviewedEntry[] = result.entries.map(e => ({ ...e, reviewed: false, edited: false }))
      setEntries(reviewed)
      setPhase('review')
    } catch (e) {
      setError(`構造化エラー: ${e}`)
      setPhase('error')
    }
  }, [bookId, ocrPages, pageImages])

  /** 目次PDF出力（承認前でも実行可能、entries.jsonl等とは独立） */
  const handleExportPdf = useCallback(async () => {
    setPdfMessage('PDF生成中…')
    try {
      const meta = sruMeta ?? makeFallbackMeta(bookId)
      const config = loadOutputConfig()
      const bytes = await generateTocPdf(meta, entries)
      const path = await pipeline.writeOutputPdf(bookId, bytes, config.outputDir || undefined)
      setPdfMessage(`PDF出力しました: ${path}`)
    } catch (e) {
      setPdfMessage(`PDF出力エラー: ${e}`)
    }
  }, [bookId, entries, sruMeta])

  /** 承認ボタン → まず出力先確認ダイアログを表示 */
  const handleApproveClick = useCallback(async () => {
    const config = loadOutputConfig()
    const defaultDir = await pipeline.getDefaultOutputDir().catch(() => '')
    const effectiveDir = config.outputDir || defaultDir
    setOutputConfirm({ defaultDir: effectiveDir })
  }, [])

  const approve = useCallback(async (outputDirOverride?: string) => {
    setOutputConfirm(null)
    setPhase('approving')
    setProgress('埋め込みを計算中…')
    try {
      // 出力先を一時的に上書きする場合は設定に保存
      if (outputDirOverride !== undefined) {
        saveOutputConfig({ outputDir: outputDirOverride })
      }

      // Ollama 設定を読み込み
      const ollamaConfig = loadOllamaConfig()

      const markedEntries = entries.map(e => ({ ...e, reviewed: true }))
      const meta = sruMeta ?? makeFallbackMeta(bookId)
      const bookTitle = meta.titleOriginal ?? meta.titleRomanized

      // チャンクレベル埋め込み（失敗時は空でフォールバック）
      let embedResults: Awaited<ReturnType<typeof embedEntries>> = []
      let embedError = false
      try {
        embedResults = await embedEntries(markedEntries, bookTitle, {
          model: ollamaConfig.embedModel,
          ollamaUrl: ollamaConfig.baseUrl,
          onProgress: (done, total) => setProgress(`エントリ埋め込み ${done}/${total}件…`),
        })
      } catch (e) {
        console.warn('[ReviewView] エントリ埋め込み失敗 (スキップ):', e)
        embedError = true
      }

      // 書籍レベル埋め込み
      setProgress('書籍レベル埋め込みを計算中…')
      let bookEmbedding: number[] | undefined
      try {
        bookEmbedding = await embedBook(meta, {
          model: ollamaConfig.embedModel,
          ollamaUrl: ollamaConfig.baseUrl,
        })
      } catch (e) {
        console.warn('[ReviewView] 書籍埋め込み失敗 (スキップ):', e)
        embedError = true
      }

      setProgress('JSONL 出力中…')
      const now = String(Math.floor(Date.now() / 1000))
      await pipeline.writeStage(bookId, 'review', markedEntries)
      await writeBookRecord(meta, ocrPages.length, ollamaConfig.model, now, bookEmbedding)
      await writeEntryRecords(bookId, markedEntries, embedResults)
      const newStatus = embedError ? 'exported_no_embed' : 'exported'
      await pipeline.setStatus(bookId, newStatus)
      setEmbedFailed(embedError)
      setPhase('done')
    } catch (e) {
      setError(`承認エラー: ${e}`)
      setPhase('error')
    }
  }, [bookId, entries, ocrPages, sruMeta])

  const retryEmbed = useCallback(async () => {
    setPhase('retrying_embed')
    setProgress('埋め込みを再計算中…')
    try {
      const ollamaConfig = loadOllamaConfig()
      const meta = sruMeta ?? makeFallbackMeta(bookId)
      const bookTitle = meta.titleOriginal ?? meta.titleRomanized

      const embedResults = await embedEntries(entries, bookTitle, {
        model: ollamaConfig.embedModel,
        ollamaUrl: ollamaConfig.baseUrl,
        onProgress: (done, total) => setProgress(`エントリ埋め込み ${done}/${total}件…`),
      })

      setProgress('書籍レベル埋め込みを計算中…')
      let bookEmbedding: number[] | undefined
      try {
        bookEmbedding = await embedBook(meta, {
          model: ollamaConfig.embedModel,
          ollamaUrl: ollamaConfig.baseUrl,
        })
      } catch (e) {
        console.warn('[ReviewView] 書籍埋め込み失敗 (スキップ):', e)
      }

      setProgress('JSONL 上書き中…')
      const now = String(Math.floor(Date.now() / 1000))
      await upsertBookRecord(meta, ocrPages.length, ollamaConfig.model, now, bookEmbedding)
      await upsertEntryRecords(bookId, entries, embedResults)
      await pipeline.setStatus(bookId, 'exported')
      setEmbedFailed(false)
      setPhase('done')
    } catch (e) {
      setError(`再埋め込みエラー: ${e}`)
      setPhase('error')
    }
  }, [bookId, entries, ocrPages, sruMeta])

  const currentPage = ocrPages[currentPageIdx]

  if (phase === 'loading') {
    return <div className="review-loading">読み込み中…</div>
  }

  if (phase === 'retrying_embed') {
    return (
      <div className="review-loading">
        <p>{progress}</p>
      </div>
    )
  }

  if (phase === 'done') {
    if (embedFailed) {
      return (
        <div className="review-done">
          <h2>⚠️ 埋め込みなしで出力済み</h2>
          <p>目次データは <code>entries.jsonl</code> に出力されました。</p>
          <p>Ollama の埋め込みモデル（bge-m3）を確認してから再試行できます。</p>
          <div className="review-done-actions">
            <button className="btn-secondary" onClick={onBack}>← キューに戻る</button>
            <button className="btn-primary" onClick={retryEmbed}>再埋め込みを実行</button>
          </div>
        </div>
      )
    }
    return (
      <div className="review-done">
        <h2>✅ 承認完了</h2>
        <p><code>data/output/entries.jsonl</code> に出力しました。</p>
        <button className="btn-primary" onClick={onBack}>← キューに戻る</button>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="review-error">
        <h2>エラー</h2>
        <p>{error}</p>
        <button onClick={onBack}>← 戻る</button>
      </div>
    )
  }

  return (
    <div className="review-view">
      {/* 出力先確認ダイアログ */}
      {outputConfirm && (
        <div className="output-confirm-overlay" onClick={() => setOutputConfirm(null)}>
          <div className="output-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="output-confirm-title">出力先の確認</h3>
            <p className="output-confirm-path-label">現在の出力先:</p>
            <code className="output-confirm-path">{outputConfirm.defaultDir}</code>
            <p className="output-confirm-note">
              出力先は⚙設定パネルのパイプライン設定から変更できます。
            </p>
            <div className="output-confirm-actions">
              <button
                className="btn-secondary"
                onClick={() => setOutputConfirm(null)}
              >
                キャンセル
              </button>
              <button
                className="btn-secondary"
                onClick={async () => {
                  const picked = await pickFolder('出力フォルダを選択')
                  if (picked) approve(picked)
                }}
              >
                別の場所を選択…
              </button>
              <button
                className="btn-approve"
                onClick={() => approve(undefined)}
              >
                この場所に出力
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ヘッダー */}
      <div className="review-header">
        <button className="btn-back" onClick={onBack}>← キュー</button>
        <h2 className="review-title">
          {sruMeta?.titleOriginal ?? sruMeta?.titleRomanized ?? bookId}
        </h2>
        <div className="review-header-actions">
          {phase === 'ocr_missing' && (
            <button className="btn-primary" onClick={runStructuring}>
              LLM構造化を実行
            </button>
          )}
          {phase === 'review' && (
            <>
              <button className="btn-secondary" onClick={runStructuring}>
                再構造化
              </button>
              <button className="btn-secondary" onClick={handleExportPdf}>
                PDF出力
              </button>
              <button className="btn-approve" onClick={handleApproveClick}>
                承認 → 出力
              </button>
            </>
          )}
          {phase === 'review' && (
            <span className={`save-status save-status-${saveStatus}`}>
              {saveStatus === 'saving' ? '保存中…' : saveStatus === 'unsaved' ? '未保存' : '✓ 保存済み'}
            </span>
          )}
          {phase === 'review' && pdfMessage && (
            <span className="progress-text">{pdfMessage}</span>
          )}
          {(phase === 'approving' || phase === 'structuring') && (
            <span className="progress-text">{progress}</span>
          )}
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="review-body">
        {/* 左: 画像ビューア */}
        <div className="review-image-panel">
          {currentPage ? (
            <>
              <div className="page-nav">
                {ocrPages.map((p, i) => (
                  <button
                    key={i}
                    className={`page-tab ${i === currentPageIdx ? 'active' : ''}`}
                    onClick={() => setCurrentPageIdx(i)}
                  >
                    p.{p.page_index + 1}
                  </button>
                ))}
              </div>
              {imageLoading && (
                <div className="image-loading-indicator">PDF画像を読み込み中…</div>
              )}
              <ImageViewer
                imageDataUrl={pageImages[currentPageIdx] ?? ''}
                textBlocks={[]}
                selectedBlocks={new Set()}
                onBlockClick={() => {}}
                pageBlocks={[]}
              />
              <div className="ocr-text-raw">
                <h4>生OCRテキスト</h4>
                <pre>{currentPage.full_text}</pre>
              </div>
            </>
          ) : (
            <div className="no-ocr">
              <p>OCRデータがまだありません。</p>
              <p>先にOCR処理を実行してください。</p>
            </div>
          )}
        </div>

        {/* 右: エントリエディタ */}
        <div className="review-entry-panel">
          {phase === 'ocr_missing' && ocrPages.length === 0 && (
            <div className="ocr-missing-hint">
              <p>OCRデータが見つかりません。</p>
              <p>ベースのOCRアプリでPDFを処理してから、Inboxからこの書籍を処理してください。</p>
            </div>
          )}
          {(phase === 'review' || phase === 'approving') && (
            <>
              {/* 構造化結果が空の場合：生レスポンスを表示してデバッグ可能に */}
              {rawLlmResponse !== null && entries.length === 0 && (
                <div className="llm-raw-response-panel">
                  <div className="llm-raw-response-header">
                    <span className="llm-raw-response-warn">
                      ⚠ LLMが目次エントリを返しませんでした（0件）
                    </span>
                    <button
                      className="btn-tiny"
                      onClick={() => setShowRawResponse(v => !v)}
                    >
                      {showRawResponse ? '▲ 生レスポンスを隠す' : '▼ 生レスポンスを確認'}
                    </button>
                  </div>
                  {showRawResponse && (
                    <pre className="llm-raw-response-body">{rawLlmResponse || '（空のレスポンス）'}</pre>
                  )}
                  <p className="llm-raw-response-hint">
                    ローカルLLM設定で構造化LLMモデルを確認し、「再構造化」を試してください。
                  </p>
                </div>
              )}
              <EntryEditor
                entries={entries}
                onChange={setEntries}
                filterPageIdx={currentPage?.page_index}
              />
            </>
          )}
          {phase === 'ocr_missing' && ocrPages.length > 0 && (
            <div className="structuring-hint">
              <p>OCRデータはあります。LLM構造化を実行してください。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
