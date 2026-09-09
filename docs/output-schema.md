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
  cinii_books.jsonl … 1行1書籍。CiNii Books ID付き・埋め込みなし（任意生成。DB取り込み対象外）
  cinii_export.log  … CiNii照会・出力ログ（任意生成。DB取り込み対象外）
```

`toc_pdf/{book_id}.pdf` はDB投入用JSONLとは独立した補助出力（ReviewViewから手動生成）。
見出し（階層インデント）と各節の著者名（`contributor`、ある場合のみ）を1書籍1PDFにまとめたもので、
ページ番号は含まない。books.jsonl / entries.jsonl のスキーマには影響しない。

`cinii_books.jsonl` / `cinii_export.log` も同様に独立した補助出力（ReviewViewから手動生成）。
埋め込みを含まない軽量な受け渡し用データで、books.jsonl / entries.jsonl のスキーマには影響しない。

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

## cinii_books.jsonl（補助出力・DB取り込み対象外）

埋め込みを含まない軽量な受け渡し用データ。1行1書籍で、目次データを `toc` に入れ子で持つ。
`CiniiBookRecord`（`src/pipeline/types.ts`）と一致。`book_id` をキーに upsert されるため、
再出力しても行は重複しない。

```jsonc
{
  "book_id": "991234567890",          // MMS ID（upsertキー）
  "cinii_ncid": "BB08395220",         // CiNii Books ID
  "title": "string|null",             // SRU: titleOriginal ?? titleRomanized
  "pub_year": "string|null",          // MARC由来の文字列（"c2026","[2026]"等あり得る）
  "isbn": ["9784167137113"],          // SRUから取得後に正規化済み（ハイフン・末尾の付記は除去済み）
  "exported_at": "2026-09-09T20:52:26+09:00",  // cinii_export.log の行頭と同一値
  "toc": [
    {
      "seq": 1,
      "level": 1,
      "heading_text": "第一章 転居",
      "page_number": 5,               // 開始ページ番号（不明時はnull）
      "contributor": null             // 章の著者名（なければnull）
    }
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
2026-09-09T20:53:44+09:00 991236000000 OK   ncid=BA12345678 isbn=9784200000000,9784101132150 hits=3 entries=18 note=複数3件ヒット→先頭採用
```

ISBNを複数照会した書籍は `isbn=` がカンマ区切りになる（例: 上記3行目の `9784200000000,9784101132150`）。
これは MARC 020 $a に複数の ISBN が記録されている場合で、CiNii へは1リクエストの `OR` 検索としてまとめて照会する
（`src/ai/cinii-client.ts`）。

`reason` は `not_reviewed`（未承認）/ `no_isbn`（有効なISBNなし）/ `no_hit`（CiNiiにヒット0件、または
`hits > 0` だがレコードの `@id` を NCID として解析できない）/ `api_error`（通信・解析失敗）のいずれか。
`no_hit` の `hits` が0より大きい場合は、CiNiiが該当レコードを保持しているがNCIDを読み取れなかったことを意味する。
`detail` は値にスペースを含みうるため必ず行末に置かれる。
また `detail` に含まれる改行（CR/LF）は空白に畳まれるため、1イベントが複数行に分かれることはない。

`hits` は「照会した ISBN 群のいずれかに該当した CiNii レコード件数」であり、1つのISBNに対する件数ではない
（`src/ai/cinii-client.ts` の単一 OR クエリ化以降）。`isbn=` に2件以上を渡した書籍では `hits` が2以上に
なるのは通常の結果であり、`note=複数N件ヒット→先頭採用` が付いていても異常を意味しない。この `note=` は
単一ISBN時代に「1つのISBNで複数レコードに当たる」という異常を示す目的で導入されたもので、複数ISBN照会が
routineになった現在は、ログを `grep` するだけでは異常判定に使えなくなっている。注意して見るべきは
`hits` が `isbn=` に列挙されたISBN数を上回っているケースで、これは1つのISBNだけで複数レコードに当たって
いることを示し、本来の意味での「複数ヒット」の疑いがある。

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
