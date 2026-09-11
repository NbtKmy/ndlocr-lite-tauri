# CiNii Books ID 付き目次JSONL 出力（埋め込みなし）設計仕様

- 作成日: 2026-09-09
- 対象バージョン: v0.17.0 〜 v0.17.1
- 状態: 実装済み（v0.17.0 で導入、v0.17.1 で `http_get` タイムアウト対応と単一 OR クエリ化を追加）

> **v0.19.0 での追記**: 以下2点を変更した。詳細は各該当節を参照。
> 1. `toc[].seq` を内部 `seq`（永続キー）から切り離し、配列順の 1 始まり表示用連番に振り直すようにした（§3.1）。
> 2. 「承認後に編集した場合の扱い」（§7）で述べていた「画面の内容と出力内容が食い違う」問題を解消した。
>    ReviewView が出力済み書籍を開き直す際に `review.json` を優先して読み込み、その後の編集も自動保存で
>    `review.json` に反映されるようになったため、D1（出力対象は `review.json` のみ）は維持しつつ、
>    その `review.json`自体が編集内容を常に反映するようになった。

## 1. 目的と背景

既存の JSONL 出力（`books.jsonl` / `entries.jsonl`）は postgres 投入を前提としており、bge-m3 の 1024 次元ベクトルを各レコードに埋め込んでいる。このため 1 書籍あたりのデータ量が大きく、ベクトルを必要としない用途（他機関へのデータ提供、書誌同定作業、目次データの単純な受け渡し）には扱いにくい。

そこで、埋め込みを含まず、書誌の同定キーとして CiNii Books ID（NCID）を付与した軽量な出力形式を追加する。1 書籍 1 レコードとし、目次データをそのレコードの入れ子として持たせることで、書誌と目次の対応を 1 行で完結させる。

## 2. スコープ

### やること

- CiNii Books OpenSearch API を ISBN で照会し、NCID を取得する
- 書誌 4 項目（タイトル・出版年・ISBN・NCID）と目次データを入れ子にした JSONL を出力する
- 照会結果と出力結果を突合できるテキストログを出力する
- ReviewView に独立した出力ボタンを追加する

### やらないこと

- 既存の `books.jsonl` / `entries.jsonl` の形式変更（一切触らない）
- 既存の承認フロー（`approve` / `retryEmbed`）の変更
- ReviewView の `load()` 処理・`phase` 状態機械の変更
- InboxView からの一括出力（将来の拡張として第 11 章に記載）
- CiNii から取得できる書誌情報（`dc:title`、`dc:publisher` 等）の出力への取り込み。NCID のみを採用する

## 3. 出力仕様

出力先ディレクトリは既存の `src/utils/outputConfig.ts` の `outputDir` 設定をそのまま使う。未設定時は Rust 側のデフォルト（`~/Library/Application Support/com.nobu.ndltococr/data/output/`）となる。

### 3.1 `cinii_books.jsonl`

1 行 1 書籍。`book_id`（MMS ID）をキーとして upsert する。既存の Tauri コマンド `upsert_output_records` は `book_id` フィールドで既存行を削除してから追記する実装のため、**そのまま流用でき、再出力しても行が重複しない**。

```jsonc
{
  "book_id": "991234567890",
  "cinii_ncid": "BB08395220",
  "title": "夕陽カ丘三号館",
  "pub_year": "2012",
  "isbn": ["9784167137113"],
  "exported_at": "2026-09-09T20:52:26+09:00",
  "toc": [
    { "seq": 1, "level": 1, "heading_text": "第一章 転居", "page_number": 5, "contributor": null },
    { "seq": 2, "level": 2, "heading_text": "三号館の住人たち", "page_number": 12, "contributor": null }
  ]
}
```

フィールドの由来:

| フィールド | 由来 | 備考 |
|---|---|---|
| `book_id` | `SruMetadata.mmsId` | upsert キー |
| `cinii_ncid` | CiNii OpenSearch | 取得できなかった場合はレコード自体を出力しない（第 8 章） |
| `title` | `SruMetadata.titleOriginal ?? titleRomanized` | 原表記を優先。CiNii の `dc:title` は使わない |
| `pub_year` | `SruMetadata.pubYear` | |
| `isbn` | `SruMetadata.isbn` | SRU から得た配列をそのまま。`cleanIsbn` で正規化済み（ハイフン・末尾の付記は除去済み） |
| `exported_at` | 出力処理の開始時に 1 回生成 | ISO8601（オフセット付き）。ログ行と同一値 |
| `toc` | `work/{mmsId}/review.json` | 承認時に確定したエントリ（第 6 章） |

`toc` の各要素は `seq` / `level` / `heading_text` / `page_number` / `contributor` の 5 項目のみとする。`ReviewedEntry` が持つ `raw_ocr_text` / `source_page_index` / `confidence` / `reviewed` / `edited` / `embedding` は**出力しない**。人間のレビューを通った確定データを出力対象とするため、OCR の中間情報と信頼度スコアは受け取り側にとって意味を持たない。

**`toc[].seq` は表示用の1始まり連番（v0.19.0）**: `buildCiniiRecord()` は `entries` 配列を順に走査し、その位置（`i + 1`）を `seq` として振り直す。`review.json` / `entries.jsonl` 側の内部 `seq`（`id` = `${book_id}:${seq}` に使われる永続キー）とは意図的に切り離しており、`draft.json` / `review.json` / `entries.jsonl` / `id` は一切変更しない。レビュー画面でエントリを削除すると `EntryEditor.remove()` は詰め直しをしないため内部 `seq` に欠番ができるが（例: 2,3,6,8）、CiNii出力（単体・一括共通）では常に 1,2,3,4 のように詰まった連番として出力する。渡された `entries` 配列自体は非破壊（`buildCiniiRecord` はコピーを返すのみで変更しない）。

### 3.2 `cinii_export.log`

1 イベント 1 行のプレーンテキスト。追記のみ。行頭のタイムスタンプは同じ出力処理で書かれた JSONL レコードの `exported_at` と同一値であり、これによって JSON とログを突合する。

成功時:

```
2026-09-09T20:52:26+09:00 991234567890 OK   ncid=BB08395220 isbn=9784167137113 hits=1 entries=42
2026-09-09T20:53:44+09:00 991236000000 OK   ncid=BA12345678 isbn=9784200000000 hits=3 entries=18 note=複数3件ヒット→先頭採用
```

スキップ時:

```
2026-09-09T20:53:01+09:00 991235000000 SKIP reason=no_hit isbn=9784100000000 hits=0
2026-09-09T20:54:10+09:00 991237000000 SKIP reason=no_isbn
2026-09-09T20:55:02+09:00 991238000000 SKIP reason=not_reviewed
2026-09-09T20:56:33+09:00 991239000000 SKIP reason=api_error isbn=9784300000000 detail=http_get error: 503
```

書式:

- 成功: `{exported_at} {book_id} OK   ncid={ncid} isbn={queriedIsbns} hits={hits} entries={n}`（`queriedIsbns` はカンマ結合。`hits > 1` のときのみ末尾に ` note=複数{hits}件ヒット→先頭採用` を付ける）
- スキップ: `{exported_at} {book_id} SKIP reason={reason}`（`isbn` / `hits` / `detail` は値がある場合のみ付ける。`isbn` は `queriedIsbns` のカンマ結合）
- `OK` の後に半角スペース 2 つを置き、`SKIP` と桁を揃える
- `detail` は値にスペースを含みうるため必ず行末に置く
- `no_hit` の行は `hits > 0` を持つことがある。これは CiNii がいずれかの ISBN に該当するレコードを保持しているが、その `@id` を NCID として解析できなかった場合を意味する（§4.3）

## 4. CiNii Books API 連携

### 4.1 エンドポイント

```
GET https://ci.nii.ac.jp/books/opensearch/search?isbn={isbn1}%20OR%20{isbn2}...&format=json
```

CiNii OpenSearch API は `isbn` パラメータに `OR` 区切りで複数 ISBN を渡せる。ISBN候補は1回のリクエストにまとめて照会する（§4.3）。

既存の Tauri コマンド `http_get`（Rust の reqwest 経由）でフェッチする。ブラウザから直接叩くと CORS で失敗するため、SRU クライアントと同じ方式に揃える。`http_get` は第2引数にタイムアウト（秒）を取れる（コミット `2e0bbbd`）。CiNii 照会は 15 秒で切る（§4.3）。

### 4.2 レスポンスの構造（2026-09-09 実測）

1 件ヒット時:

```jsonc
{
  "@graph": [{
    "@type": "channel",
    "opensearch:totalResults": "1",
    "items": [{
      "@id": "https://ci.nii.ac.jp/ncid/BB08395220",
      "title": "夕陽カ丘三号館",
      "dc:date": "2012",
      "dc:creator": "有吉佐和子著",
      "dc:publisher": ["文藝春秋"],
      "cinii:ownerCount": "15"
    }]
  }]
}
```

0 件ヒット時は `opensearch:totalResults` が `"0"` となり、**`items` キー自体が存在しない**。パーサはこれを前提にガードする。

NCID は `@graph[0].items[0]["@id"]` の末尾パスセグメントから取り出す（`https://ci.nii.ac.jp/ncid/BB08395220` → `BB08395220`）。`rdfs:seeAlso` は `.json` 拡張子が付くため使わない。

### 4.3 ISBN の正規化と単一 OR クエリ

`SruMetadata.isbn` は MARC 020 由来で、ハイフンや `(pbk)` のような付記を含みうる。`src/ai/sru-client.ts` の既存関数 `cleanIsbn`（現在は非公開）を `export` して再利用する。重複実装は作らない。

正規化後、`/^[0-9]{9}[0-9X]$/`（ISBN-10）または `/^[0-9]{13}$/`（ISBN-13）に一致するものだけを照会候補とする（重複は除去）。有効な候補が 1 つもなければ `httpGet` を呼ばず `no_isbn` とする。

候補は先頭から順に照会するのではなく、**`isbn=` パラメータに `OR` 区切りで全て渡して 1 リクエストで照会する**。これにより最悪ケースのリクエスト数が N 回から 1 回に減り、ハングしたリクエストが N 回分のタイムアウトを待つ事態も 1 回分に収まる。タイムアウトは 15 秒（`TIMEOUT_SECS`）に設定する。1 リクエストしか発行しないため、既存の `http_get` デフォルト（30 秒、コミット `2e0bbbd`）より短く切ってよい。

この設計が成立するのは、`SruMetadata.isbn` が MARC **020 $a のみ**（`src/ai/sru-client.ts:191` の `getSubfields('020', 'a')`。`$z`＝廃番ISBNは含まない）から来ているため。つまり候補群は常に**同一著作の ISBN**（版・巻単位で異なる manifestation を指す場合はあり得る）であり、どの候補がヒットしても等価に採用してよい。

CiNii の返却順は問い合わせ順と一致しない（実測: `9784167137113 OR 9784101132150` で問い合わせても `9784101132150` の記録が先頭で返る）。この事実は候補順に意味があれば問題になるが、上記の理由（全候補が同一著作）により候補順自体に優先度はなく、`items[0]` を採用する判断は従来のロジック（先頭ヒットを採用）と同様に妥当である。

どの候補がヒットしたかを `dcterms:hasPart`（`urn:isbn:...`）と文字列比較して特定することは行わない。実測では 13 桁 ISBN で照会しても `hasPart` が 10 桁形式で返る場合があり、フォームが異なると単純な文字列一致では判定できず、ISBN-10↔13 変換（チェックディジット計算含む）が必要になる。ログの 1 フィールドのためにその実装コストを払う価値はないため、`queriedIsbns` には「照会した ISBN 群」を記録するのみとし、「どれがヒットしたか」は追跡しない。

通信エラー・レスポンス解析失敗はいずれも `api_error` とする（1 リクエストしかないため、成功/失敗の混在は起こらない）。

### 4.4 インターフェース

```ts
// src/ai/cinii-client.ts

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

export async function lookupCiniiNcid(isbns: string[]): Promise<CiniiLookup>
```

NCID の形式は `/^[A-Za-z0-9]+$/` で軽く検証する。これに一致しない値が返ってきた場合は `ncid` を `null` とするが、`hits` は書き換えずそのまま保持する（`parseCiniiResponse`）。これにより「CiNii がいずれの ISBN のレコードも保持していない」（`hits === 0`）と「保持しているが `@id` を NCID として解析できない」（`hits > 0` かつ `ncid: null`）を区別できる（§3.2・§8）。

## 5. モジュール構成

### 新規ファイル

| パス | 責務 |
|---|---|
| `src/ai/cinii-client.ts` | ISBN → CiNii OpenSearch → NCID。HTTP とレスポンス解析のみ。ファイル書き込みを持たない |
| `src/output/ciniiExport.ts` | レコード組立・JSONL 書き込み・ログ書き込み。CiNii 照会は `cinii-client` に委譲 |
| `src/__tests__/ciniiClient.test.ts` | 照会ロジックのユニットテスト |
| `src/__tests__/ciniiExport.test.ts` | レコード組立とログ書式のユニットテスト |
| `src/__tests__/fixtures/ciniiResponses.ts` | API レスポンスのフィクスチャ 3 種を JSON 文字列として `export`。1 件ヒット・0 件（`items` キーなし）は実測値、複数ヒットは 1 件ヒットの `items` を 3 件に増やした加工版。`tsconfig.app.json` に `resolveJsonModule` がないため `.json` ではなく `.ts` にする |

### 変更ファイル

| パス | 変更内容 |
|---|---|
| `src/pipeline/types.ts` | `CiniiTocEntry` / `CiniiBookRecord` 型を追加 |
| `src/pipeline/api.ts` | `appendOutputText` ラッパーを追加 |
| `src-tauri/src/lib.rs` | `append_output_text` コマンドを追加し `invoke_handler` に登録 |
| `src/ai/sru-client.ts` | `cleanIsbn` を `export` に変更（実装は変えない） |
| `src/views/ReviewView.tsx` | ボタン・`ciniiMessage` / `ciniiBusy` state・`handleExportCinii` を追加 |
| `package.json` / `src/components/layout/Header.tsx` / `src/utils/exportTEI.ts` | バージョンを v0.17.0 に更新 |
| `README.md` / `CLAUDE.md` / `docs/output-schema.md` | 第 10 章参照 |
| `src-tauri/src/lib.rs` | `http_get` に第2引数（タイムアウト秒）を追加（コミット `2e0bbbd`） |
| `src/pipeline/api.ts` | `httpGet` の第2引数（タイムアウト秒）を追加（コミット `2e0bbbd`） |

### 型定義

```ts
// src/pipeline/types.ts

/** cinii_books.jsonl の目次エントリ（OCR中間情報・信頼度・埋め込みを含まない） */
export interface CiniiTocEntry {
  seq: number
  level: number
  heading_text: string
  page_number: number | null
  contributor: string | null
}

/** cinii_books.jsonl の1レコード */
export interface CiniiBookRecord {
  book_id: string
  cinii_ncid: string
  title: string | null
  pub_year: string | null
  isbn: string[]
  exported_at: string
  toc: CiniiTocEntry[]
}
```

### Rust コマンド

```rust
/// プレーンテキストを1行追記し、書き込んだファイルの絶対パスを返す
#[tauri::command]
async fn append_output_text(
    app: AppHandle,
    file: String,
    text: String,
    output_dir: Option<String>,
) -> Result<String, String>
```

- 出力先ディレクトリの解決は既存の `append_output_record` と同一ロジック（`output_dir` が空でなければそれを使い、そうでなければ `data_dir(&app).join("output")`）
- `file` に `/`、`\`、`..` が含まれる場合はエラーを返す（`read_model_file` と同じ防御）
- `fs::create_dir_all` でディレクトリを作成
- `OpenOptions::new().append(true).create(true)` で開き、`text` の末尾に改行がなければ付けて書き込む
- 戻り値は書き込んだファイルの絶対パス。UI のメッセージ表示に使う

既存の `append_output_record` は JSON 値を受け取って `serde_json` でシリアライズする実装であり、プレーンテキストは扱えない。そのため新規コマンドを追加する。

```ts
// src/pipeline/api.ts に追加
appendOutputText: (file: string, text: string, outputDir?: string) =>
  invoke<string>('append_output_text', { file, text, outputDir: outputDir ?? null }),
```

## 6. 処理フロー

```
[CiNii JSON出力] ボタン押下
  → exportedAt を1回生成（ISO8601 オフセット付き）
  → pipeline.readStage<ReviewedEntry[]>(bookId, 'review')
      ├ 失敗 or 0件 → SKIP reason=not_reviewed → ログ追記 → 終了
      └ 成功 → 確定エントリを取得
  → lookupCiniiNcid(sruMeta.isbn)  ※候補群を OR で1リクエストにまとめて照会
      ├ 有効候補なし          → SKIP reason=no_isbn    → ログ追記 → 終了
      ├ 0件（ncid取得不可）   → SKIP reason=no_hit     → ログ追記 → 終了
      ├ 通信・解析失敗        → SKIP reason=api_error  → ログ追記 → 終了
      └ ヒット（ncid 取得）   → NCID 採用（hits > 1 なら先頭）
  → CiniiBookRecord を組み立て（toc は5項目に絞る）
  → pipeline.upsertOutputRecords('cinii_books.jsonl', bookId, [record], outputDir)
  → ログ追記（OK 行）
      ├ 成功 → logPath / jsonlPath を設定
      └ 失敗 → レコードは書き込み済みのため例外を伝播させず、
               status は 'ok' のまま logWriteError に詳細を残す（logPath / jsonlPath は未設定）
  → UI にメッセージ表示
```

**出力対象は常に `review.json`**。画面上の `entries` state は使わない。これは第 9 章の決定 D1 に基づく。

### インターフェース

```ts
// src/output/ciniiExport.ts

export type CiniiSkipReason = 'not_reviewed' | 'no_isbn' | 'no_hit' | 'api_error'

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

export async function exportCiniiBook(
  bookId: string,
  sruMeta: SruMetadata,
  /** テスト時に固定時刻を注入する */
  now?: Date
): Promise<CiniiExportResult>
```

ISO8601 のオフセット付き整形はローカル関数として実装し、テスト用に `export` する:

```ts
export function toIsoWithOffset(d: Date): string
```

`Date.prototype.toISOString()` は UTC の `Z` 表記になりログの可読性が落ちるため使わない。

UI メッセージ用のパスは、`append_output_text` が返したログの絶対パスをディレクトリと区切り文字（`/` または `\`）に分解し、`{dir}{sep}cinii_books.jsonl` として `jsonlPath` を組み立てる。区切り文字を固定で `/` とすると Windows のパス（`\` 区切り、`/` を含まない）で破綻するため、区切り文字も元のパスから採用する。

呼び出し側（ReviewView）は既存の `PDF出力` と同じく `sruMeta ?? makeFallbackMeta(bookId)` を渡す。フォールバックメタデータは `isbn` が空配列になるため、その場合は `no_isbn` としてスキップされる。

## 7. UI 仕様

ReviewView のヘッダー（`.review-header-actions`）に `CiNii JSON出力` ボタンを追加する。既存の `PDF出力` ボタンの隣に置き、クラスは `btn-secondary` を使う。

- `ciniiBusy` が真の間は `disabled` にし、ラベルを `CiNii照会中…` に変える
- 結果は `ciniiMessage` state に入れ、既存の `.progress-text` クラスで表示する。`pdfMessage` とは別 state にする（同時に押した際に互いを潰さないため）

表示条件は `phase === 'review'` と `phase === 'done'` の両方だが、**両者は描画箇所が異なる**。`src/views/ReviewView.tsx` の `if (phase === 'done')` ブロックは早期リターンで `.review-done` 画面を返すため、ヘッダーを描画しない。したがって:

- `phase === 'review'` → ボタンは `.review-header-actions` 内、`PDF出力` ボタンの隣。メッセージは `pdfMessage` / `progress` と同じ `.progress-text` の `<span>` として、ヘッダー本体とは別の `.review-message-row`（`.review-header` の直後に続く独立した行）に表示する（後述）
- `phase === 'done'` → `.review-done` 画面 2 種（`embedFailed` 時の「⚠️ 埋め込みなしで出力済み」と通常の「✅ 承認完了」）それぞれの `.review-done-actions` 内。メッセージは `.progress-text` の `<p>` として表示。通常の承認完了画面は現在 `.review-done-actions` のラッパーを持たないため追加する

ボタンの JSX は早期リターンより前に変数として組み立て、3 箇所から参照して重複を避ける。

**メッセージ行の分離（review フェーズ）:** CiNii 成功メッセージは絶対パスを含み最大139文字になる。`.review-header-actions` は `min-width: 0` を持たないためこれ以上縮まず、`.review-title` が先に潰れてからヘッダーが横に溢れ、承認ボタンが押し出される。この事象は既存の `pdfMessage`（106文字）でも既に発生していた。そのため `pdfMessage` / `ciniiMessage` / `progress`（review フェーズ用途分のみ）を `.review-header-actions` から取り出し、ヘッダー直下の `.review-message-row` に独立させた。`save-status` はボタン群と同じ行に残す（6文字と短く操作の一部として扱えるため）。

メッセージ文言:

| 結果 | 文言 |
|---|---|
| `ok`（`hits === 1`） | `CiNii JSON出力しました: {jsonlPath}（承認時の確定データ {entryCount}件 / ncid={ncid}）` |
| `ok`（`hits > 1`） | 上記に加えて末尾に `（{hits}件ヒット→先頭採用）` |
| `ok`（ログ書き込み失敗） | `cinii_books.jsonl にレコードを出力しましたが、ログ書き込みに失敗しました: {logWriteError}` |
| `not_reviewed` | `未承認です。「承認 → 出力」を実行してから押してください` |
| `no_isbn` | `ISBNがないためCiNii照会できません（ログ記録: {logPath}）` |
| `no_hit` | `CiNii IDが見つかりませんでした。JSONには出力していません（ログ記録: {logPath}）` |
| `api_error` | `CiNii API エラー: {detail}（ログ記録: {logPath}）` |

スキップは業務上の正常な結果であり、`.error` 系の赤表示にはしない。`.progress-text` のまま表示する。

### 承認後に編集した場合の扱い（v0.19.0 で変更）

**旧仕様（v0.17.0〜v0.18.x）**: ReviewView は承認済み（status = `exported`）の書籍を開き直すと `draft.json` から読み込んで `phase = 'review'` に戻っていた（`readStage(bookId, 'draft')` のフォールバック分岐）。このため、承認後に画面上でエントリを編集してから CiNii 出力を押すと、画面の内容と出力内容（`review.json`）が食い違う問題があった。当時はこれを仕様として受け入れ、メッセージに「承認時の確定データ」と明示することで誤解を防ぐ方針を取っていた。

**現行仕様（v0.19.0〜）**: この食い違いを解消した。
- `load()` は status が `exported` / `exported_no_embed` のとき `review.json` を優先して読み込む（無い・空・読めない場合のみ `draft.json` にフォールバック）。
- 出力済み書籍を編集した場合、entries変更のデバウンス自動保存が `draft.json` に加えて `review.json` にも書き込む（`reviewed: true` を付与）。
- これにより、画面で編集した内容は自動保存のたびに `review.json` に反映され、CiNii出力（単体・一括）は常にその時点の最新内容を読む。D1（出力対象は `review.json` のみ、画面 state の `entries` は使わない）自体は変更していない。`review.json` そのものが編集を追随するようになっただけである。
- ただし `entries.jsonl` / `books.jsonl`（bge-m3 埋め込み込みの正式出力）は自動更新しない（埋め込み計算のコストが高いため）。ReviewView ヘッダーに「JSONL未再出力」バッジを表示し、「JSONL再出力（埋め込み付き）」ボタンで手動反映する運用とした。

## 8. スキップ条件一覧

| reason | 条件 | JSONL | ログ |
|---|---|---|---|
| `not_reviewed` | `review.json` が読めない、またはエントリが 0 件 | 出力しない | 記録する |
| `no_isbn` | `SruMetadata.isbn` に ISBN-10/13 の形式に合う値が 1 つもない | 出力しない | 記録する |
| `no_hit` | NCID を取得できない（`opensearch:totalResults` が 0、または `hits > 0` だが `@id` を解析できない） | 出力しない | 記録する |
| `api_error` | 単一リクエストの `http_get` または JSON パースが失敗 | 出力しない | 記録する |

いずれの場合も例外を投げず `CiniiExportResult` を返す。ログ書き込み自体が失敗した場合、スキップパス（`skip()`）では何も書き込まれていないため例外を呼び出し元に伝播させ、ReviewView は `CiNii出力エラー: {e}` を表示する。一方、成功パスは `cinii_books.jsonl` へのレコード書き込みが既に完了しているため、ログ書き込み失敗を例外として伝播させると「何も出力されなかった」と誤解させてしまう。そこで成功パスに限り例外を握り、`status: 'ok'` のまま `logWriteError` に詳細を残す（`logPath` / `jsonlPath` は未設定）。ReviewView はこれを検出し、レコードは書けたがログ書き込みには失敗した旨を明示するメッセージを表示する。

## 9. 決定事項

- **D1: 出力対象は `review.json` のみ**（画面 state の `entries` は使わない）
  `reviewed` フラグはエントリ単位の人的チェック印として機能していない。LLM 構造化直後と draft 読込時は全件 `false`、承認時は全件 `true` に一括で書き換えられ、EntryEditor の Markdown 編集モードは既存行も含めて `false` に潰す（`src/views/EntryEditor.tsx:40`）。一方で行追加は `true` を付ける（同 `:86`）。したがって `reviewed === true` によるエントリ単位のフィルタは成立しない。
  代わりに「承認を通ったかどうか」を書籍単位で判定する。承認時に `pipeline.writeStage(bookId, 'review', markedEntries)` で書かれる `review.json` の存在がその判定に使え、内容もそのまま確定データとして使える。
  **v0.19.0 での補足**: この決定自体は変わっていないが、`review.json` を更新するタイミングを「承認時のみ」から「出力済み書籍の編集時（自動保存のたび）」にも拡張した（§7）。CiNii出力が読む対象は引き続き `review.json` のみである。

- **D2: `load()` を拡張せず、ボタン押下時に `review.json` を読む**
  承認済み状態を `phase` に反映する案（`load()` で `exported` 系 status を検出して `phase = 'done'` にする）は、承認フロー・draft 自動保存・`CLAUDE.md` の状態機械に波及する。今回の目的には不要なリスクであり、押下時の読み込みで同じ結果が得られる。

- **D3: CiNii の書誌情報は出力に含めず、NCID のみを採用**
  複数ヒット時に先頭を採用した判断が妥当だったかの検証は、ログの `hits` と `ncid` で追跡できる。出力レコードに `cinii_title` 等を持たせるとフィールドの由来が SRU と CiNii で混在し、受け取り側が混乱する。

- **D4: 集約 JSONL 1 ファイル**（1 書籍 1 ファイルの JSON ではない）
  既存の `books.jsonl` と同じ運用にでき、`upsert_output_records` をそのまま流用できる。postgres への投入も既存手順に揃う。

- **D5: ログはプレーンテキスト**（構造化 JSONL ではない）
  照会結果の確認は人間が目視で行う作業であり、`grep` で突合できるテキストのほうが扱いやすい。機械集計の要件は現時点で存在しない。

- **D6: ISBN 候補群は逐次照会せず、`OR` で 1 リクエストにまとめる**（2026-09-09、コミット2）
  `SruMetadata.isbn` は MARC **020 $a のみ**（`$z`＝廃番ISBNを含まない）から来ており、候補群は常に同一著作の ISBN（版・巻単位で異なる manifestation を指す場合はあり得る）である。そのため「どの候補がヒットしたか」に優先度の意味はなく、1 リクエストに OR でまとめて `items[0]` を採用してよい。これにより最悪ケースのリクエスト数が N 回から 1 回に減り、ハングしたリクエストの待ち時間も 1 回分のタイムアウトに収まる。
  返却順は API 依存で問い合わせ順と一致しないことを実測で確認したが（`9784167137113 OR 9784101132150` の問い合わせで `9784101132150` の記録が先頭に来た）、上記の理由により問題にならない。
  どの候補がヒットしたかを `dcterms:hasPart`（`urn:isbn:...`）と文字列比較して特定する案は採用しなかった。実測で 13 桁 ISBN を照会しても `hasPart` が 10 桁形式で返るケースがあり、フォームが異なると文字列一致が失敗する。正しく判定するには ISBN-10↔13 変換（チェックディジット計算）が必要になり、ログの 1 フィールドのために実装するコストに見合わない。

## 10. テスト計画

Vitest。既存の `src/__tests__/` の規約（`*.test.ts`、`vi.mock` によるモジュール差し替え）に合わせる。

### `ciniiClient.test.ts`

`src/pipeline/api.ts` を `vi.mock` し、`pipeline.httpGet` に `src/__tests__/fixtures/ciniiResponses.ts` の `CINII_HIT1` / `CINII_HIT0` / `CINII_HIT3`（JSON文字列を `export` した定数。`tsconfig.app.json` に `resolveJsonModule` がないため `.json` ではなく `.ts`、§5）を返させる。

`parseCiniiResponse`:

- 1 件ヒット（`CINII_HIT1`）から NCID `BB08395220` を抽出する
- 0 件（`CINII_HIT0`、`items` キーなし）でも例外を投げず `{ hits: 0, ncid: null }` を返す
- 複数ヒット（`CINII_HIT3`）で `items[0]` の NCID を採用し `hits` を保持する
- NCID の形式が不正な値は採用せず `ncid: null` を返す

`lookupCiniiNcid`（単一 OR リクエスト、§4.3）:

- 候補が 1 件ならクエリ文字列に `OR` を含まない
- 候補が複数なら `%20OR%20` で連結した 1 本の URL で照会し、`httpGet` は 1 回だけ呼ばれる
- `httpGet` の第 2 引数（タイムアウト秒）に `15` を渡す
- ISBN-10 の末尾 `X`（大文字・小文字とも）を有効な候補として扱い、大文字化して照会する
- 桁数が不正な候補、または候補が空の場合は `httpGet` を呼ばず `{ ncid: null, hits: 0, queriedIsbns: [] }` を返す
- 1 件ヒットなら NCID を採用し、`queriedIsbns` には照会した全候補が入る（採用した1件だけに絞られない）
- 0 件（`CINII_HIT0`）なら `ncid: null, hits: 0` を返し `error` は設定しない
- 複数ヒット（`CINII_HIT3`）なら `items[0]` の NCID を採用し `hits` を保持する
- NCID が解析不能でも `hits` は保持する（CiNii は持っているが ID が読めない場合と、0 件の場合を区別できることの確認。§8 の `no_hit` 条件に対応）
- 通信失敗、または本文が不正な JSON の場合は `error` を設定する
- 正規化後に重複する候補は 1 度だけクエリに含まれる（`httpGet` は 1 回だけ呼ばれる）

### `ciniiExport.test.ts`

`src/pipeline/api.ts` と `src/ai/cinii-client.ts` を `vi.mock` する。`now` に固定 `Date` を注入する。

`toIsoWithOffset`:

- オフセット付き ISO8601 になり `Z` を含まない
- ローカルの年月日時分秒をそのまま使う

`formatLogLine`:

- OK 行（1 件ヒット）
- OK 行（複数 ISBN を照会した場合は `isbn=` がカンマ区切りになる）
- OK 行（複数ヒットは `note=複数N件ヒット→先頭採用` を付ける）
- SKIP 行（`no_hit` / `no_isbn` / `not_reviewed` それぞれの書式）
- SKIP 行（`detail` はスペースを含みうるので必ず行末に置かれる）
- SKIP 行（`detail` に改行が含まれても 1 行に畳む）

`exportCiniiBook`:

- レコード組立: `toc` が 5 項目のみになり、`raw_ocr_text` / `confidence` / `embedding` 等を含まない
- 書誌フィールド（`book_id` / `cinii_ncid` / `title` / `pub_year` / `isbn`）を SRU メタデータから組み立てる
- `titleOriginal` が `null` なら `titleRomanized` を使う
- `exported_at` とログ行のタイムスタンプが同一値になる
- `upsertOutputRecords` が `'cinii_books.jsonl'`、`bookId`、1 要素配列、`outputDir` で呼ばれる
- 成功時は `jsonlPath` をログパスから導出する（Windows 形式の `\` 区切りログパスでも正しく組み立てる）
- `not_reviewed`: `readStage` が reject、または空配列を返す場合、`upsertOutputRecords` を呼ばずログのみ書く
- `no_isbn`: 有効な ISBN がなければ JSONL を書かない
- `no_hit`: ヒット 0 件、および NCID 解析不能（`hits > 0` かつ `ncid: null`）の両方のケースで JSONL を書かない
- `api_error`: 通信失敗なら `detail` を残し JSONL を書かない
- 複数ヒット時は `hits` を保持し、ログに `note=複数N件ヒット→先頭採用` を残す

### 手動確認

- 承認済み書籍で出力 → `cinii_books.jsonl` に 1 行追加、`cinii_export.log` に `OK` 行
- 同じ書籍で再度出力 → 行が重複せず上書きされる
- 未承認書籍で出力 → JSONL に変化なし、ログに `not_reviewed`、画面に未承認メッセージ
- Rust 側は `cargo check` の通過を確認する（コマンド単体のテストは書かない）

## 11. ドキュメント・バージョン更新

同一コミットで更新する。

- `package.json` の `version` を `0.17.0`
- `src/components/layout/Header.tsx` の UI バッジを `v0.17.0`
- `src/utils/exportTEI.ts` の TEI メタデータ `version` 属性を `0.17.0`
- `README.md`: 変更履歴に v0.17.0 の項を追加
- `CLAUDE.md`: ディレクトリ構成に `cinii-client.ts` / `ciniiExport.ts` を追記、パイプライン処理フローのデータパスに `cinii_books.jsonl` / `cinii_export.log` を追記、開発フェーズのチェックリストに項目を追加
- `docs/output-schema.md`: `cinii_books.jsonl` のスキーマとログ書式を追記
- v0.17.1: `http_get` のタイムアウト対応（コミット `2e0bbbd`）と CiNii 照会の単一 OR クエリ化（コミット `2eeca2e`）に伴うバージョン更新

## 12. 将来の拡張（今回はやらない）

- ~~InboxView からの一括出力~~ → v0.18.0 で実装済み（第13章）
- 複数ヒット時のユーザー選択ダイアログ。タイトル・出版年・出版社・`cinii:ownerCount` を並べて選ばせる
- NCID を既存の `books.jsonl` にも付与する

## 13. CiNii JSON一括出力（v0.18.0）

- 作成日: 2026-09-10
- 対象バージョン: v0.18.0

### 13.1 目的

第12章で挙げた将来拡張のうち「InboxViewからの一括出力」を実装する。単体出力（第6章〜第8章）は
ReviewViewで書籍を1冊ずつ開いて出力する運用のため、承認済み書籍が多いと1冊ごとに画面遷移して
ボタンを押す手間がかかる。InboxViewの書籍一覧から複数書籍を選択し、1回の操作でまとめて出力できる
ようにする。

### 13.2 単体出力との違い

| 項目 | 単体出力（第3〜8章） | 一括出力（本章） |
|---|---|---|
| 起点画面 | ReviewView（1冊を開いた状態） | InboxView（書籍一覧、複数選択） |
| 出力先 | `cinii_books.jsonl`（upsert） | `cinii_batch_YYYYMMDD-HHmmss.json`（新規ファイル、JSON配列） |
| NCID解決 | 常にCiNii照会 | `cinii_books.jsonl` に既知NCIDがあれば再利用、なければ照会（ハイブリッド） |
| `cinii_books.jsonl` への反映 | 常にupsert | 新規に照会した書籍のみupsert（再利用時はupsertしない） |
| 対象書籍の判定 | 呼び出し元（ReviewView）が渡した1冊 | `status` が `approved` / `exported` / `exported_no_embed` の書籍のみ選択可能 |

レコード組立（`review.json` + `sruMeta` → `CiniiBookRecord`）と出力先ディレクトリ解決
（`loadOutputConfig().outputDir`）は `src/output/ciniiExport.ts` から関数として抽出し
（`buildCiniiRecord` / `outputDir` / `CINII_FILE` / `LOG_FILE` / `formatLogLine` / `toIsoWithOffset`
を export）、単体出力（`exportCiniiBook`）と一括出力（`exportCiniiBatch`）の両方で使う。
単体出力側の外部挙動・返り値・ログ書式は変更していない（既存テストがそのまま通る）。

### 13.3 NCID解決のハイブリッド方式

一括出力の対象書籍が多いと、CiNii OpenSearch API への連続アクセスになる（第12章で懸念していた点）。
これを緩和するため、実行開始時に `cinii_books.jsonl` を1回だけ読み、`book_id → cinii_ncid` の
Mapを作る。各書籍の処理では:

- Mapにヒット（既に単体出力または過去の一括出力でNCIDが判明している）→ CiNii照会をスキップしてそのNCIDを再利用。`cinii_books.jsonl` へのupsertも行わない（内容は変わらないため）
- Mapにヒットしない → `lookupCiniiNcid(sruMeta.isbn)` で照会し、成功したら結果を `cinii_books.jsonl` にもupsertする（次回以降の一括出力・単体出力で再利用できるようにする）

`cinii_books.jsonl` が存在しない場合（`readOutputFile` が reject）は空Mapとして扱い、全件照会にフォールバックする。壊れた行（JSONとして parse できない行）は無視して続行する。

`toc` はNCIDを再利用した場合でも必ずその時点の `review.json` から組み立て直す。`cinii_books.jsonl`
の既存行の `toc` を引き継ぐことはしない。承認後にレビューし直した書籍があっても、一括出力の結果には
最新の目次が反映される。

これによりリクエスト間隔の制御は不要になる場合が多い（既知の書籍は照会自体が発生しない）。全件が
未照会の初回一括出力ではN件のリクエストが発生し得るが、これは単体出力をN回繰り返す場合と同じ負荷
であり、既存の制約（CiNii照会1回15秒タイムアウト、§4.1）の範囲内で許容する。明示的なリクエスト間隔
制御（レート制限）は今回も実装しない。

### 13.4 出力ファイル

`cinii_batch_YYYYMMDD-HHmmss.json`（ローカル時刻、生成時に1回だけ決定）に、成功した書籍の
`CiniiBookRecord` を配列として書き込む。既存の `append_output_text` をそのまま使い、新しいファイル名
のため実質新規作成になる。成功0件のときはファイルを作らない。

ファイル名は秒まで含める。`append_output_text` の実装（Rust側 `OpenOptions::new().append(true)`）は
追記のため、分単位のファイル名（`cinii_batch_YYYYMMDD-HHmm.json`）だと「一括出力 → 選択を変えて
もう一度」のような同一分内の2回目の実行が既存ファイルの末尾に2つ目の配列を追記してしまい、
`[...]\n[...]` という不正なJSONになる。この事象は実装レビューで発見され（2026-09-10）、秒まで含める
ことで解消した。

```jsonc
[
  { "book_id": "991234567890", "cinii_ncid": "BB08395220", "title": "...", "pub_year": "2012",
    "isbn": ["9784167137113"], "exported_at": "2026-09-10T14:05:00+09:00", "toc": [ /* ... */ ] },
  { "book_id": "991234567891", "cinii_ncid": "BA12345678", "...": "..." }
]
```

### 13.5 ログ

`cinii_export.log` に書籍ごとの行（`formatLogLine` を再利用、書式は第3.2章と同一）を追記し、
実行の最後に集計行を1行追記する:

```
2026-09-10T14:05:00+09:00 991234567892 OK   ncid=BB09999999 isbn=9784167137113 entries=12 note=ncid再利用
2026-09-10T14:05:00+09:00 BATCH file=cinii_batch_20260910-140500.json ok=3 skip=1
```

NCIDを再利用した書籍（CiNiiに照会していない）は `hits=` を持たず、末尾に `note=ncid再利用` が付く。
`isbn=` はこの場合「照会したISBN」ではなく `SruMetadata.isbn` をそのまま使う（どの書籍のISBNかを
ログに残すため、第2章の元の設計では `queriedIsbns` のみ想定していたが実装レビューで追加した）。
`formatLogLine` の ok 分岐は元は `isbn=${r.queriedIsbns?.join(',')}` / `hits=${r.hits}` を
無条件に push していたため、再利用時（両方 `undefined`）に `isbn=undefined hits=undefined` という
文字列がログに出力される不具合があった（実装レビューで発見、2026-09-10）。SKIP分岐と同様に
`r.queriedIsbns?.length` / `r.hits !== undefined` の条件を付けて修正した。単体出力
（`exportCiniiBook`）は ok 時に常に両方の値を持つため、この修正で単体出力側の出力は変わらない
（既存テストがそのまま通ることを確認済み）。

実装上は、書籍ごとの行を配列に溜めてから改行結合し、`appendOutputText` を1回だけ呼ぶ
（`append_output_text` は内部の改行を保持するため、複数行を1回の呼び出しで追記できる）。これにより
ログ書き込み失敗が単一の `logWriteError` に集約され、単体出力（`exportCiniiBook`）と同じ「レコードは
書けたがログ書き込みに失敗した」という区別ができる。書籍ごとに個別の `appendOutputText` 呼び出しに
する案（ディスクI/O回数は増えるが失敗箇所をより細かく特定できる）は採用しなかった。件数が多いときの
呼び出し回数増加を避け、失敗時の状態（「JSON配列は書けたがログだけ失敗した」）を単体出力と揃えられる
ためである。

### 13.6 UI（InboxView）

- 書籍一覧の各カードに、`status` が `approved` / `exported` / `exported_no_embed` の書籍のみ
  チェックボックスを表示する（`BookCard` に `ciniiEligible` / `selected` / `onToggleSelect` /
  `selectDisabled` props を追加）
- 一覧の上に選択件数表示・「全選択」「全解除」・「選択をCiNii JSON一括出力（N件）」ボタンを持つ
  `.cinii-batch-panel` を配置する。実行中はボタンが `照会中… i/N` に変わり disabled になる
- 各書籍の `sruMeta` は `pipeline.readStage(bookId, 'sru_meta')` で個別に取得する。読めない書籍は
  `exportCiniiBatch` に渡さず、UI側で「書誌情報未取得のため対象外」件数として別途表示する
  （`exportCiniiBatch` 自体は渡された対象に `sruMeta` が既にある前提で動くため、コアモジュールに
  新しいスキップ理由を追加する必要がない）
- 結果表示は「出力 N件 / スキップ M件」+ 出力ファイルの絶対パス + スキップした書籍ごとの理由一覧
- 書籍の削除や状態変化で選択対象から外れた `book_id` は選択状態から自動的に除去する

### 13.7 型

```ts
// src/pipeline/types.ts
// CiniiSkipReason は単体出力時代の型をそのまま移動（ciniiExport.ts から re-export して既存 import を壊さない）
export type CiniiSkipReason = 'not_reviewed' | 'no_isbn' | 'no_hit' | 'api_error'

export interface CiniiBatchItemResult {
  bookId: string
  status: 'ok' | 'skipped'
  reason?: CiniiSkipReason
  detail?: string
  ncid?: string
  ncidReused?: boolean
  entryCount?: number
}

export interface CiniiBatchResult {
  exportedAt: string
  filePath?: string
  fileName?: string
  okCount: number
  skipCount: number
  items: CiniiBatchItemResult[]
  logPath?: string
  logWriteError?: string
}
```

```ts
// src/output/ciniiBatchExport.ts
export interface CiniiBatchTarget {
  bookId: string
  sruMeta: SruMetadata
}

export async function exportCiniiBatch(
  targets: CiniiBatchTarget[],
  now?: Date,
  onProgress?: (done: number, total: number) => void
): Promise<CiniiBatchResult>
```

### 13.8 テスト

`src/__tests__/ciniiBatchExport.test.ts`。既存の `ciniiExport.test.ts` と同じ `vi.mock` 方式
（`pipeline` / `lookupCiniiNcid` / `loadOutputConfig` をモック、`now` を固定 `Date` で注入）。

- 既存 `cinii_books.jsonl` にNCIDがある書籍は `lookupCiniiNcid` を呼ばず、upsertもしない
- 未出力の書籍は照会され、`cinii_books.jsonl` にもupsertされる
- 再利用と新規照会が1回の実行内で混在するケース
- `review.json` が読めない・空配列の書籍は `not_reviewed` でスキップされ、出力JSONに含まれない
- 1書籍の `api_error` で他書籍の処理が継続する（`no_isbn` / `no_hit` も同様）
- 出力JSONが配列であること、各要素が `CiniiBookRecord` の形であること、`toc` が `review.json` の
  最新内容になること（既存jsonl行の古い `toc` を引き継がないこと）
- ファイル名が `cinii_batch_YYYYMMDD-HHmmss.json` 形式（秒付き）になること
- 同一分内でも秒が異なれば別ファイル名になること（同一分2回実行での追記破損を防ぐ回帰テスト）
- ログに書籍ごとの行と `BATCH` 集計行が書かれること
- NCID再利用書籍のログ行に `undefined` という文字列が含まれず、`isbn=` に `sruMeta.isbn` が入り
  `note=ncid再利用` が付くこと
- 新規照会書籍のログ行は従来どおり `isbn=` と `hits=` を含み `note=ncid再利用` を含まないこと
- 成功0件のときはJSONファイルを作らないこと
- `cinii_books.jsonl` が未存在（`readOutputFile` が reject）でも全件照会にフォールバックすること
- `cinii_books.jsonl` の壊れた行を無視して続行すること
- `onProgress` が処理済み件数を通知すること
- ログ書き込み失敗時に `logWriteError` に残り、レコード（JSON配列ファイル）自体は失われないこと

`src/__tests__/ciniiExport.test.ts` にも、`formatLogLine` の ok 分岐で `queriedIsbns` / `hits` が
`undefined` のとき `isbn=` / `hits=` を出さず `undefined` という文字列も出力しないことを確認する
テストを追加した（単体出力では実際には発生しないケースだが、一括出力と共有する関数のため回帰を防ぐ）。

### 13.9 ドキュメント・バージョン更新

- `package.json` / `Header.tsx` / `exportTEI.ts` のバージョンを `0.18.0` に更新
- `README.md` の変更履歴に v0.18.0 の項を追加
- `CLAUDE.md`: ディレクトリ構成に `ciniiBatchExport.ts` を追記、パイプライン処理フローとデータパスに
  一括出力・`cinii_batch_*.json` を追記、開発フェーズのチェックリストに項目を追加
- `docs/output-schema.md`: `cinii_batch_YYYYMMDD-HHmmss.json` の形式と `BATCH` ログ行の書式を追記

**2026-09-10 追記（実装レビュー後の修正、バージョンは0.18.0のまま）:** 上記のファイル名の秒付き化と
`formatLogLine` の `isbn=undefined hits=undefined` 修正は、コミット前の実装レビューで発見された。
まだコミットしていない同一機能内の修正のため、バージョン番号は上げていない。
