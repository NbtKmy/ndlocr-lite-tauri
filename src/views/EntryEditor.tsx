import { useState, useEffect, useCallback } from 'react'
import type { ReviewedEntry } from '../pipeline/types'

interface EntryEditorProps {
  entries: ReviewedEntry[]
  onChange: (entries: ReviewedEntry[]) => void
  /** 現在表示中のPDFページインデックス（source_page_index と照合してフィルタ） */
  filterPageIdx?: number
}

const LEVEL_LABELS: Record<number, string> = { 1: '部', 2: '章', 3: '節', 4: '項' }
const LEVEL_PREFIX: Record<number, string> = { 1: '#', 2: '##', 3: '###', 4: '####' }

// ── Markdown変換 ────────────────────────────────────────────────────────────

function entriesToMarkdown(entries: ReviewedEntry[]): string {
  return entries
    .map(e => `${LEVEL_PREFIX[e.level] ?? '##'} ${e.heading_text}`)
    .join('\n')
}

function markdownToEntries(md: string, prevEntries: ReviewedEntry[]): ReviewedEntry[] {
  const lines = md.split('\n').filter(l => l.trim())
  const maxSeq = Math.max(0, ...prevEntries.map(e => e.seq))

  return lines.map((line, i) => {
    const match = line.match(/^(#{1,4})\s+(.*)/)
    const level = match ? Math.min(match[1].length, 4) : 2
    const heading_text = match ? match[2].trim() : line.trim()
    const prev = prevEntries[i]
    return {
      seq: prev?.seq ?? maxSeq + i + 1,
      level,
      heading_text,
      page_number: prev?.page_number ?? null,
      contributor: prev?.contributor ?? null,
      raw_ocr_text: prev?.raw_ocr_text ?? '',
      source_page_index: prev?.source_page_index ?? 0,
      confidence: prev?.confidence ?? 1.0,
      reviewed: false,
      edited: true,
    }
  })
}

// ── コンポーネント ───────────────────────────────────────────────────────────

export function EntryEditor({ entries, onChange, filterPageIdx }: EntryEditorProps) {
  const [editingSeq, setEditingSeq] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'markdown'>('table')
  const [markdownText, setMarkdownText] = useState('')
  const [showAllPages, setShowAllPages] = useState(false)

  // ページが切り替わったらフィルタをリセット・編集中もキャンセル
  useEffect(() => {
    setShowAllPages(false)
    setEditingSeq(null)
  }, [filterPageIdx])

  // フィルタリング
  const pageEntries = filterPageIdx !== undefined
    ? entries.filter(e => e.source_page_index === filterPageIdx)
    : entries
  const visibleEntries = (filterPageIdx !== undefined && !showAllPages) ? pageEntries : entries
  const hasFilter = filterPageIdx !== undefined

  const update = (seq: number, patch: Partial<ReviewedEntry>) => {
    onChange(entries.map(e => e.seq === seq ? { ...e, ...patch, edited: true } : e))
  }

  const remove = (seq: number) => {
    onChange(entries.filter(e => e.seq !== seq))
  }

  const addEntry = () => {
    const maxSeq = entries.reduce((m, e) => Math.max(m, e.seq), 0)
    const newEntry: ReviewedEntry = {
      seq: maxSeq + 1,
      level: 2,
      heading_text: '',
      page_number: null,
      contributor: null,
      raw_ocr_text: '',
      source_page_index: filterPageIdx ?? 0,
      confidence: 1.0,
      reviewed: true,
      edited: true,
    }
    onChange([...entries, newEntry])
    setEditingSeq(newEntry.seq)
  }

  const enterMarkdown = useCallback(() => {
    setMarkdownText(entriesToMarkdown(entries))
    setEditingSeq(null)
    setViewMode('markdown')
  }, [entries])

  const exitMarkdown = useCallback(() => {
    const updated = markdownToEntries(markdownText, entries)
    onChange(updated)
    setViewMode('table')
  }, [markdownText, entries, onChange])

  // Enter → 次の行へ / Escape → 編集キャンセル
  const handleEditKeyDown = useCallback((e: React.KeyboardEvent, seq: number) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault()
      const idx = visibleEntries.findIndex(en => en.seq === seq)
      if (idx < visibleEntries.length - 1) {
        setEditingSeq(visibleEntries[idx + 1].seq)
      } else {
        setEditingSeq(null)
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setEditingSeq(null)
    }
  }, [visibleEntries])

  return (
    <div className="entry-editor">
      <div className="entry-editor-header">
        {/* ページフィルタ表示 */}
        <div className="entry-editor-filter">
          <span>目次エントリ ({entries.length}件)</span>
          {hasFilter && (
            <button
              className={`btn-small ${!showAllPages ? 'btn-page-filter-active' : ''}`}
              onClick={() => setShowAllPages(v => !v)}
              title={showAllPages ? 'このページに絞り込む' : '全エントリを表示'}
            >
              {showAllPages
                ? `全件表示中`
                : `p.${(filterPageIdx ?? 0) + 1}: ${pageEntries.length}件`}
            </button>
          )}
        </div>

        <div className="entry-editor-controls">
          {viewMode === 'table' ? (
            <>
              <button className="btn-small" onClick={addEntry}>＋ 追加</button>
              <button className="btn-small btn-md-toggle" onClick={enterMarkdown} title="Markdown形式で階層を編集">
                Markdown編集
              </button>
            </>
          ) : (
            <button className="btn-small btn-md-toggle btn-md-active" onClick={exitMarkdown}>
              ✓ テーブルに戻る
            </button>
          )}
        </div>
      </div>

      {viewMode === 'markdown' ? (
        <div className="markdown-editor-wrap">
          <p className="markdown-editor-hint">
            <code>#</code>=部　<code>##</code>=章　<code>###</code>=節　<code>####</code>=項
            ／ページ・著者はテーブルで管理します
          </p>
          <textarea
            className="markdown-editor"
            value={markdownText}
            onChange={e => setMarkdownText(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      ) : (
        <div className="entry-table">
          <div className="entry-row entry-row-header">
            <span className="col-level">階層</span>
            <span className="col-heading">見出し</span>
            <span className="col-page">ページ</span>
            <span className="col-contributor">著者</span>
            <span className="col-actions"></span>
          </div>

          {visibleEntries.length === 0 && (
            <div className="entry-empty">
              {hasFilter && !showAllPages
                ? 'このページのエントリはありません'
                : 'エントリがありません'}
            </div>
          )}

          {visibleEntries.map(entry => {
            const ocrChanged = entry.raw_ocr_text !== '' && entry.raw_ocr_text !== entry.heading_text

            return editingSeq === entry.seq ? (
              // ── 編集行 ──────────────────────────────────────────────────────
              <div key={entry.seq} className="entry-row entry-row-editing" onKeyDown={e => handleEditKeyDown(e, entry.seq)}>
                <select
                  className="col-level"
                  value={entry.level}
                  onChange={e => update(entry.seq, { level: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4].map(l => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                </select>
                <div className="col-heading col-heading-edit">
                  <input
                    value={entry.heading_text}
                    onChange={e => update(entry.seq, { heading_text: e.target.value })}
                    autoFocus
                    title="Enter で次の行へ / Escape でキャンセル"
                  />
                  {ocrChanged && (
                    <span className="entry-ocr-ref">OCR原文: {entry.raw_ocr_text}</span>
                  )}
                </div>
                <input
                  className="col-page"
                  type="number"
                  value={entry.page_number ?? ''}
                  onChange={e => update(entry.seq, { page_number: e.target.value ? Number(e.target.value) : null })}
                />
                <input
                  className="col-contributor"
                  value={entry.contributor ?? ''}
                  onChange={e => update(entry.seq, { contributor: e.target.value || null })}
                />
                <div className="col-actions">
                  <button className="btn-small btn-done" onClick={() => setEditingSeq(null)}>✓</button>
                  <button className="btn-small btn-delete" onClick={() => { remove(entry.seq); setEditingSeq(null) }}>✕</button>
                </div>
              </div>
            ) : (
              // ── 表示行 ──────────────────────────────────────────────────────
              <div
                key={entry.seq}
                className={`entry-row entry-row-level-${entry.level} ${entry.edited ? 'edited' : ''}`}
                onClick={() => setEditingSeq(entry.seq)}
                title="クリックして編集 / Enter で次へ / Escape でキャンセル"
              >
                <span className="col-level level-badge">{LEVEL_LABELS[entry.level] ?? entry.level}</span>
                <span className="col-heading" style={{ paddingLeft: `${(entry.level - 1) * 16}px` }}>
                  {entry.heading_text || <em style={{ opacity: 0.4 }}>（空）</em>}
                  {entry.edited && <span className="edited-mark" title="手修正済み"> ✏</span>}
                  {ocrChanged && (
                    <span className="ocr-changed-mark" title={`OCR原文: ${entry.raw_ocr_text}`}> ~</span>
                  )}
                </span>
                <span className="col-page">{entry.page_number ?? '―'}</span>
                <span className="col-contributor">{entry.contributor ?? ''}</span>
                <div className="col-actions">
                  <span
                    className="conf-dot"
                    style={{ opacity: entry.confidence }}
                    title={`信頼度 ${Math.round(entry.confidence * 100)}%`}
                  >●</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
