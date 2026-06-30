import { useState, useEffect, useCallback, useRef } from 'react'
import { pipeline } from '../pipeline/api'
import type { BookManifest, BookStatus, OcrPage } from '../pipeline/types'
import { structureToc } from '../ai/toc-structuring'
import { resolveIsbn, searchMonthlyAcquisitions } from '../ai/sru-client'
import type { ResolveFailReason } from '../ai/sru-client'
import { loadSruConfig, saveSruConfig, DEFAULT_SRU_CONFIG } from '../utils/sruConfig'
import type { SruConfig } from '../utils/sruConfig'
import { loadOllamaConfig, saveOllamaConfig, DEFAULT_OLLAMA_CONFIG } from '../utils/ollamaConfig'
import type { OllamaConfig } from '../utils/ollamaConfig'
import { loadOutputConfig, saveOutputConfig, DEFAULT_OUTPUT_CONFIG } from '../utils/outputConfig'
import type { OutputConfig } from '../utils/outputConfig'
import { pickFolder } from '../utils/folderPicker'
import { useOCRWorker } from '../hooks/useOCRWorker'
import { pdfToProcessedImages } from '../utils/pdfLoader'
import type { ProcessedImage } from '../types/ocr'
import { loadDocumentLanguage, getRecognitionLanguage } from '../types/model-config'

const STATUS_LABEL: Record<BookStatus, string> = {
  resolving: 'SRU解決中',
  resolve_failed: '解決失敗',
  pending: '未処理',
  ocr_done: 'OCR済',
  llm_done: 'LLM済',
  review_pending: 'レビュー待ち',
  approved: '承認済',
  exported: '出力済',
}
const STATUS_COLOR: Record<BookStatus, string> = {
  resolving: '#607d8b',
  resolve_failed: '#f44336',
  pending: '#888',
  ocr_done: '#2196f3',
  llm_done: '#9c27b0',
  review_pending: '#ff9800',
  approved: '#4caf50',
  exported: '#009688',
}

const RESOLVE_LABEL: Record<string, string> = {
  resolving: '解決中…',
  ok: '採用',
  not_found: '見つからない',
  no_toc_pdf: '目次PDFなし',
  no_holding: '所蔵なし(対象外)',
  fetch_error: '通信エラー',
  duplicate: '重複',
}
const RESOLVE_COLOR: Record<string, string> = {
  resolving: '#607d8b',
  ok: '#4caf50',
  not_found: '#f44336',
  no_toc_pdf: '#ff9800',
  no_holding: '#9e9e9e',
  fetch_error: '#f44336',
  duplicate: '#9e9e9e',
}

interface IsbnResolution {
  isbn: string
  status: 'resolving' | 'ok' | ResolveFailReason | 'duplicate'
  mmsId?: string
  title?: string | null
  detail?: string
}

interface InboxViewProps {
  onReview: (bookId: string) => void
  settingsOpen: boolean
  onSettingsClose: () => void
  hidden?: boolean
}

/** ISBNを正規化（ハイフン・空白除去） */
function normalizeIsbn(raw: string): string {
  return raw.replace(/[-\s]/g, '').trim()
}

/** CSVテキストからISBNリストを抽出 */
function parseIsbnCsv(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.split(',')[0].trim())         // 先頭列のみ
    .filter(line => line && !line.startsWith('#'))  // 空行・コメント除外
    .map(normalizeIsbn)
    .filter(s => s.length >= 10)                    // 最低10桁以上
}

export function InboxView({ onReview, settingsOpen, onSettingsClose, hidden = false }: InboxViewProps) {
  const [books, setBooks] = useState<BookManifest[]>([])
  const [inboxPdfs, setInboxPdfs] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [processingBookId, setProcessingBookId] = useState<string | null>(null)
  const [processLog, setProcessLog] = useState('')

  // 入力モード切替
  const [inputMode, setInputMode] = useState<'isbn' | 'monthly'>('isbn')

  // ISBN入力 & 解決ログ
  const [isbnInput, setIsbnInput] = useState('')
  const [resolutions, setResolutions] = useState<IsbnResolution[]>([])
  const [isResolving, setIsResolving] = useState(false)
  const csvInputRef = useRef<HTMLInputElement>(null)

  // 月次入荷検索
  const [monthlyYear, setMonthlyYear] = useState(() => new Date().getFullYear())
  const [monthlyMonth, setMonthlyMonth] = useState(() => new Date().getMonth() + 1)
  const [isMonthlySearching, setIsMonthlySearching] = useState(false)

  // パイプライン設定パネル（親のsettingsOpenで制御）
  const [sruDraft, setSruDraft] = useState<SruConfig>(loadSruConfig)
  const [ollamaDraft, setOllamaDraft] = useState<OllamaConfig>(loadOllamaConfig)
  const [outputDraft, setOutputDraft] = useState<OutputConfig>(loadOutputConfig)
  const [defaultOutputDir, setDefaultOutputDir] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)

  // 設定パネルが開かれたときに最新の設定を読み込む
  useEffect(() => {
    if (!settingsOpen) return
    setSruDraft(loadSruConfig())
    setOllamaDraft(loadOllamaConfig())
    setOutputDraft(loadOutputConfig())
    pipeline.getDefaultOutputDir().catch(() => '').then(setDefaultOutputDir)
  }, [settingsOpen])

  const { isReady, processImage, ensureLanguage } = useOCRWorker(true)

  const refresh = useCallback(async () => {
    const [b, pdfs] = await Promise.all([pipeline.listBooks(), pipeline.listInbox()])
    setBooks(b)
    setInboxPdfs(pdfs)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // ─── ISBN解決コア ────────────────────────────────────────────────────────────

  const resolveIsbnList = useCallback(async (isbnList: string[]) => {
    if (isbnList.length === 0) return
    setIsResolving(true)

    const sruConfig = loadSruConfig()
    const knownMmsIds = new Set(books.map(b => b.book_id))
    const seenInBatch = new Set<string>()

    // 解決中エントリを初期化
    setResolutions(prev => [
      ...prev,
      ...isbnList.map(isbn => ({ isbn, status: 'resolving' as const })),
    ])

    for (const isbn of isbnList) {
      const result = await resolveIsbn(isbn, sruConfig)

      if (!result.ok) {
        setResolutions(prev =>
          prev.map(r =>
            r.isbn === isbn
              ? { ...r, status: result.reason, detail: result.detail }
              : r
          )
        )
        continue
      }

      const { metadata } = result
      const { mmsId } = metadata

      // 重複チェック（既存書籍 or 今回バッチ内）
      if (knownMmsIds.has(mmsId) || seenInBatch.has(mmsId)) {
        setResolutions(prev =>
          prev.map(r =>
            r.isbn === isbn
              ? { ...r, status: 'duplicate', mmsId, title: metadata.titleOriginal ?? metadata.titleRomanized }
              : r
          )
        )
        continue
      }

      seenInBatch.add(mmsId)

      // PDFダウンロード → inbox保存 → book作成 → SRUメタデータ保存
      try {
        const pdfPath = await pipeline.downloadPdf(metadata.tocPdfUrl, `${mmsId}.pdf`)
        await pipeline.getOrCreateBook(mmsId, pdfPath)
        await pipeline.writeStage(mmsId, 'sru_meta', metadata)
        knownMmsIds.add(mmsId)

        setResolutions(prev =>
          prev.map(r =>
            r.isbn === isbn
              ? { ...r, status: 'ok', mmsId, title: metadata.titleOriginal ?? metadata.titleRomanized }
              : r
          )
        )
      } catch (e) {
        setResolutions(prev =>
          prev.map(r =>
            r.isbn === isbn
              ? { ...r, status: 'fetch_error', detail: String(e) }
              : r
          )
        )
      }
    }

    await refresh()
    setIsResolving(false)
  }, [books, refresh])

  /** 単体ISBNを追加して解決 */
  const handleIsbnAdd = useCallback(async () => {
    const isbn = normalizeIsbn(isbnInput)
    if (!isbn) return
    setIsbnInput('')
    await resolveIsbnList([isbn])
  }, [isbnInput, resolveIsbnList])

  /** CSVファイルを読み込んで一括解決 */
  const handleCsvUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const text = ev.target?.result as string
      const isbnList = parseIsbnCsv(text)
      if (isbnList.length === 0) {
        setMessage('CSVにISBNが見つかりませんでした')
        return
      }
      await resolveIsbnList(isbnList)
    }
    reader.readAsText(file)
    // inputをリセット（同一ファイルの再選択を可能にする）
    e.target.value = ''
  }, [resolveIsbnList])

  /** 月次入荷検索: SRUで年月検索 → PDF付き全件をキューに追加 */
  const handleMonthlySearch = useCallback(async () => {
    setIsMonthlySearching(true)
    setMessage('')

    const sruConfig = loadSruConfig()
    const knownMmsIds = new Set(books.map(b => b.book_id))

    let results: Awaited<ReturnType<typeof searchMonthlyAcquisitions>>
    try {
      results = await searchMonthlyAcquisitions(monthlyYear, monthlyMonth, sruConfig)
    } catch (e) {
      setMessage(`月次検索エラー: ${e}`)
      setIsMonthlySearching(false)
      return
    }

    if (results.length === 0) {
      setMessage(`${monthlyYear}年${monthlyMonth}月の入荷書籍（目次PDF付き）は見つかりませんでした`)
      setIsMonthlySearching(false)
      return
    }

    // 解決中エントリを初期化（MMS IDをラベルとして使用）
    setResolutions(prev => [
      ...prev,
      ...results.map(m => ({
        isbn: m.mmsId,
        status: 'resolving' as const,
        mmsId: m.mmsId,
        title: m.titleOriginal ?? m.titleRomanized,
      })),
    ])

    const seenInBatch = new Set<string>()

    for (const metadata of results) {
      const { mmsId } = metadata

      if (knownMmsIds.has(mmsId) || seenInBatch.has(mmsId)) {
        setResolutions(prev =>
          prev.map(r => r.isbn === mmsId ? { ...r, status: 'duplicate' } : r)
        )
        continue
      }

      seenInBatch.add(mmsId)

      try {
        const pdfPath = await pipeline.downloadPdf(metadata.tocPdfUrl, `${mmsId}.pdf`)
        await pipeline.getOrCreateBook(mmsId, pdfPath)
        await pipeline.writeStage(mmsId, 'sru_meta', metadata)
        knownMmsIds.add(mmsId)

        setResolutions(prev =>
          prev.map(r => r.isbn === mmsId ? { ...r, status: 'ok' } : r)
        )
      } catch (e) {
        setResolutions(prev =>
          prev.map(r =>
            r.isbn === mmsId ? { ...r, status: 'fetch_error', detail: String(e) } : r
          )
        )
      }
    }

    await refresh()
    setIsMonthlySearching(false)
    const added = seenInBatch.size
    const skipped = results.length - added
    setMessage(`月次検索完了: ${added}件追加${skipped > 0 ? `、${skipped}件スキップ（重複）` : ''}`)
  }, [books, monthlyYear, monthlyMonth, refresh])

  // ─── 既存機能 ────────────────────────────────────────────────────────────────

  const deleteBook = useCallback(async (bookId: string) => {
    await pipeline.deleteBook(bookId)
    await refresh()
  }, [refresh])

  const importPdfs = useCallback(async () => {
    setMessage('')
    let imported = 0
    for (const pdfPath of inboxPdfs) {
      const filename = pdfPath.split('/').pop() ?? pdfPath
      const bookId = filename.replace(/\.pdf$/i, '')
      const existing = books.find(b => b.book_id === bookId)
      if (!existing) {
        await pipeline.getOrCreateBook(bookId, pdfPath)
        imported++
      }
    }
    await refresh()
    setMessage(imported > 0 ? `${imported}冊を取り込みました` : '新しいPDFはありません')
  }, [inboxPdfs, books, refresh])

  const loadPdfFromPath = async (pdfPath: string): Promise<ProcessedImage[]> => {
    const log = (msg: string) => setProcessLog(msg)
    log('PDF読み込み中…')
    const bytes = await pipeline.readFileBytes(pdfPath)
    const uint8 = new Uint8Array(bytes)
    const blob = new Blob([uint8], { type: 'application/pdf' })
    const filename = pdfPath.split('/').pop() ?? 'book.pdf'
    const file = new File([blob], filename, { type: 'application/pdf' })
    log('PDFラスタライズ中…')
    return pdfToProcessedImages(file, 2.0, (cur, total) => log(`ページ変換 ${cur}/${total}…`))
  }

  const processBook = useCallback(async (book: BookManifest) => {
    if (!isReady && book.status !== 'ocr_done') {
      try {
        setMessage('OCRワーカーを初期化中…')
        await ensureLanguage(getRecognitionLanguage(loadDocumentLanguage()))
        setMessage('')
      } catch (e) {
        setMessage(`OCRワーカー初期化失敗: ${e}`)
        return
      }
    }
    setProcessingBookId(book.book_id)
    setProcessLog('')
    try {
      const ollamaConfig = loadOllamaConfig()
      let ocrPages: OcrPage[]

      if (book.status === 'ocr_done') {
        // OCR済み書籍: ディスクの既存OCRデータを使用してLLMのみ実行
        setProcessLog('OCRデータを読み込み中…')
        ocrPages = await pipeline.readStage<OcrPage[]>(book.book_id, 'ocr')
      } else {
        // 未処理書籍: OCR → LLM 全処理
        const images = await loadPdfFromPath(book.source_pdf)
        ocrPages = []

        for (let i = 0; i < images.length; i++) {
          setProcessLog(`OCR中… ${i + 1}/${images.length} ページ`)
          const result = await processImage(images[i], i, images.length)
          ocrPages.push({
            page_index: i,
            full_text: result.fullText,
            text_blocks: result.textBlocks.map(b => ({
              text: b.text,
              confidence: b.confidence,
              bbox: [b.x, b.y, b.x + b.width, b.y + b.height] as [number,number,number,number],
              reading_order: b.readingOrder ?? 0,
            })),
            processing_time_ms: result.processingTimeMs,
          })
        }

        await pipeline.writeStage(book.book_id, 'ocr', ocrPages)
        await pipeline.setStatus(book.book_id, 'ocr_done')
      }

      setProcessLog('LLM構造化中…')

      const { entries } = await structureToc(ocrPages, {
        model: ollamaConfig.model,
        ollamaUrl: ollamaConfig.baseUrl || undefined,
        pageImages: undefined,  // vision: OCR済みパスではPDF未ロードのため無効
      })
      await pipeline.writeStage(book.book_id, 'draft', entries)
      await pipeline.setStatus(book.book_id, 'review_pending')
      setProcessLog(`完了: ${entries.length}件のエントリを抽出`)
      await refresh()
    } catch (e) {
      setProcessLog(`エラー: ${e}`)
    } finally {
      setProcessingBookId(null)
    }
  }, [isReady, processImage, ensureLanguage, refresh])

  // ─── 表示用グループ（ワークフロー順: 取り込み済 → 処理済 → レビュー待ち → 出力済）──

  const pending = books.filter(b => b.status === 'pending')
  const ocrDone = books.filter(b => b.status === 'ocr_done')
  const reviewPending = books.filter(b => b.status === 'review_pending' || b.status === 'llm_done')
  const exported = books.filter(b => b.status === 'exported')
  const others = books.filter(b => !['pending', 'ocr_done', 'review_pending', 'llm_done', 'exported'].includes(b.status))

  return (
    <div className="inbox-view" style={hidden ? { display: 'none' } : undefined}>
      {/* ── 書籍追加パネル ── */}
      <section className="isbn-input-panel">
        <div className="inbox-mode-tabs">
          <button
            className={`inbox-mode-tab${inputMode === 'isbn' ? ' active' : ''}`}
            onClick={() => setInputMode('isbn')}
          >
            ISBN 入力
          </button>
          <button
            className={`inbox-mode-tab${inputMode === 'monthly' ? ' active' : ''}`}
            onClick={() => setInputMode('monthly')}
          >
            月次入荷検索
          </button>
        </div>

        {/* パイプライン設定パネル（AppBarの設定ボタンで開閉） */}
        {settingsOpen && (
          <div className="sru-settings-panel">
            {/* SRU設定 */}
            <div className="sru-settings-section-title">SRU設定</div>
            <div className="sru-settings-grid">
              <label className="sru-label">SRUエンドポイント</label>
              <input
                className="sru-input"
                type="url"
                value={sruDraft.sruEndpoint}
                onChange={e => setSruDraft(d => ({ ...d, sruEndpoint: e.target.value }))}
                placeholder={DEFAULT_SRU_CONFIG.sruEndpoint}
              />
              <label className="sru-label">所蔵フィルタ: フィールド ($?)</label>
              <input
                className="sru-input sru-input-short"
                value={sruDraft.holdingFilterField}
                onChange={e => setSruDraft(d => ({ ...d, holdingFilterField: e.target.value }))}
                placeholder="b"
              />
              <label className="sru-label">所蔵フィルタ: 値</label>
              <input
                className="sru-input sru-input-short"
                value={sruDraft.holdingFilterValue}
                onChange={e => setSruDraft(d => ({ ...d, holdingFilterValue: e.target.value }))}
                placeholder="UAOI"
              />
              <label className="sru-label">ソースラベル</label>
              <input
                className="sru-input sru-input-short"
                value={sruDraft.sourceLabel}
                onChange={e => setSruDraft(d => ({ ...d, sourceLabel: e.target.value }))}
                placeholder="SLSP/UZB"
              />
              <label className="sru-label">月次検索フィールド番号</label>
              <input
                className="sru-input sru-input-short"
                value={sruDraft.monthlySearchField}
                onChange={e => setSruDraft(d => ({ ...d, monthlySearchField: e.target.value }))}
                placeholder="990"
              />
              <label className="sru-label">月次検索プレフィックス</label>
              <input
                className="sru-input sru-input-short"
                value={sruDraft.monthlySearchPrefix}
                onChange={e => setSruDraft(d => ({ ...d, monthlySearchPrefix: e.target.value }))}
                placeholder="例: UAOIJ-"
              />
            </div>

            {/* Ollama設定 */}
            <div className="sru-settings-divider" />
            <div className="sru-settings-section-title">Ollama設定</div>
            <div className="sru-settings-grid">
              <label className="sru-label">構造化LLMモデル</label>
              <input
                className="sru-input"
                value={ollamaDraft.model}
                onChange={e => setOllamaDraft(d => ({ ...d, model: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.model}
              />
              <label className="sru-label">埋め込みモデル</label>
              <input
                className="sru-input"
                value={ollamaDraft.embedModel}
                onChange={e => setOllamaDraft(d => ({ ...d, embedModel: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.embedModel}
              />
              <label className="sru-label">Ollama URL</label>
              <input
                className="sru-input"
                type="url"
                value={ollamaDraft.baseUrl}
                onChange={e => setOllamaDraft(d => ({ ...d, baseUrl: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.baseUrl}
              />
              <label className="sru-label">ビジョンOCRチェック</label>
              <label className="sru-checkbox-label">
                <input
                  type="checkbox"
                  checked={ollamaDraft.useVision}
                  onChange={e => setOllamaDraft(d => ({ ...d, useVision: e.target.checked }))}
                />
                ページ画像をLLMに送って誤字修正（ビジョン対応モデルのみ）
              </label>
            </div>

            {/* 出力設定 */}
            <div className="sru-settings-divider" />
            <div className="sru-settings-section-title">出力設定</div>
            <div className="sru-settings-grid">
              <label className="sru-label">出力ディレクトリ</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="sru-input"
                    type="text"
                    value={outputDraft.outputDir}
                    onChange={e => setOutputDraft(d => ({ ...d, outputDir: e.target.value }))}
                    placeholder={defaultOutputDir || '（デフォルト）'}
                    style={{ flex: 1, minWidth: 0 }}
                    readOnly
                  />
                  <button
                    className="btn-secondary"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={async () => {
                      const picked = await pickFolder()
                      if (picked) setOutputDraft(d => ({ ...d, outputDir: picked }))
                    }}
                  >
                    フォルダ選択…
                  </button>
                  {outputDraft.outputDir && (
                    <button
                      className="btn-secondary"
                      title="デフォルトに戻す"
                      onClick={() => setOutputDraft(d => ({ ...d, outputDir: '' }))}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <span className="sru-label" style={{ fontSize: '0.75rem' }}>
                  空欄 = デフォルト: {defaultOutputDir || '（取得中…）'}
                </span>
              </div>
            </div>

            <div className="sru-settings-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setSruDraft({ ...DEFAULT_SRU_CONFIG })
                  setOllamaDraft({ ...DEFAULT_OLLAMA_CONFIG })
                  setOutputDraft({ ...DEFAULT_OUTPUT_CONFIG })
                }}
              >
                デフォルトに戻す
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  saveSruConfig(sruDraft)
                  saveOllamaConfig(ollamaDraft)
                  saveOutputConfig(outputDraft)
                  setSettingsSaved(true)
                  setTimeout(() => { setSettingsSaved(false); onSettingsClose() }, 1000)
                }}
              >
                {settingsSaved ? '✓ 保存済み' : '保存'}
              </button>
              <button className="btn-secondary" onClick={onSettingsClose}>
                閉じる
              </button>
            </div>
          </div>
        )}

        {inputMode === 'isbn' && (
          <>
            <div className="isbn-input-row">
              <input
                className="isbn-input"
                type="text"
                placeholder="ISBN-13 または ISBN-10"
                value={isbnInput}
                onChange={e => setIsbnInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleIsbnAdd() }}
                disabled={isResolving}
              />
              <button
                className="btn-primary"
                onClick={handleIsbnAdd}
                disabled={!isbnInput.trim() || isResolving}
              >
                追加
              </button>
              <button
                className="btn-secondary"
                onClick={() => csvInputRef.current?.click()}
                disabled={isResolving}
              >
                CSV一括
              </button>
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,.txt"
                style={{ display: 'none' }}
                onChange={handleCsvUpload}
              />
              {isResolving && <span className="resolving-indicator">解決中…</span>}
            </div>
            <p className="isbn-hint">CSVは1行1ISBN形式（ハイフン有無どちらでも可）</p>
          </>
        )}

        {inputMode === 'monthly' && (
          <div className="monthly-search-panel">
            <div className="monthly-search-row">
              <label className="monthly-search-label">年</label>
              <select
                className="monthly-search-select"
                value={monthlyYear}
                onChange={e => setMonthlyYear(Number(e.target.value))}
                disabled={isMonthlySearching}
              >
                {[new Date().getFullYear() - 2, new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <label className="monthly-search-label">月</label>
              <select
                className="monthly-search-select"
                value={monthlyMonth}
                onChange={e => setMonthlyMonth(Number(e.target.value))}
                disabled={isMonthlySearching}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <button
                className="btn-primary"
                onClick={handleMonthlySearch}
                disabled={isMonthlySearching}
              >
                {isMonthlySearching ? '検索中…' : '検索して全件追加'}
              </button>
              {isMonthlySearching && <span className="resolving-indicator">取得中…</span>}
            </div>
            <p className="isbn-hint">目次PDFがある書籍のみキューに追加されます</p>
          </div>
        )}

        {/* 解決ログ */}
        {resolutions.length > 0 && (
          <div className="resolution-log">
            <div className="resolution-log-header">
              <span>解決ログ ({resolutions.length}件)</span>
              <button
                className="btn-tiny"
                onClick={() => setResolutions([])}
                disabled={isResolving}
              >
                クリア
              </button>
            </div>
            <table className="resolution-table">
              <thead>
                <tr>
                  <th>ISBN</th>
                  <th>状態</th>
                  <th>タイトル / 詳細</th>
                </tr>
              </thead>
              <tbody>
                {resolutions.map((r, i) => (
                  <tr key={i}>
                    <td className="resolution-isbn">{r.isbn}</td>
                    <td>
                      <span
                        className="status-badge"
                        style={{ background: RESOLVE_COLOR[r.status] ?? '#888' }}
                      >
                        {RESOLVE_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="resolution-title">
                      {r.title ?? r.detail ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 既存ヘッダー ── */}
      <div className="inbox-header">
        <h2>処理キュー</h2>
        <div className="inbox-actions">
          <span className="inbox-count">inbox: {inboxPdfs.length}冊のPDF</span>
          <button onClick={importPdfs} disabled={inboxPdfs.length === 0} className="btn-secondary">
            取り込む
          </button>
          <button onClick={refresh} className="btn-secondary">更新</button>
        </div>
        {message && <p className="inbox-message">{message}</p>}
        {processingBookId && (
          <div className="process-log-bar">
            <span className="spinner">⟳</span> <strong>{processingBookId}</strong>: {processLog}
          </div>
        )}
      </div>

      {/* ── 取り込み済み・未処理 ── */}
      {pending.length > 0 && (
        <section className="inbox-section">
          <h3>取り込み済み・未処理 ({pending.length})</h3>
          <div className="book-list">
            {pending.map(book => (
              <BookCard
                key={book.book_id} book={book}
                onReview={onReview}
                onProcess={processBook}
                onDelete={deleteBook}
                isProcessing={processingBookId === book.book_id}
                isReady={true}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── OCR済み・LLM待ち ── */}
      {ocrDone.length > 0 && (
        <section className="inbox-section">
          <h3>OCR済み・LLM待ち ({ocrDone.length})</h3>
          <div className="book-list">
            {ocrDone.map(book => (
              <BookCard
                key={book.book_id} book={book}
                onReview={onReview}
                onProcess={processBook}
                onDelete={deleteBook}
                isProcessing={processingBookId === book.book_id}
                isReady={true}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── レビュー待ち ── */}
      {reviewPending.length > 0 && (
        <section className="inbox-section">
          <h3>レビュー待ち ({reviewPending.length})</h3>
          <div className="book-list">
            {reviewPending.map(book => (
              <BookCard
                key={book.book_id} book={book}
                onReview={onReview}
                onProcess={processBook}
                onDelete={deleteBook}
                isProcessing={processingBookId === book.book_id}
                isReady={true}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 出力済み（再出力可） ── */}
      {exported.length > 0 && (
        <section className="inbox-section">
          <h3>出力済み — 再出力可 ({exported.length})</h3>
          <div className="book-list">
            {exported.map(book => (
              <BookCard
                key={book.book_id} book={book}
                onReview={onReview}
                onProcess={processBook}
                onDelete={deleteBook}
                isProcessing={processingBookId === book.book_id}
                isReady={true}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── その他（エラー・解決失敗等） ── */}
      {others.length > 0 && (
        <section className="inbox-section">
          <h3>その他 ({others.length})</h3>
          <div className="book-list">
            {others.map(book => (
              <BookCard
                key={book.book_id} book={book}
                onReview={onReview}
                onProcess={processBook}
                onDelete={deleteBook}
                isProcessing={processingBookId === book.book_id}
                isReady={true}
              />
            ))}
          </div>
        </section>
      )}

      {books.length === 0 && !processingBookId && (
        <div className="inbox-empty">
          <p>書籍がありません。上のISBN入力から追加してください。</p>
          <p className="inbox-data-path-hint">
            データパス: <code>~/Library/Application Support/com.nobu.ndltococr/data/</code>
          </p>
        </div>
      )}
    </div>
  )
}

function BookCard({
  book, onReview, onProcess, onDelete, isProcessing, isReady,
}: {
  book: BookManifest
  onReview: (id: string) => void
  onProcess: (book: BookManifest) => void
  onDelete: (bookId: string) => void
  isProcessing: boolean
  isReady: boolean
}) {
  const canProcess = (book.status === 'pending' || book.status === 'ocr_done') && isReady && !isProcessing
  const canReview = (book.status === 'review_pending' || book.status === 'llm_done' || book.status === 'exported') && !isProcessing

  return (
    <div className={`book-card ${isProcessing ? 'book-card-processing' : ''}`}>
      <div className="book-card-title" title={book.source_pdf}>{book.book_id}</div>
      <div className="book-card-meta">
        <span className="status-badge" style={{ background: STATUS_COLOR[book.status] }}>
          {STATUS_LABEL[book.status]}
        </span>
        {book.page_count && <span className="book-pages">{book.page_count}p</span>}
        {book.resolve_fail_reason && (
          <span className="resolve-fail-reason" title={book.resolve_fail_reason}>
            ({book.resolve_fail_reason})
          </span>
        )}
      </div>
      <div className="book-card-actions">
        {canProcess && (
          <button className="btn-process" onClick={() => onProcess(book)}>
            {book.status === 'ocr_done' ? 'LLM構造化' : 'OCR → LLM処理'}
          </button>
        )}
        {canReview && (
          <button className="btn-review" onClick={() => onReview(book.book_id)}>
            レビュー →
          </button>
        )}
        {isProcessing && <span className="processing-indicator">処理中…</span>}
        {!isProcessing && (
          <button
            className="btn-delete-book"
            title="キューから削除"
            onClick={() => {
              if (window.confirm(`「${book.book_id}」をキューから削除しますか？`)) {
                onDelete(book.book_id)
              }
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
