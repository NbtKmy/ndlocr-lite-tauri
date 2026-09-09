/**
 * CiNii Books OpenSearch API クライアント
 * ISBN から CiNii Books ID（NCID）を解決する
 * HTTP は Rust の http_get 経由（ブラウザ直接だと CORS で失敗するため、SRU クライアントと同方式）
 */
import { pipeline } from '../pipeline/api'
import { cleanIsbn } from './sru-client'

const ENDPOINT = 'https://ci.nii.ac.jp/books/opensearch/search'

export interface CiniiLookup {
  /** 採用した NCID。見つからなければ null */
  ncid: string | null
  /** 採用した候補の totalResults。照会に至らなかった場合は 0 */
  hits: number
  /**
   * 照会した正規化済み ISBN。
   * ヒット時は採用した候補、非ヒット時は最後に照会した候補。有効候補がなければ null
   */
  queriedIsbn: string | null
  /** 全候補で通信・解析が失敗した場合のみ設定 */
  error?: string
}

/** ISBN-10（末尾 X 可）または ISBN-13 の形式か */
function isValidIsbn(s: string): boolean {
  return /^[0-9]{9}[0-9X]$/.test(s) || /^[0-9]{13}$/.test(s)
}

/** アイテム URL の末尾パスセグメントを NCID として取り出す */
function extractNcid(itemId: unknown): string | null {
  if (typeof itemId !== 'string') return null
  const seg = itemId.split('/').filter(Boolean).pop()
  if (!seg) return null
  return /^[A-Za-z0-9]+$/.test(seg) ? seg : null
}

interface ParsedChannel {
  hits: number
  ncid: string | null
}

/**
 * OpenSearch レスポンス JSON から件数と先頭 NCID を取り出す
 * 0 件のとき items キー自体が存在しないため、オプショナルチェーンでガードする
 */
export function parseCiniiResponse(json: string): ParsedChannel {
  const data = JSON.parse(json) as {
    '@graph'?: Array<{
      'opensearch:totalResults'?: string | number
      items?: Array<{ '@id'?: unknown }>
    }>
  }
  const channel = data['@graph']?.[0]
  if (!channel) return { hits: 0, ncid: null }

  const raw = Number(channel['opensearch:totalResults'] ?? 0)
  const hits = Number.isFinite(raw) ? raw : 0
  const first = channel.items?.[0]
  const ncid = first ? extractNcid(first['@id']) : null

  if (hits < 1 || !ncid) return { hits, ncid: null }
  return { hits, ncid }
}

/**
 * ISBN 候補を先頭から順に照会し、最初に NCID が取れたものを採用する
 * 通信エラーは打ち切らず次の候補を試す。1 度でも取得・解析に成功していれば error は設定しない
 */
export async function lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup> {
  const candidates = [...new Set(isbns.map((s) => cleanIsbn(s).toUpperCase()).filter(isValidIsbn))]
  if (candidates.length === 0) {
    return { ncid: null, hits: 0, queriedIsbn: null }
  }

  let lastIsbn: string | null = null
  let lastError: string | undefined
  let sawSuccess = false

  for (const isbn of candidates) {
    lastIsbn = isbn
    const url = `${ENDPOINT}?isbn=${encodeURIComponent(isbn)}&format=json`

    let body: string
    try {
      body = await pipeline.httpGet(url)
    } catch (e) {
      lastError = String(e)
      continue
    }

    let parsed: ParsedChannel
    try {
      parsed = parseCiniiResponse(body)
    } catch (e) {
      lastError = `CiNii レスポンス解析失敗: ${e}`
      continue
    }

    sawSuccess = true
    if (parsed.ncid) {
      return { ncid: parsed.ncid, hits: parsed.hits, queriedIsbn: isbn }
    }
  }

  return {
    ncid: null,
    hits: 0,
    queriedIsbn: lastIsbn,
    error: sawSuccess ? undefined : lastError,
  }
}
