# 出力スキーマ（postgres投入用）

> このファイルはアプリの**実出力仕様**であり、`src/pipeline/types.ts` の `OutputBook` /
> `OutputEntry` が唯一の真実（source of truth）。DBプロジェクト（検索システム）はこのJSONLを
> そのまま取り込める前提で設計する。DB側の設計判断は `DESIGN_forDB.md` を参照。

## ファイル構成

```
data/output/
  books.jsonl   … 1行1書籍
  entries.jsonl … 1行1目次エントリ（pgvector想定）
  toc_pdf/{book_id}.pdf … 目次PDF（1書籍1ファイル、任意生成。DB取り込み対象外）
```

`toc_pdf/{book_id}.pdf` はDB投入用JSONLとは独立した補助出力（ReviewViewから手動生成）。
見出し（階層インデント）と各節の著者名（`contributor`、ある場合のみ）を1書籍1PDFにまとめたもので、
ページ番号は含まない。books.jsonl / entries.jsonl のスキーマには影響しない。

## books.jsonl

SRU（MARC-XML）由来の書誌・所蔵メタデータを含む。`OutputBook`（`src/pipeline/types.ts`）と一致。

```json
{
  "book_id": "string",            // MMS ID（Primo VE のディープリンクキー）
  "source_pdf": "string",         // 目次PDFのURL
  "isbn": ["string"],             // ISBN（複数可）
  "title_original": "string|null",  // 880（原表記）★主検索キー
  "title_romanized": "string|null", // 245（翻字）
  "subtitle": "string|null",
  "creator_original": "string|null",  // 880
  "creator_romanized": "string|null", // 100/700
  "publisher": "string|null",
  "pub_place": "string|null",
  "pub_year": "string|null",      // MARC由来の文字列（"c2026","[2026]","昭和27年"等あり得る）
  "subjects": ["string"],         // 6XX（原表記優先）
  "classification": ["string"],   // 084/082/050
  "toc_pdf_url": "string|null",
  "call_number": "string|null",
  "location": "string|null",
  "holding_library": "string|null",
  "holding_status": "string|null",
  "source": "string",
  "page_count": 12,               // 目次PDFのページ数
  "ocr_model_version": "1.0.0",   // NDL OCRモデルバージョン
  "llm_model": "string",          // 校正・構造化に使用したOllamaモデル名
  "embed_model": "bge-m3",        // 埋め込みモデル名
  "embed_dim": 1024,              // 埋め込み次元数
  "processed_at": "string",       // 処理日時（形式は要確認。取り込み前に実値を1件確認すること）
  "embedding": [/* 1024 floats, 省略可 */]  // 書籍レベルベクトル。埋め込み失敗時は欠損
}
```

## entries.jsonl

`OutputEntry`（`src/pipeline/types.ts`）と一致。

```json
{
  "id": "book_id:seq",          // 一意ID（※seqは再レビューで振り直され得る。下記注意参照）
  "book_id": "string",          // 書籍ID（books.jsonl の book_id と一致）
  "seq": 7,                     // エントリ通し番号（1始まり）
  "level": 2,                   // 階層（1=部, 2=章, 3=節, 4=項）
  "heading_text": "string",     // 校正・確定済み見出しテキスト（主検索キー）
  "page_number": 23,            // 開始ページ番号（不明時はnull）
  "contributor": "string|null", // 章の著者名（なければnull）
  "raw_ocr_text": "string",     // 生OCRテキスト（監査用、空のこともある）
  "source_page_index": 2,       // 元PDFの何ページ目（0始まり）
  "confidence": 0.87,           // OCR信頼度推定値
  "reviewed": true,             // 人によるレビュー済みか
  "edited": false,              // 人が手修正したか
  "embedding": [/* 1024 floats, 省略可 */]  // bge-m3 埋め込み。埋め込み失敗時は欠損
}
```

## 注意事項（DB取り込み時）

- **`embedding` は欠損し得る。** 埋め込み失敗時（アプリの `exported_no_embed` ステータス）、
  books・entries は埋め込みなしで出力される。DBの `embedding` カラムは **nullable** とし、
  欠損レコードを拒否しないこと。セマンティック検索は `WHERE embedding IS NOT NULL` で対象を絞る。
- **`entries.id` は再処理で不安定。** `id = "{book_id}:{seq}"` で、再レビュー時に seq が
  振り直されるため id が変わる。書籍の再取り込みは「該当 `book_id` の entries を全DELETE →
  全INSERT」をトランザクション内で行う（id単位のupsertにしない）。
- **`pub_year` は文字列。** integer への一律変換は不可逆で危険。原文を `pub_year_raw` に保持し、
  4桁年が明確に抽出できる場合のみ `pub_year integer` に格納する。
- `embed_dim` はモデル設定依存。変更時はpgvectorの `vector(N)` も変更が必要。
- 詳細なテーブル定義・索引方針（MVPは厳密KNN・索引なし）・検索/ファセット設計は `DESIGN_forDB.md` を参照。
