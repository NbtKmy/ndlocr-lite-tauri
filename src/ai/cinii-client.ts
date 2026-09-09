/**
 * CiNii Books OpenSearch API クライアント
 * ISBN から CiNii Books ID（NCID）を解決する
 * HTTP は Rust の http_get 経由（ブラウザ直接だと CORS で失敗するため、SRU クライアントと同方式）
 */
import { pipeline } from '../pipeline/api'
import { cleanIsbn } from './sru-client'

const ENDPOINT = 'https://ci.nii.ac.jp/books/opensearch/search'

/** CiNii 照会のタイムアウト（秒）。1リクエストで済むので短めに切る */
const TIMEOUT_SECS = 15

export interface CiniiLookup {
  /** 採用した NCID。見つからなければ null */
  ncid: string | null
  /** ISBN群のいずれかに該当した CiNii レコード件数。照会に至らなかった場合は 0 */
  hits: number
  /** 実際に照会した正規化済み ISBN の一覧。有効候補がなければ空配列 */
  queriedIsbns: string[]
  /** 通信・解析失敗時のみ設定 */
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
 * ISBN 候補群を CiNii OpenSearch API に1リクエストでまとめて照会する
 * 020 $a の ISBN は全て同じ資源のものなので、OR で1リクエストにまとめられる。
 * 返却順はAPI依存だが、どの候補で当たっても等価なため items[0] を採用してよい。
 */
export async function lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup> {
  const candidates = [...new Set(isbns.map((s) => cleanIsbn(s).toUpperCase()).filter(isValidIsbn))]
  if (candidates.length === 0) {
    return { ncid: null, hits: 0, queriedIsbns: [] }
  }

  const url = `${ENDPOINT}?isbn=${encodeURIComponent(candidates.join(' OR '))}&format=json`

  let body: string
  try {
    body = await pipeline.httpGet(url, TIMEOUT_SECS)
  } catch (e) {
    return { ncid: null, hits: 0, queriedIsbns: candidates, error: String(e) }
  }

  try {
    const parsed = parseCiniiResponse(body)
    return { ncid: parsed.ncid, hits: parsed.hits, queriedIsbns: candidates }
  } catch (e) {
    return { ncid: null, hits: 0, queriedIsbns: candidates, error: `CiNii レスポンス解析失敗: ${e}` }
  }
}
