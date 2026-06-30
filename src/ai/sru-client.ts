/**
 * 図書館SRUクライアント
 * ISBN → SRU(MARC-XML) → メタデータ + 目次PDF URL + 所蔵情報の解決
 * DESIGN.md §3 の解決フロー（①ヒット→②856→③AVA）を実装
 */
import { pipeline } from '../pipeline/api'
import type { SruConfig } from '../utils/sruConfig'

export type ResolveFailReason =
  | 'fetch_error'
  | 'not_found'
  | 'no_toc_pdf'
  | 'no_holding'

export interface SruMetadata {
  mmsId: string
  isbn: string[]
  titleOriginal: string | null
  titleRomanized: string | null
  subtitle: string | null
  creatorOriginal: string | null
  creatorRomanized: string | null
  publisher: string | null
  pubPlace: string | null
  pubYear: string | null
  subjects: string[]
  classification: string[]
  tocPdfUrl: string
  callNumber: string | null
  location: string | null
  holdingLibrary: string | null
  holdingStatus: string | null
  source: string
}

export type SruResult =
  | { ok: true; metadata: SruMetadata }
  | { ok: false; reason: ResolveFailReason; detail?: string }

/** ハイフン・空白除去、末尾の修飾語（括弧内等）を除く */
function cleanIsbn(raw: string): string {
  return raw.split(/[\s(]/)[0].replace(/-/g, '').trim()
}

export async function resolveIsbn(isbn: string, config: SruConfig): Promise<SruResult> {
  const normalizedIsbn = cleanIsbn(isbn)

  // SRU検索URL
  const url =
    `${config.sruEndpoint}?version=1.2&operation=searchRetrieve` +
    `&recordSchema=marcxml&query=alma.isbn=${encodeURIComponent(normalizedIsbn)}`

  // ① Rustコマンド経由でフェッチ（CORS回避）
  let xmlText: string
  try {
    xmlText = await pipeline.httpGet(url)
  } catch (e) {
    return { ok: false, reason: 'fetch_error', detail: String(e) }
  }

  // MARC-XMLパース
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')

  // ① ヒット確認
  const records = Array.from(doc.querySelectorAll('record'))
  if (records.length === 0) {
    return { ok: false, reason: 'not_found' }
  }

  // 複数レコード時は先頭を採用（ISBNが複数エディションにヒットするケース）
  if (records.length > 1) {
    console.warn(`[SRU] ${normalizedIsbn}: ${records.length} records found, using first.`)
  }
  const record = records[0]

  // ─── ヘルパー ───────────────────────────────────────────────────────────────

  /** タグ・サブフィールドコードで全テキストを取得 */
  const getSubfields = (tag: string, ...codes: string[]): string[] => {
    const results: string[] = []
    record.querySelectorAll(`datafield[tag="${tag}"]`).forEach((df) => {
      codes.forEach((code) => {
        df.querySelectorAll(`subfield[code="${code}"]`).forEach((sf) => {
          const t = sf.textContent?.trim()
          if (t) results.push(t)
        })
      })
    })
    return results
  }

  const getSubfield = (tag: string, code: string): string | null =>
    getSubfields(tag, code)[0] ?? null

  // 880リンクマップ構築: "245-01" → 880 Element
  // 880の$6は "245-01" または "245-01/Jpan" 形式（スクリプトコードが付く場合がある）
  // スクリプトコード（"/Jpan" 等）を除去してキーとして登録する
  const link880Map = new Map<string, Element>()
  record.querySelectorAll('datafield[tag="880"]').forEach((df) => {
    const ref = df.querySelector('subfield[code="6"]')?.textContent?.trim()
    if (ref) link880Map.set(ref.split('/')[0], df)
  })

  /** タグフィールドの$6からオカレンス番号を取得し、対応する880の指定サブフィールドを返す */
  const get880ForElement = (dfEl: Element, tag: string, code: string): string | null => {
    const linkVal = dfEl.querySelector('subfield[code="6"]')?.textContent?.trim()
    if (!linkVal) return null
    const occNum = linkVal.split('-')[1] // "880-01" → "01"
    const df880 = link880Map.get(`${tag}-${occNum}`)
    return df880?.querySelector(`subfield[code="${code}"]`)?.textContent?.trim() ?? null
  }

  /** タグの最初のdatafieldの880を取得（単一著者・タイトル用） */
  const get880 = (tag: string, code: string): string | null => {
    const dfEl = record.querySelector(`datafield[tag="${tag}"]`)
    if (!dfEl) return null
    return get880ForElement(dfEl, tag, code)
  }

  // ─── ② 856: 目次PDF選別 ───────────────────────────────────────────────────

  let tocPdfUrl: string | null = null
  record.querySelectorAll('datafield[tag="856"]').forEach((df) => {
    if (tocPdfUrl) return
    const s3 = df.querySelector('subfield[code="3"]')?.textContent ?? ''
    const sq = df.querySelector('subfield[code="q"]')?.textContent ?? ''
    if (s3.includes('Inhaltsverzeichnis') && sq.toUpperCase() === 'PDF') {
      tocPdfUrl = df.querySelector('subfield[code="u"]')?.textContent?.trim() ?? null
    }
  })
  if (!tocPdfUrl) {
    return { ok: false, reason: 'no_toc_pdf' }
  }

  // ─── ③ AVA: 所蔵チェック ──────────────────────────────────────────────────

  let mmsId: string | null = null
  let callNumber: string | null = null
  let location: string | null = null
  let holdingLibrary: string | null = null
  let holdingStatus: string | null = null

  record.querySelectorAll('datafield[tag="AVA"]').forEach((df) => {
    if (mmsId) return
    const filterVal = df.querySelector(
      `subfield[code="${config.holdingFilterField}"]`
    )?.textContent?.trim()
    if (filterVal === config.holdingFilterValue) {
      mmsId = df.querySelector('subfield[code="0"]')?.textContent?.trim() ?? null
      callNumber = df.querySelector('subfield[code="d"]')?.textContent?.trim() ?? null
      location = df.querySelector('subfield[code="c"]')?.textContent?.trim() ?? null
      holdingLibrary = df.querySelector('subfield[code="q"]')?.textContent?.trim() ?? null
      holdingStatus = df.querySelector('subfield[code="e"]')?.textContent?.trim() ?? null
    }
  })
  if (!mmsId) {
    return { ok: false, reason: 'no_holding' }
  }

  // ─── メタデータ収集 ───────────────────────────────────────────────────────

  // タイトル
  const titleRomanized =
    [getSubfield('245', 'a'), getSubfield('245', 'b')]
      .filter(Boolean)
      .join(' ')
      .trim() || null
  const titleOriginal = get880('245', 'a')
  const subtitle = get880('245', 'b') ?? getSubfield('245', 'b') ?? null

  // 著者: 100（主著者）→ 700（付加著者）の順で1件取得
  const creator100El = record.querySelector('datafield[tag="100"]')
  const creator700El = record.querySelector('datafield[tag="700"]')
  const creatorEl = creator100El ?? creator700El
  const creatorTag = creatorEl === creator100El ? '100' : '700'
  const creatorRomanized =
    creatorEl?.querySelector('subfield[code="a"]')?.textContent?.trim() ?? null
  const creatorOriginal = creatorEl
    ? get880ForElement(creatorEl, creatorTag, 'a')
    : null

  // 出版情報: 264 優先、なければ 260
  const hasPub264 = !!getSubfield('264', 'b')
  const pubTag = hasPub264 ? '264' : '260'
  const publisher = getSubfield(pubTag, 'b')
  const pubPlace = getSubfield(pubTag, 'a')
  const pubYear = getSubfield(pubTag, 'c')

  // ISBN: 020 $a 全件（正規化済み）
  const isbnList = getSubfields('020', 'a')
    .map(cleanIsbn)
    .filter((s) => s.length > 0)

  // サブジェクト: 6XX全ブロック（原表記優先）
  const SUBJECT_TAGS = ['600','610','611','630','647','648','650','651','653','655']
  const subjects: string[] = []
  SUBJECT_TAGS.forEach((tag) => {
    record.querySelectorAll(`datafield[tag="${tag}"]`).forEach((df) => {
      // 880原表記を優先、なければ翻字テキスト
      const original = get880ForElement(df, tag, 'a')
      const text = original ?? df.querySelector('subfield[code="a"]')?.textContent?.trim()
      if (text && !subjects.includes(text)) subjects.push(text)
    })
  })

  // 分類: 084/082/050
  const classification: string[] = []
  ;['084', '082', '050'].forEach((tag) => {
    const val = getSubfield(tag, 'a')
    if (val && !classification.includes(val)) classification.push(val)
  })

  return {
    ok: true,
    metadata: {
      mmsId,
      isbn: isbnList,
      titleOriginal,
      titleRomanized,
      subtitle,
      creatorOriginal,
      creatorRomanized,
      publisher,
      pubPlace,
      pubYear,
      subjects,
      classification,
      tocPdfUrl,
      callNumber,
      location,
      holdingLibrary,
      holdingStatus,
      source: config.sourceLabel,
    },
  }
}

/**
 * 月次入荷検索: ローカルフィールドで年月を検索し、目次PDFを持つ全レコードを返す
 * クエリ例: alma.local_field_990=UAOIJ-202605*
 */
export async function searchMonthlyAcquisitions(
  year: number,
  month: number,
  config: SruConfig
): Promise<SruMetadata[]> {
  const mm = String(month).padStart(2, '0')
  const query = `alma.local_field_${config.monthlySearchField} all ${config.monthlySearchPrefix}${year}${mm}*`
  const url =
    `${config.sruEndpoint}?version=1.2&operation=searchRetrieve` +
    `&recordSchema=marcxml&maximumRecords=100&query=${encodeURIComponent(query)}`

  let xmlText: string
  try {
    xmlText = await pipeline.httpGet(url)
  } catch (e) {
    throw new Error(`SRU月次検索フェッチ失敗: ${e}`)
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')
  const records = Array.from(doc.querySelectorAll('record'))

  const results: SruMetadata[] = []
  const seenMmsIds = new Set<string>()

  for (const record of records) {
    // ─── ヘルパー（レコードスコープ）────────────────────────────────────────
    const getSubfields = (tag: string, ...codes: string[]): string[] => {
      const out: string[] = []
      record.querySelectorAll(`datafield[tag="${tag}"]`).forEach((df) => {
        codes.forEach((code) => {
          df.querySelectorAll(`subfield[code="${code}"]`).forEach((sf) => {
            const t = sf.textContent?.trim()
            if (t) out.push(t)
          })
        })
      })
      return out
    }
    const getSubfield = (tag: string, code: string) => getSubfields(tag, code)[0] ?? null

    const link880Map = new Map<string, Element>()
    record.querySelectorAll('datafield[tag="880"]').forEach((df) => {
      const ref = df.querySelector('subfield[code="6"]')?.textContent?.trim()
      if (ref) link880Map.set(ref.split('/')[0], df)
    })
    const get880ForElement = (dfEl: Element, tag: string, code: string): string | null => {
      const linkVal = dfEl.querySelector('subfield[code="6"]')?.textContent?.trim()
      if (!linkVal) return null
      const occNum = linkVal.split('-')[1]
      const df880 = link880Map.get(`${tag}-${occNum}`)
      return df880?.querySelector(`subfield[code="${code}"]`)?.textContent?.trim() ?? null
    }
    const get880 = (tag: string, code: string): string | null => {
      const dfEl = record.querySelector(`datafield[tag="${tag}"]`)
      if (!dfEl) return null
      return get880ForElement(dfEl, tag, code)
    }

    // ─── 856: 目次PDF確認 ────────────────────────────────────────────────────
    let tocPdfUrl: string | null = null
    record.querySelectorAll('datafield[tag="856"]').forEach((df) => {
      if (tocPdfUrl) return
      const s3 = df.querySelector('subfield[code="3"]')?.textContent ?? ''
      const sq = df.querySelector('subfield[code="q"]')?.textContent ?? ''
      if (s3.includes('Inhaltsverzeichnis') && sq.toUpperCase() === 'PDF') {
        tocPdfUrl = df.querySelector('subfield[code="u"]')?.textContent?.trim() ?? null
      }
    })
    if (!tocPdfUrl) continue

    // ─── MMS ID取得: 任意のAVA $0 → controlfield 001 にフォールバック ────────
    let mmsId: string | null = null
    let callNumber: string | null = null
    let location: string | null = null
    let holdingLibrary: string | null = null
    let holdingStatus: string | null = null

    record.querySelectorAll('datafield[tag="AVA"]').forEach((df) => {
      if (mmsId) return
      const id = df.querySelector('subfield[code="0"]')?.textContent?.trim()
      if (id) {
        mmsId = id
        callNumber = df.querySelector('subfield[code="d"]')?.textContent?.trim() ?? null
        location = df.querySelector('subfield[code="c"]')?.textContent?.trim() ?? null
        holdingLibrary = df.querySelector('subfield[code="q"]')?.textContent?.trim() ?? null
        holdingStatus = df.querySelector('subfield[code="e"]')?.textContent?.trim() ?? null
      }
    })
    if (!mmsId) {
      mmsId = record.querySelector('controlfield[tag="001"]')?.textContent?.trim() ?? null
    }
    if (!mmsId) continue
    if (seenMmsIds.has(mmsId)) continue
    seenMmsIds.add(mmsId)

    // ─── メタデータ収集 ──────────────────────────────────────────────────────
    const titleRomanized =
      [getSubfield('245', 'a'), getSubfield('245', 'b')].filter(Boolean).join(' ').trim() || null
    const titleOriginal = get880('245', 'a')
    const subtitle = get880('245', 'b') ?? getSubfield('245', 'b') ?? null

    const creator100El = record.querySelector('datafield[tag="100"]')
    const creator700El = record.querySelector('datafield[tag="700"]')
    const creatorEl = creator100El ?? creator700El
    const creatorTag = creatorEl === creator100El ? '100' : '700'
    const creatorRomanized = creatorEl?.querySelector('subfield[code="a"]')?.textContent?.trim() ?? null
    const creatorOriginal = creatorEl ? get880ForElement(creatorEl, creatorTag, 'a') : null

    const hasPub264 = !!getSubfield('264', 'b')
    const pubTag = hasPub264 ? '264' : '260'

    const isbnList = getSubfields('020', 'a')
      .map(s => s.split(/[\s(]/)[0].replace(/-/g, '').trim())
      .filter(s => s.length > 0)

    const SUBJECT_TAGS = ['600','610','611','630','647','648','650','651','653','655']
    const subjects: string[] = []
    SUBJECT_TAGS.forEach((tag) => {
      record.querySelectorAll(`datafield[tag="${tag}"]`).forEach((df) => {
        const original = get880ForElement(df, tag, 'a')
        const text = original ?? df.querySelector('subfield[code="a"]')?.textContent?.trim()
        if (text && !subjects.includes(text)) subjects.push(text)
      })
    })

    const classification: string[] = []
    ;['084', '082', '050'].forEach((tag) => {
      const val = getSubfield(tag, 'a')
      if (val && !classification.includes(val)) classification.push(val)
    })

    results.push({
      mmsId,
      isbn: isbnList,
      titleOriginal,
      titleRomanized,
      subtitle,
      creatorOriginal,
      creatorRomanized,
      publisher: getSubfield(pubTag, 'b'),
      pubPlace: getSubfield(pubTag, 'a'),
      pubYear: getSubfield(pubTag, 'c'),
      subjects,
      classification,
      tocPdfUrl,
      callNumber,
      location,
      holdingLibrary,
      holdingStatus,
      source: config.sourceLabel,
    })
  }

  return results
}
