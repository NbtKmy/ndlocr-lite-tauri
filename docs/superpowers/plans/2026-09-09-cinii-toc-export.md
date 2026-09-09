# CiNii Books ID 付き目次JSONL 出力 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 埋め込みを含まず、CiNii Books ID（NCID）と目次データを1書籍1行にまとめた軽量 JSONL 出力を ReviewView から生成できるようにする。

**Architecture:** 既存の「目次PDF出力」と同じ構成をとる。ReviewView の独立ボタンから、CiNii 照会（`src/ai/cinii-client.ts`）→ レコード組立と書き込み（`src/output/ciniiExport.ts`）→ Tauri コマンド経由のディスク書き込み、という一方向の流れにする。既存の承認フロー・`books.jsonl` / `entries.jsonl`・ReviewView の `load()` と `phase` 状態機械には一切触らない。出力対象は承認時に確定した `review.json` のみ。

**Tech Stack:** Vite + React 19 + TypeScript (strict) / Tauri v2 (Rust, reqwest) / Vitest 4

**Spec:** `docs/superpowers/specs/2026-09-09-cinii-toc-export-design.md`

## Global Constraints

- 実装前にユーザーの明確な承認を得る。方針説明のメッセージ内にツールコールを含めない（`CLAUDE.md` 開発ルール 1）
- `git push` はユーザーが明示的に指示するまで**絶対に実行しない**（`CLAUDE.md` 開発ルール 3）
- バージョンは **v0.17.0**。更新箇所は `package.json` の `version`、`src/components/layout/Header.tsx:55` の UI バッジ、`src/utils/exportTEI.ts` の TEI メタデータ `version` 属性（**`:59` と `:180` の 2 箇所**）
- コード変更と同じコミット（または直後のコミット）で `README.md` / `CLAUDE.md` / `docs/output-schema.md` を更新する（`CLAUDE.md` 開発ルール 4）
- TypeScript は strict mode。`any` を使わない
- 日本語コメント可。UI テキストは日本語（パイプラインタブは日本語のみ、i18n 対象外）
- テストは `src/__tests__/` に `*.test.ts` で置く。`vi.mock` でモジュールを差し替える
- `tsconfig.app.json` は `"include": ["src"]` なので**テストファイルも `tsc -b` の型チェック対象**。テスト内の型エラーは `npm run build` を失敗させる
- `tsconfig.app.json` の `"types": ["vite/client"]` に vitest のグローバルは含まれない。`describe` / `it` / `expect` / `vi` は必ず `from 'vitest'` で明示 import する
- 出力先ディレクトリは常に `src/utils/outputConfig.ts` の `loadOutputConfig().outputDir` を使う。空文字列のときは `undefined` を渡して Rust 側のデフォルトに委ねる
- 既存の `books.jsonl` / `entries.jsonl` のスキーマと `src/output/writer.ts` は変更しない
- ReviewView の `load()`（`src/views/ReviewView.tsx:65-129`）、`approve`、`retryEmbed`、`phase` の遷移は変更しない

## 検証コマンド

- ユニットテスト（全体）: `npm run test`
- ユニットテスト（単体）: `npx vitest run src/__tests__/<file>.test.ts`
- TypeScript 型チェック + ビルド: `npm run build`
- Rust コンパイルチェック: `cd src-tauri && cargo check`

---

## File Structure

| パス | 責務 |
|---|---|
| `src-tauri/src/lib.rs` | **変更**: `append_output_text` コマンドを追加。プレーンテキストの追記のみを担う。既存 `append_output_record` は JSON 専用で流用できない |
| `src/pipeline/api.ts` | **変更**: `appendOutputText` ラッパーを追加 |
| `src/pipeline/types.ts` | **変更**: `CiniiTocEntry` / `CiniiBookRecord` を追加。出力スキーマの source of truth |
| `src/ai/sru-client.ts` | **変更**: `cleanIsbn` を `export` にする。実装は変えない |
| `src/ai/cinii-client.ts` | **新規**: ISBN → CiNii OpenSearch → NCID。HTTP とレスポンス解析のみ。ファイル書き込みを持たない |
| `src/output/ciniiExport.ts` | **新規**: レコード組立・JSONL 書き込み・ログ書き込み。CiNii 照会は `cinii-client` に委譲 |
| `src/views/ReviewView.tsx` | **変更**: ボタン・state・ハンドラを追加 |
| `src/__tests__/fixtures/ciniiResponses.ts` | **新規**: CiNii API レスポンスのフィクスチャ 3 種 |
| `src/__tests__/ciniiClient.test.ts` | **新規**: 照会ロジックのテスト |
| `src/__tests__/ciniiExport.test.ts` | **新規**: レコード組立とログ書式のテスト |

依存の向きは `ReviewView → ciniiExport → cinii-client → pipeline/api` の一方向のみ。逆向きの依存を作らない。

---

## Task 1: `append_output_text` コマンドと TS ラッパー

ログファイルへのプレーンテキスト追記の土台を作る。既存の `append_output_record` は `serde_json::Value` を受け取ってシリアライズする実装のため、テキスト行の追記には使えない。

**Files:**
- Modify: `src-tauri/src/lib.rs`（`use` 文、`write_output_pdf` の直後、`invoke_handler`）
- Modify: `src/pipeline/api.ts`（`writeOutputPdf` の直後）

**Interfaces:**
- Consumes: 既存の `data_dir(&app)` ヘルパー関数
- Produces:
  - Rust: `append_output_text(app, file: String, text: String, output_dir: Option<String>) -> Result<String, String>`。戻り値は書き込んだファイルの絶対パス
  - TS: `pipeline.appendOutputText(file: string, text: string, outputDir?: string): Promise<string>`

- [ ] **Step 1: `use` 文を追加**

`src-tauri/src/lib.rs` の先頭。現在は `use std::fs;` のみなので、追記用の API を足す。

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri::ipc::Response;
```

- [ ] **Step 2: コマンドを実装**

`src-tauri/src/lib.rs` の `write_output_pdf` 関数の直後（`// ─── エントリポイント ───` コメントの直前）に追加する。

```rust
/// プレーンテキストを1行追記し、書き込んだファイルの絶対パスを返す
/// append_output_record は JSON 専用のため、ログ行の追記にはこちらを使う
#[tauri::command]
async fn append_output_text(
    app: AppHandle,
    file: String,
    text: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("Invalid file name".to_string());
    }
    let dir = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir(&app).join("output"),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&file);

    let mut line = text;
    if !line.ends_with('\n') {
        line.push('\n');
    }

    let mut f = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("append_output_text open: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append_output_text write: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}
```

- [ ] **Step 3: `invoke_handler` に登録**

`src-tauri/src/lib.rs` の `tauri::generate_handler![...]` 内、`write_output_pdf,` の直後に 1 行追加する。登録漏れは実行時に「command not found」となりコンパイルでは検出できないので必ず確認する。

```rust
            write_output_pdf,
            append_output_text,
            read_model_file,
```

- [ ] **Step 4: Rust のコンパイルを確認**

Run: `cd src-tauri && cargo check`
Expected: エラーなし（warning は許容）

- [ ] **Step 5: TS ラッパーを追加**

`src/pipeline/api.ts` の `writeOutputPdf` の直後に追加する。

```ts
  writeOutputPdf: (bookId: string, bytes: Uint8Array, outputDir?: string) =>
    invoke<string>('write_output_pdf', { bookId, bytes: Array.from(bytes), outputDir: outputDir ?? null }),

  appendOutputText: (file: string, text: string, outputDir?: string) =>
    invoke<string>('append_output_text', { file, text, outputDir: outputDir ?? null }),
```

- [ ] **Step 6: 型チェックを確認**

Run: `npm run build`
Expected: 成功

- [ ] **Step 7: コミット**

```bash
git add src-tauri/src/lib.rs src/pipeline/api.ts
git commit -m "feat: add append_output_text command for plain-text log output"
```

---

## Task 2: CiNii Books API クライアント

ISBN から NCID を引く。HTTP とレスポンス解析のみを担い、ファイル書き込みは持たない。

**Files:**
- Modify: `src/ai/sru-client.ts:41`（`cleanIsbn` を `export` にする）
- Create: `src/ai/cinii-client.ts`
- Create: `src/__tests__/fixtures/ciniiResponses.ts`
- Test: `src/__tests__/ciniiClient.test.ts`

**Interfaces:**
- Consumes: `pipeline.httpGet(url: string): Promise<string>`（既存）、`cleanIsbn(raw: string): string`
- Produces:
  - `export interface CiniiLookup { ncid: string | null; hits: number; queriedIsbn: string | null; error?: string }`
  - `export async function lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup>`
  - `export function parseCiniiResponse(json: string): { hits: number; ncid: string | null }`

- [ ] **Step 1: フィクスチャを作成**

`src/__tests__/fixtures/ciniiResponses.ts` を新規作成する。`tsconfig.app.json` に `resolveJsonModule` がないため `.json` ファイルの import は使わず、TS から JSON 文字列を `export` する。

`CINII_HIT1` と `CINII_HIT0` は 2026-09-09 に実 API から取得した値。`CINII_HIT3` は `CINII_HIT1` の `items` を 3 件に増やした加工版。

```ts
/**
 * CiNii Books OpenSearch API レスポンスのテストフィクスチャ
 * HIT1 / HIT0 は 2026-09-09 に実 API から取得した値。HIT3 は HIT1 の items を 3 件に増やした加工版
 */

/** ISBN 9784167137113 で 1 件ヒット */
export const CINII_HIT1 = JSON.stringify({
  '@id': 'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113&format=json',
  '@graph': [
    {
      title: 'CiNii Books OpenSearch - 9784167137113',
      '@type': 'channel',
      'opensearch:totalResults': '1',
      'opensearch:startIndex': '0',
      'opensearch:itemsPerPage': '1',
      items: [
        {
          title: '夕陽カ丘三号館',
          '@id': 'https://ci.nii.ac.jp/ncid/BB08395220',
          '@type': 'item',
          'rdfs:seeAlso': { '@id': 'https://ci.nii.ac.jp/ncid/BB08395220.json' },
          'dc:date': '2012',
          'dc:creator': '有吉佐和子著',
          'dc:publisher': ['文藝春秋'],
          'cinii:ownerCount': '15',
        },
      ],
    },
  ],
})

/** ヒット 0 件。items キー自体が存在しないことが重要 */
export const CINII_HIT0 = JSON.stringify({
  '@id': 'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784100000000&format=json',
  '@graph': [
    {
      title: 'CiNii Books OpenSearch - 9784100000000',
      '@type': 'channel',
      'opensearch:totalResults': '0',
      'opensearch:startIndex': '0',
      'opensearch:itemsPerPage': '0',
    },
  ],
})

/** 3 件ヒット（加工版）。先頭が採用されることを確認するため 3 件の NCID を別々にする */
export const CINII_HIT3 = JSON.stringify({
  '@graph': [
    {
      '@type': 'channel',
      'opensearch:totalResults': '3',
      items: [
        { '@id': 'https://ci.nii.ac.jp/ncid/BB08395220', title: '夕陽カ丘三号館' },
        { '@id': 'https://ci.nii.ac.jp/ncid/BN00564770', title: '夕陽カ丘三号館' },
        { '@id': 'https://ci.nii.ac.jp/ncid/BA12345678', title: '夕陽ヶ丘三号館' },
      ],
    },
  ],
})
```

- [ ] **Step 2: 失敗するテストを書く**

`src/__tests__/ciniiClient.test.ts` を新規作成する。

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pipeline/api', () => ({
  pipeline: { httpGet: vi.fn() },
}))

import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid, parseCiniiResponse } from '../ai/cinii-client'
import { CINII_HIT1, CINII_HIT0, CINII_HIT3 } from './fixtures/ciniiResponses'

const httpGet = vi.mocked(pipeline.httpGet)

describe('parseCiniiResponse', () => {
  it('1件ヒットで NCID を抽出する', () => {
    expect(parseCiniiResponse(CINII_HIT1)).toEqual({ hits: 1, ncid: 'BB08395220' })
  })

  it('0件（items キーなし）でも例外を投げず ncid=null を返す', () => {
    expect(parseCiniiResponse(CINII_HIT0)).toEqual({ hits: 0, ncid: null })
  })

  it('複数ヒットで先頭の NCID を採用し hits を保持する', () => {
    expect(parseCiniiResponse(CINII_HIT3)).toEqual({ hits: 3, ncid: 'BB08395220' })
  })

  it('NCID の形式が不正なら ncid=null を返す', () => {
    const bad = JSON.stringify({
      '@graph': [
        {
          'opensearch:totalResults': '1',
          items: [{ '@id': 'https://ci.nii.ac.jp/ncid/BAD ID!' }],
        },
      ],
    })
    expect(parseCiniiResponse(bad)).toEqual({ hits: 1, ncid: null })
  })
})

describe('lookupCiniiNcid', () => {
  beforeEach(() => {
    httpGet.mockReset()
  })

  it('ハイフンと付記を除去した ISBN で照会する', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['978-4-16-713711-3 (pbk)'])
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113&format=json'
    )
    expect(r.ncid).toBe('BB08395220')
    expect(r.hits).toBe(1)
    expect(r.queriedIsbn).toBe('9784167137113')
  })

  it('ISBN-10 の末尾 X を有効な候補として扱う', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['4-16-713711-X'])
    expect(r.queriedIsbn).toBe('416713711X')
  })

  it('桁数が不正な候補は照会しない', async () => {
    const r = await lookupCiniiNcid(['12345', '978416713711'])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbn: null })
  })

  it('候補が空なら httpGet を呼ばない', async () => {
    const r = await lookupCiniiNcid([])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbn: null })
  })

  it('1番目が0件・2番目がヒットなら2番目を採用する', async () => {
    httpGet.mockResolvedValueOnce(CINII_HIT0).mockResolvedValueOnce(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784100000000', '9784167137113'])
    expect(httpGet).toHaveBeenCalledTimes(2)
    expect(r.ncid).toBe('BB08395220')
    expect(r.queriedIsbn).toBe('9784167137113')
  })

  it('全候補0件なら error を設定せず最後の候補を queriedIsbn に入れる', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    const r = await lookupCiniiNcid(['9784100000000', '9784200000000'])
    expect(r.ncid).toBeNull()
    expect(r.hits).toBe(0)
    expect(r.queriedIsbn).toBe('9784200000000')
    expect(r.error).toBeUndefined()
  })

  it('全候補で通信失敗なら error を設定する', async () => {
    httpGet.mockRejectedValue(new Error('http_get error: 503'))
    const r = await lookupCiniiNcid(['9784100000000'])
    expect(r.ncid).toBeNull()
    expect(r.error).toContain('503')
    expect(r.queriedIsbn).toBe('9784100000000')
  })

  it('0件と通信失敗が混在する場合は error を設定しない', async () => {
    httpGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(CINII_HIT0)
    const r = await lookupCiniiNcid(['9784100000000', '9784200000000'])
    expect(r.ncid).toBeNull()
    expect(r.error).toBeUndefined()
  })

  it('正規化後に重複する候補は1度しか照会しない', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    await lookupCiniiNcid(['978-4-10-000000-0', '9784100000000'])
    expect(httpGet).toHaveBeenCalledTimes(1)
  })

  it('NCID 形式が不正な候補は採用せず次の候補に進む', async () => {
    const badNcid = JSON.stringify({
      '@graph': [
        { 'opensearch:totalResults': '1', items: [{ '@id': 'https://ci.nii.ac.jp/ncid/BAD ID!' }] },
      ],
    })
    httpGet.mockResolvedValueOnce(badNcid).mockResolvedValueOnce(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784100000000', '9784167137113'])
    expect(r.ncid).toBe('BB08395220')
    expect(r.queriedIsbn).toBe('9784167137113')
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run src/__tests__/ciniiClient.test.ts`
Expected: FAIL。`Cannot find module '../ai/cinii-client'` のような解決エラーになる

- [ ] **Step 4: `cleanIsbn` を export にする**

`src/ai/sru-client.ts:41`。`function` の前に `export` を付けるだけで、実装は変更しない。重複実装を作らないため既存関数を再利用する。

```ts
/** ハイフン・空白除去、末尾の修飾語（括弧内等）を除く */
export function cleanIsbn(raw: string): string {
  return raw.split(/[\s(]/)[0].replace(/-/g, '').trim()
}
```

- [ ] **Step 5: クライアントを実装**

`src/ai/cinii-client.ts` を新規作成する。

```ts
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
 * 通信エラーは打ち切らず次の候補を試す。1 度でも通信に成功していれば error は設定しない
 */
export async function lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup> {
  const candidates = [...new Set(isbns.map(cleanIsbn).filter(isValidIsbn))]
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
```

- [ ] **Step 6: テストが通ることを確認**

Run: `npx vitest run src/__tests__/ciniiClient.test.ts`
Expected: PASS（14 テスト）

- [ ] **Step 7: 既存テストと型チェックが壊れていないことを確認**

Run: `npm run test && npm run build`
Expected: 両方成功。`cleanIsbn` を `export` にしただけなので `sru-client` の利用側に影響はない

- [ ] **Step 8: コミット**

```bash
git add src/ai/cinii-client.ts src/ai/sru-client.ts src/__tests__/ciniiClient.test.ts src/__tests__/fixtures/ciniiResponses.ts
git commit -m "feat: add CiNii Books OpenSearch client for NCID lookup"
```

---

## Task 3: 出力モジュール

`review.json` の確定エントリと CiNii 照会結果から JSONL レコードとログ行を組み立てて書き込む。

**Files:**
- Modify: `src/pipeline/types.ts`（末尾に型を追加）
- Create: `src/output/ciniiExport.ts`
- Test: `src/__tests__/ciniiExport.test.ts`

**Interfaces:**
- Consumes: `lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup>`（Task 2）、`pipeline.appendOutputText(file, text, outputDir?): Promise<string>`（Task 1）、`pipeline.readStage<T>(bookId, stage): Promise<T>`（既存）、`pipeline.upsertOutputRecords(file, bookId, records, outputDir?): Promise<void>`（既存）
- Produces:
  - `export interface CiniiTocEntry { seq: number; level: number; heading_text: string; page_number: number | null; contributor: string | null }`
  - `export interface CiniiBookRecord { book_id: string; cinii_ncid: string; title: string | null; pub_year: string | null; isbn: string[]; exported_at: string; toc: CiniiTocEntry[] }`
  - `export type CiniiSkipReason = 'not_reviewed' | 'no_isbn' | 'no_hit' | 'api_error'`
  - `export interface CiniiExportResult`（下記 Step 4 の定義どおり）
  - `export async function exportCiniiBook(bookId: string, sruMeta: SruMetadata, now?: Date): Promise<CiniiExportResult>`
  - `export function toIsoWithOffset(d: Date): string`
  - `export function formatLogLine(r: CiniiExportResult, bookId: string): string`

- [ ] **Step 1: 型を追加**

`src/pipeline/types.ts` の末尾（`OutputBook` の後）に追加する。

```ts
/** cinii_books.jsonl の目次エントリ（OCR中間情報・信頼度・埋め込みを含まない） */
export interface CiniiTocEntry {
  seq: number
  level: number
  heading_text: string
  page_number: number | null
  contributor: string | null
}

/** cinii_books.jsonl の1レコード（1書籍1行、埋め込みなし） */
export interface CiniiBookRecord {
  book_id: string          // MMS ID（upsert キー）
  cinii_ncid: string       // 例 BB08395220
  title: string | null     // SRU: titleOriginal ?? titleRomanized
  pub_year: string | null
  isbn: string[]           // SRU 由来の生値
  exported_at: string      // ISO8601（cinii_export.log の行頭と同一値）
  toc: CiniiTocEntry[]
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/__tests__/ciniiExport.test.ts` を新規作成する。

```ts
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
          queriedIsbn: '9784167137113',
          hits: 1,
          entryCount: 42,
        },
        '991234567890'
      )
    ).toBe(
      '2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 isbn=9784167137113 hits=1 entries=42'
    )
  })

  it('OK 行（複数ヒットは note を付ける）', () => {
    expect(
      formatLogLine(
        {
          status: 'ok',
          exportedAt: '2026-09-09T20:53:44+09:00',
          ncid: 'BA12345678',
          queriedIsbn: '9784200000000',
          hits: 3,
          entryCount: 18,
        },
        '991236000000'
      )
    ).toBe(
      '2026-09-09T20:53:44+09:00 991236000000 OK   ncid=BA12345678 isbn=9784200000000 hits=3 entries=18 note=複数3件ヒット→先頭採用'
    )
  })

  it('SKIP 行（no_hit）', () => {
    expect(
      formatLogLine(
        {
          status: 'skipped',
          reason: 'no_hit',
          exportedAt: '2026-09-09T20:53:01+09:00',
          queriedIsbn: '9784100000000',
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
        queriedIsbn: '9784300000000',
        detail: 'http_get error: 503',
      },
      '991239000000'
    )
    expect(line).toBe(
      '2026-09-09T20:56:33+09:00 991239000000 SKIP reason=api_error isbn=9784300000000 detail=http_get error: 503'
    )
    expect(line.endsWith('detail=http_get error: 503')).toBe(true)
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
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

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
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

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
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

    await exportCiniiBook('991234567890', { ...META, titleOriginal: null }, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    expect(record.title).toBe('Yuhigaoka sangokan')
  })

  it('exported_at とログ行のタイムスタンプが同一値になる', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    const record = upsert.mock.calls[0][2][0] as CiniiBookRecord
    const logLine = appendText.mock.calls[0][1]
    expect(record.exported_at).toBe(r.exportedAt)
    expect(logLine.startsWith(r.exportedAt)).toBe(true)
  })

  it('upsertOutputRecords を cinii_books.jsonl と book_id で呼ぶ', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

    await exportCiniiBook('991234567890', META, FIXED)

    expect(upsert).toHaveBeenCalledTimes(1)
    const [file, bookId, records, outputDir] = upsert.mock.calls[0]
    expect(file).toBe('cinii_books.jsonl')
    expect(bookId).toBe('991234567890')
    expect(records).toHaveLength(1)
    expect(outputDir).toBe('/tmp/out')
  })

  it('成功時は outputDir をログパスから導出する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BB08395220', hits: 1, queriedIsbn: '9784167137113' })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('ok')
    expect(r.entryCount).toBe(1)
    expect(r.logPath).toBe(LOG_PATH)
    expect(r.outputDir).toBe('/tmp/out')
  })

  it('review.json が読めなければ JSONL を書かず not_reviewed をログに残す', async () => {
    readStage.mockRejectedValue(new Error('read_stage_json: No such file'))

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('skipped')
    expect(r.reason).toBe('not_reviewed')
    expect(upsert).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(appendText).toHaveBeenCalledTimes(1)
  })

  it('review.json が空配列でも not_reviewed になる', async () => {
    readStage.mockResolvedValue([])

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('not_reviewed')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('有効な ISBN がなければ no_isbn で JSONL を書かない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: null, hits: 0, queriedIsbn: null })

    const r = await exportCiniiBook('991234567890', { ...META, isbn: [] }, FIXED)

    expect(r.reason).toBe('no_isbn')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('ヒット0件なら no_hit で JSONL を書かない', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: null, hits: 0, queriedIsbn: '9784167137113' })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('no_hit')
    expect(r.queriedIsbn).toBe('9784167137113')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('通信失敗なら api_error で detail を残す', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({
      ncid: null,
      hits: 0,
      queriedIsbn: '9784167137113',
      error: 'http_get error: 503',
    })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.reason).toBe('api_error')
    expect(r.detail).toBe('http_get error: 503')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('複数ヒット時は hits を保持する', async () => {
    readStage.mockResolvedValue([entry(1)])
    lookup.mockResolvedValue({ ncid: 'BA12345678', hits: 3, queriedIsbn: '9784200000000' })

    const r = await exportCiniiBook('991234567890', META, FIXED)

    expect(r.status).toBe('ok')
    expect(r.hits).toBe(3)
    expect(appendText.mock.calls[0][1]).toContain('note=複数3件ヒット→先頭採用')
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run src/__tests__/ciniiExport.test.ts`
Expected: FAIL。`Cannot find module '../output/ciniiExport'`

- [ ] **Step 4: 出力モジュールを実装**

`src/output/ciniiExport.ts` を新規作成する。

```ts
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
import type { ReviewedEntry, CiniiBookRecord, CiniiTocEntry } from '../pipeline/types'
import { loadOutputConfig } from '../utils/outputConfig'

const CINII_FILE = 'cinii_books.jsonl'
const LOG_FILE = 'cinii_export.log'

export type CiniiSkipReason = 'not_reviewed' | 'no_isbn' | 'no_hit' | 'api_error'

export interface CiniiExportResult {
  status: 'ok' | 'skipped'
  reason?: CiniiSkipReason
  detail?: string
  ncid?: string
  hits?: number
  queriedIsbn?: string
  entryCount?: number
  /** 出力ディレクトリの絶対パス。logPath から導出 */
  outputDir?: string
  /** ログファイルの絶対パス */
  logPath?: string
  exportedAt: string
}

function outputDir(): string | undefined {
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

/** ログ1行を組み立てる（設計仕様 §3.2）。'OK  ' の末尾スペースは SKIP と桁を揃えるため */
export function formatLogLine(r: CiniiExportResult, bookId: string): string {
  const parts = [r.exportedAt, bookId]
  if (r.status === 'ok') {
    parts.push('OK  ')
    parts.push(`ncid=${r.ncid}`)
    parts.push(`isbn=${r.queriedIsbn}`)
    parts.push(`hits=${r.hits}`)
    parts.push(`entries=${r.entryCount}`)
    if ((r.hits ?? 0) > 1) {
      parts.push(`note=複数${r.hits}件ヒット→先頭採用`)
    }
  } else {
    parts.push('SKIP')
    parts.push(`reason=${r.reason}`)
    if (r.queriedIsbn) parts.push(`isbn=${r.queriedIsbn}`)
    if (r.hits !== undefined) parts.push(`hits=${r.hits}`)
    // detail は値にスペースを含みうるため必ず行末に置く
    if (r.detail) parts.push(`detail=${r.detail}`)
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
      queriedIsbn: lookup.queriedIsbn ?? undefined,
      detail: lookup.error,
    })
  }
  if (lookup.queriedIsbn === null) {
    return skip('no_isbn')
  }
  if (!lookup.ncid) {
    return skip('no_hit', { queriedIsbn: lookup.queriedIsbn, hits: lookup.hits })
  }

  // ③ レコード組立と書き込み
  const record: CiniiBookRecord = {
    book_id: bookId,
    cinii_ncid: lookup.ncid,
    title: sruMeta.titleOriginal ?? sruMeta.titleRomanized,
    pub_year: sruMeta.pubYear,
    isbn: sruMeta.isbn,
    exported_at: exportedAt,
    toc: entries.map(toCiniiTocEntry),
  }
  await pipeline.upsertOutputRecords(CINII_FILE, bookId, [record], dir)

  const result: CiniiExportResult = {
    status: 'ok',
    exportedAt,
    ncid: lookup.ncid,
    hits: lookup.hits,
    queriedIsbn: lookup.queriedIsbn,
    entryCount: entries.length,
  }
  result.logPath = await pipeline.appendOutputText(LOG_FILE, formatLogLine(result, bookId), dir)
  result.outputDir = result.logPath.slice(0, result.logPath.lastIndexOf('/'))
  return result
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/__tests__/ciniiExport.test.ts`
Expected: PASS（20 テスト）

- [ ] **Step 6: 全テストと型チェック**

Run: `npm run test && npm run build`
Expected: 両方成功

- [ ] **Step 7: コミット**

```bash
git add src/output/ciniiExport.ts src/pipeline/types.ts src/__tests__/ciniiExport.test.ts
git commit -m "feat: add CiNii TOC export writer with correlated text log"
```

---

## Task 4: ReviewView への統合

ボタンを追加する。`phase === 'review'`（ヘッダー）と `phase === 'done'`（承認完了画面 2 種）で描画箇所が異なる点に注意する。

**Files:**
- Modify: `src/views/ReviewView.tsx`（import 群、state 宣言 `:63` 付近、`handleExportPdf` の直後 `:192` 付近、`currentPage` の直後 `:299` 付近、done 画面 `:313-334`、ヘッダー `:402` 付近と `:415` 付近）

**Interfaces:**
- Consumes: `exportCiniiBook(bookId, sruMeta, now?): Promise<CiniiExportResult>`（Task 3）、既存の `makeFallbackMeta(bookId): SruMetadata`（同ファイル `:25`）
- Produces: UI のみ。他タスクが依存するエクスポートはない

- [ ] **Step 1: import を追加**

`src/views/ReviewView.tsx` の `import { generateTocPdf } from '../output/tocPdf'`（`:10`）の直後に追加する。

```ts
import { generateTocPdf } from '../output/tocPdf'
import { exportCiniiBook } from '../output/ciniiExport'
```

- [ ] **Step 2: state を追加**

`const [pdfMessage, setPdfMessage] = useState<string | null>(null)`（`:63`）の直後に追加する。`pdfMessage` とは別 state にして、両方を押したときに互いのメッセージを潰さないようにする。

```ts
  const [pdfMessage, setPdfMessage] = useState<string | null>(null)
  const [ciniiMessage, setCiniiMessage] = useState<string | null>(null)
  const [ciniiBusy, setCiniiBusy] = useState(false)
```

- [ ] **Step 3: ハンドラを追加**

`handleExportPdf` の `useCallback` の直後（`:192`、`/** 承認ボタン → …` コメントの直前）に追加する。

```ts
  /**
   * CiNii JSON出力（承認時の確定データ review.json を対象、承認フローとは独立）
   * スキップは業務上の正常な結果なのでエラー表示にはしない
   */
  const handleExportCinii = useCallback(async () => {
    setCiniiBusy(true)
    setCiniiMessage('CiNii照会中…')
    try {
      const meta = sruMeta ?? makeFallbackMeta(bookId)
      const r = await exportCiniiBook(bookId, meta)
      if (r.status === 'ok') {
        const multi = (r.hits ?? 0) > 1 ? `（${r.hits}件ヒット→先頭採用）` : ''
        setCiniiMessage(
          `CiNii JSON出力しました: ${r.outputDir}/cinii_books.jsonl` +
            `（承認時の確定データ ${r.entryCount}件 / ncid=${r.ncid}）${multi}`
        )
      } else if (r.reason === 'not_reviewed') {
        setCiniiMessage('未承認です。「承認 → 出力」を実行してから押してください')
      } else if (r.reason === 'no_isbn') {
        setCiniiMessage(`ISBNがないためCiNii照会できません（ログ記録: ${r.logPath}）`)
      } else if (r.reason === 'no_hit') {
        setCiniiMessage(
          `CiNii IDが見つかりませんでした。JSONには出力していません（ログ記録: ${r.logPath}）`
        )
      } else {
        setCiniiMessage(`CiNii API エラー: ${r.detail}（ログ記録: ${r.logPath}）`)
      }
    } catch (e) {
      setCiniiMessage(`CiNii出力エラー: ${e}`)
    } finally {
      setCiniiBusy(false)
    }
  }, [bookId, sruMeta])
```

- [ ] **Step 4: ボタン JSX を変数として組み立てる**

`const currentPage = ocrPages[currentPageIdx]`（`:299`）の直後に追加する。`phase === 'done'` は `:313` で早期リターンするため、ボタンは**早期リターンより前**に定義して 3 箇所から参照する。フック呼び出しではないので条件分岐の前後どちらでも安全だが、done 画面から参照するには早期リターンより前でなければならない。

```ts
  const currentPage = ocrPages[currentPageIdx]

  // review フェーズのヘッダーと done 画面 2 種の 3 箇所から参照するため変数化する
  const ciniiButton = (
    <button className="btn-secondary" onClick={handleExportCinii} disabled={ciniiBusy}>
      {ciniiBusy ? 'CiNii照会中…' : 'CiNii JSON出力'}
    </button>
  )
```

- [ ] **Step 5: done 画面（埋め込み失敗時）にボタンとメッセージを追加**

`:313-326` の `if (phase === 'done') { if (embedFailed) { ... } }` ブロック。既存の `.review-done-actions` にボタンを足し、メッセージ用の `<p>` を追加する。

```tsx
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
            {ciniiButton}
          </div>
          {ciniiMessage && <p className="progress-text">{ciniiMessage}</p>}
        </div>
      )
    }
```

- [ ] **Step 6: done 画面（通常）にボタンとメッセージを追加**

`:327-333` の通常の承認完了画面。現在は `.review-done-actions` のラッパーがなく `<button>` が直接置かれているため、ラッパーを追加してから 2 つのボタンを入れる。

```tsx
    return (
      <div className="review-done">
        <h2>✅ 承認完了</h2>
        <p><code>data/output/entries.jsonl</code> に出力しました。</p>
        <div className="review-done-actions">
          <button className="btn-primary" onClick={onBack}>← キューに戻る</button>
          {ciniiButton}
        </div>
        {ciniiMessage && <p className="progress-text">{ciniiMessage}</p>}
      </div>
    )
  }
```

- [ ] **Step 7: review フェーズのヘッダーにボタンを追加**

`:397-409` の `{phase === 'review' && (<>...</>)}` ブロック。`PDF出力` ボタンの直後、`承認 → 出力` の直前に `{ciniiButton}` を置く。

```tsx
          {phase === 'review' && (
            <>
              <button className="btn-secondary" onClick={runStructuring}>
                再構造化
              </button>
              <button className="btn-secondary" onClick={handleExportPdf}>
                PDF出力
              </button>
              {ciniiButton}
              <button className="btn-approve" onClick={handleApproveClick}>
                承認 → 出力
              </button>
            </>
          )}
```

- [ ] **Step 8: review フェーズのヘッダーにメッセージを追加**

`:415-417` の `{phase === 'review' && pdfMessage && (...)}` の直後に追加する。

```tsx
          {phase === 'review' && pdfMessage && (
            <span className="progress-text">{pdfMessage}</span>
          )}
          {phase === 'review' && ciniiMessage && (
            <span className="progress-text">{ciniiMessage}</span>
          )}
```

- [ ] **Step 9: 型チェックとテスト**

Run: `npm run build && npm run test`
Expected: 両方成功

- [ ] **Step 10: 手動確認**

Run: `npm run tauri dev`

以下を順に確認する。

1. 未承認の書籍を開き `CiNii JSON出力` を押す → `未承認です。…` が表示される。出力ディレクトリに `cinii_books.jsonl` が作られない（または既存の内容が変わらない）。`cinii_export.log` に `SKIP reason=not_reviewed` の行が追加される
2. 「承認 → 出力」を実行して承認完了画面に進み `CiNii JSON出力` を押す → `CiNii JSON出力しました: …（承認時の確定データ N件 / ncid=…）` が表示される。`cinii_books.jsonl` に 1 行追加される
3. `cinii_books.jsonl` の行と `cinii_export.log` の `OK` 行で、`exported_at` と行頭タイムスタンプが一致する
4. 同じ書籍でもう一度 `CiNii JSON出力` を押す → `cinii_books.jsonl` の行数が増えず、内容が上書きされる。ログには 2 行目が追加される
5. `toc` に `raw_ocr_text` / `confidence` / `embedding` が含まれない
6. 既存の「PDF出力」と「承認 → 出力」が従来どおり動く

- [ ] **Step 11: コミット**

```bash
git add src/views/ReviewView.tsx
git commit -m "feat: add CiNii JSON export button to ReviewView"
```

---

## Task 5: ドキュメントとバージョン更新

**Files:**
- Modify: `package.json:4`
- Modify: `src/components/layout/Header.tsx:55`
- Modify: `src/utils/exportTEI.ts:59` と `:180`（**2 箇所ある**）
- Modify: `README.md:293` 付近（変更履歴）
- Modify: `CLAUDE.md`（ディレクトリ構成・パイプライン処理フロー・開発フェーズ）
- Modify: `docs/output-schema.md:7-18` 付近（ファイル構成）と末尾

**Interfaces:**
- Consumes: Task 1〜4 で追加した全ファイル
- Produces: なし

- [ ] **Step 1: `package.json` のバージョンを更新**

```json
  "version": "0.17.0",
```

- [ ] **Step 2: Header の UI バッジを更新**

`src/components/layout/Header.tsx:55`

```tsx
        <span className="header-version">v0.17.0</span>
```

- [ ] **Step 3: TEI メタデータのバージョンを 2 箇所更新**

`src/utils/exportTEI.ts` の `:59` と `:180`。どちらも同じ文字列なので、置換漏れがないよう両方を確認する。

```
        <application ident="ndlocr-lite-web-ai" version="0.17.0">
```

確認: `rg -n '0\.16\.0' src/utils/exportTEI.ts` が何も返さないこと

- [ ] **Step 4: README の変更履歴に追記**

`README.md:293` の `## 変更履歴` 直下、`### v0.16.0（2026-08-20）` の前に挿入する。

```markdown
### v0.17.0（2026-09-09）

- feat: CiNii Books ID 付き目次JSONL出力を追加。ISBN から CiNii Books OpenSearch API で NCID を解決し、タイトル・出版年・ISBN・NCID と目次データを1書籍1行にまとめた `cinii_books.jsonl` を出力（埋め込みなし）。ReviewViewに「CiNii JSON出力」ボタンを追加
- feat: CiNii 照会の結果を `cinii_export.log` に記録。JSONレコードの `exported_at` とログ行のタイムスタンプが同一値になり突合できる。NCID が取得できなかった書籍はJSONには出力せずログにのみ残す
```

- [ ] **Step 5: CLAUDE.md のディレクトリ構成に追記**

`src/ai/` の `embeddings.ts` の行の後に 1 行、`src/output/` の `tocPdf.ts` の行の後に 1 行を追加する。

```
│   │   ├── embeddings.ts          # bge-m3 埋め込み（書籍レベル + チャンクレベル）
│   │   └── cinii-client.ts        # ISBN→CiNii Books OpenSearch→NCID解決
```

```
│   │   ├── tocPdf.ts              # 目次PDF出力（1書籍1PDF、pdf-lib + IPAexゴシック）
│   │   └── ciniiExport.ts         # CiNii ID付き目次JSONL出力（埋め込みなし）+ 照会ログ
```

- [ ] **Step 6: CLAUDE.md のパイプライン処理フローに追記**

「データパス（macOS）」ブロックの `output/` の下に 2 行を追加する。

```
    output/    # books.jsonl / entries.jsonl（設定で変更可）
      toc_pdf/{mmsId}.pdf  # 目次PDF（見出し・著者名、ページ番号なし）
      cinii_books.jsonl    # CiNii ID付き目次JSONL（埋め込みなし、1書籍1行）
      cinii_export.log     # CiNii照会・出力ログ（exported_at で JSONL と突合）
```

同ブロックの末尾、目次PDF出力の行の後に 1 行を追加する。

```
  → CiNii JSON出力（任意・手動: ReviewViewの「CiNii JSON出力」ボタン、対象は review.json のみ）
```

- [ ] **Step 7: CLAUDE.md の開発フェーズに追記**

「パイプラインタブ（Tauri デスクトップ）」の目次PDF出力の行の後に追加する。

```markdown
- [x] CiNii Books ID 付き目次JSONL出力（埋め込みなし、`cinii_books.jsonl` + `cinii_export.log`、ReviewViewから手動生成）
```

- [ ] **Step 8: `docs/output-schema.md` のファイル構成を更新**

`:9-18` のブロックを差し替える。

````markdown
```
data/output/
  books.jsonl   … 1行1書籍
  entries.jsonl … 1行1目次エントリ（pgvector想定）
  toc_pdf/{book_id}.pdf … 目次PDF（1書籍1ファイル、任意生成。DB取り込み対象外）
  cinii_books.jsonl … 1行1書籍。CiNii Books ID付き・埋め込みなし（任意生成。DB取り込み対象外）
  cinii_export.log  … CiNii照会・出力ログ（任意生成。DB取り込み対象外）
```

`toc_pdf/{book_id}.pdf` はDB投入用JSONLとは独立した補助出力（ReviewViewから手動生成）。
見出し（階層インデント）と各節の著者名（`contributor`、ある場合のみ）を1書籍1PDFにまとめたもので、
ページ番号は含まない。books.jsonl / entries.jsonl のスキーマには影響しない。

`cinii_books.jsonl` / `cinii_export.log` も同様に独立した補助出力（ReviewViewから手動生成）。
埋め込みを含まない軽量な受け渡し用データで、books.jsonl / entries.jsonl のスキーマには影響しない。
````

- [ ] **Step 9: `docs/output-schema.md` に新スキーマの節を追加**

`## 注意事項（DB取り込み時）` の直前に挿入する。

````markdown
## cinii_books.jsonl（補助出力・DB取り込み対象外）

埋め込みを含まない軽量な受け渡し用データ。1行1書籍で、目次データを `toc` に入れ子で持つ。
`CiniiBookRecord`（`src/pipeline/types.ts`）と一致。`book_id` をキーに upsert されるため、
再出力しても行は重複しない。

```jsonc
{
  "book_id": "991234567890",          // MMS ID（upsertキー）
  "cinii_ncid": "BB08395220",         // CiNii Books ID
  "title": "夕陽カ丘三号館",           // SRU: titleOriginal ?? titleRomanized
  "pub_year": "2012",
  "isbn": ["9784167137113"],          // SRU由来の生値（ハイフン等を含む場合あり）
  "exported_at": "2026-09-09T20:52:26+09:00",  // cinii_export.log の行頭と同一値
  "toc": [
    { "seq": 1, "level": 1, "heading_text": "第一章 転居", "page_number": 5, "contributor": null }
  ]
}
```

出力対象は承認時に確定した `work/{mmsId}/review.json` のみ。CiNii Books ID が取得できなかった
書籍（ISBNなし・ヒット0件・API失敗）はこのファイルに出力されず、`cinii_export.log` にのみ記録される。

## cinii_export.log（補助出力・DB取り込み対象外）

1イベント1行のプレーンテキスト。行頭のタイムスタンプは同じ出力処理で書かれた
`cinii_books.jsonl` レコードの `exported_at` と同一値であり、これで両者を突合する。

```
2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 isbn=9784167137113 hits=1 entries=42
2026-09-09T20:53:01+09:00 991235000000 SKIP reason=no_hit isbn=9784100000000 hits=0
2026-09-09T20:53:44+09:00 991236000000 OK   ncid=BA12345678 isbn=9784200000000 hits=3 entries=18 note=複数3件ヒット→先頭採用
```

`reason` は `not_reviewed`（未承認）/ `no_isbn`（有効なISBNなし）/ `no_hit`（CiNiiにヒット0件）/
`api_error`（通信・解析失敗）のいずれか。`detail` は値にスペースを含みうるため必ず行末に置かれる。
````

- [ ] **Step 10: バージョン記述の残りがないことを確認**

Run: `rg -n '0\.16\.0' package.json src/components/layout/Header.tsx src/utils/exportTEI.ts`
Expected: 何も返らない

- [ ] **Step 11: 全テストと型チェック**

Run: `npm run test && npm run build`
Expected: 両方成功

- [ ] **Step 12: コミット**

```bash
git add package.json src/components/layout/Header.tsx src/utils/exportTEI.ts README.md CLAUDE.md docs/output-schema.md
git commit -m "docs: document CiNii TOC export and bump version to v0.17.0"
```

- [ ] **Step 13: プッシュはしない**

`CLAUDE.md` 開発ルール 3 により、`git push` はユーザーが明示的に指示するまで実行しない。完了報告のみを行う。

---

## Self-Review

**仕様カバレッジ:**

| 仕様の節 | 実装タスク |
|---|---|
| §3.1 `cinii_books.jsonl` スキーマ | Task 3 Step 1（型）、Step 4（組立） |
| §3.2 `cinii_export.log` 書式 | Task 3 Step 4（`formatLogLine`） |
| §4.1 エンドポイントと `http_get` 経由 | Task 2 Step 5 |
| §4.2 レスポンス構造・0件で `items` なし | Task 2 Step 5（`parseCiniiResponse`）、Step 1（フィクスチャ） |
| §4.3 ISBN 正規化・候補順・エラー方針 | Task 2 Step 4（`cleanIsbn` export）、Step 5 |
| §4.4 `CiniiLookup` / `lookupCiniiNcid` | Task 2 Step 5 |
| §5 モジュール構成・型・Rust コマンド | Task 1、Task 2、Task 3 |
| §6 処理フローと `exportCiniiBook` | Task 3 Step 4 |
| §7 UI（review / done で描画箇所が異なる） | Task 4 Step 4〜8 |
| §8 スキップ条件 4 種 | Task 3 Step 4、テストは Step 2 |
| §9 決定事項 D1〜D5 | Task 3 Step 4 のモジュール冒頭コメントに D1 を記載 |
| §10 テスト計画 | Task 2 Step 2、Task 3 Step 2、Task 4 Step 10（手動確認） |
| §11 ドキュメント・バージョン | Task 5 |
| §12 将来の拡張 | 対象外（実装しない） |

**プレースホルダ:** なし。全ステップに実際のコード・コマンド・期待結果を記載した。

**型の整合性:**

- `CiniiLookup`（Task 2 が定義）を Task 3 の `exportCiniiBook` が消費する。フィールド名は `ncid` / `hits` / `queriedIsbn` / `error` で一貫
- `CiniiTocEntry` / `CiniiBookRecord`（Task 3 Step 1 で `src/pipeline/types.ts` に定義）を同 Step 4 が import する
- `CiniiExportResult`（Task 3 が定義）を Task 4 の `handleExportCinii` が消費する。参照するフィールドは `status` / `reason` / `detail` / `ncid` / `hits` / `entryCount` / `outputDir` / `logPath` で、すべて定義済み
- `pipeline.appendOutputText`（Task 1 が追加、`Promise<string>`）を Task 3 が `logPath` として使う。Rust 側の戻り値も `Result<String, String>` で一致
- `cleanIsbn`（Task 2 Step 4 で export）を同 Step 5 が import する
