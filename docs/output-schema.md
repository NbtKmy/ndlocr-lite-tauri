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
  cinii_batch_YYYYMMDD-HHmmss.json … 複数書籍のCiNii JSONをまとめた配列（InboxViewから一括生成。DB取り込み対象外）
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

## cinii_batch_YYYYMMDD-HHmmss.json（補助出力・DB取り込み対象外）

InboxView の書籍一覧で複数書籍を選択し「選択をCiNii JSON一括出力」を実行したときに生成される、
複数書籍分の `CiniiBookRecord`（`cinii_books.jsonl` の1行と同じ形）を1つのJSON配列にまとめたファイル。
`CiniiBatchResult`（`src/pipeline/types.ts`）が返す `fileName` がそのままファイル名になる。
ファイル名は秒まで含む。分単位にすると同一分内で2回実行した場合に `append_output_text` の追記により
既存ファイル末尾に配列が追記され `[...]\n[...]` という不正なJSONになってしまうため。

```jsonc
[
  {
    "book_id": "991234567890",
    "cinii_ncid": "BB08395220",
    "title": "夕陽カ丘三号館",
    "pub_year": "2012",
    "isbn": ["9784167137113"],
    "exported_at": "2026-09-10T14:05:00+09:00",
    "toc": [ { "seq": 1, "level": 1, "heading_text": "第一章 転居", "page_number": 5, "contributor": null } ]
  }
]
```

同一の一括出力実行内で選択した書籍は全て同じ `exported_at` を持つ（バッチ全体で1回だけ生成する）。
既存の `cinii_books.jsonl` に既知の NCID がある書籍は CiNii へ再照会せずそのNCIDを再利用するが、
`toc` は常にそのときの `review.json` から作り直すため、古い `toc` を引き継ぐことはない。
新規に照会して得たNCIDの書籍のみ `cinii_books.jsonl` にも upsert され、次回以降の一括出力で再利用できる。
`review.json` が無い書籍・ISBNがない書籍・CiNiiでヒットしない書籍・API失敗した書籍はこの配列に含まれず、
`cinii_export.log` にのみ記録される（下記）。

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

`cinii_books.jsonl` へのレコード書き込みが成功した後にこのログの追記が失敗した場合（ディスクフル等）、
`cinii_books.jsonl` には行が存在するのに対応するログ行が無い状態になる。この場合、アプリはエラーとして
握らず、レコードは書き込めたがログ書き込みに失敗したことを画面に明示する。ボタンを再度押せば
`cinii_books.jsonl` の upsert は同じ `book_id` の行を置き換えるだけなので、再実行は安全（idempotent）である。

一括出力（`cinii_batch_*.json`）の場合、書籍ごとの行に加えて実行の最後に集計行が1行追記される。

```
2026-09-10T14:05:00+09:00 991234567892 OK   ncid=BB09999999 isbn=9784167137113 entries=12 note=ncid再利用
2026-09-10T14:05:00+09:00 BATCH file=cinii_batch_20260910-140500.json ok=3 skip=1
```

`file=` は生成したJSON配列ファイル名（成功0件のときは `(none)`）、`ok=` / `skip=` は今回の実行での
成功・スキップ件数。この行のタイムスタンプも同一実行内の書籍ごとの行と同じ `exported_at` を使う。

一括出力で `cinii_books.jsonl` の既存NCIDを再利用した書籍は、CiNiiへ照会していないため `hits=` を
持たない代わりに末尾に `note=ncid再利用` が付く。`isbn=` はこの場合「実際に照会したISBN」ではなく
`SruMetadata.isbn`（その書籍のISBN）をそのまま使う。照会していないのに `isbn=` /`hits=` を無条件に
出力すると、値が無い（`undefined`）ままログに出力されてしまう不具合が過去にあったため、`formatLogLine`
は値がある場合のみ `isbn=` / `hits=` を出す。新規に照会した書籍は従来どおり `isbn=`（照会したISBN）と
`hits=` を持ち、`note=ncid再利用` は付かない（`hits > 1` のときの既存の `note=複数N件ヒット→先頭採用`
とは排他で、再利用時は `hits` 自体を持たないため両者が同時に出ることはない）。

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
