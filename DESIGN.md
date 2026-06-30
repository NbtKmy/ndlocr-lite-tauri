# DESIGN.md — SRU連携による目次OCRパイプライン拡張（実装引き継ぎ仕様）

> このドキュメントは **実装担当（Sonnet）への引き継ぎ仕様** です。
> オーナー（ユーザー）との設計議論の結論を確定事項として記録しています。
> 実装前に必ず `CLAUDE.md` の「開発ルール」を読むこと（特に **実装前にユーザー承認**、
> **バージョン3箇所更新**、**プッシュ禁止**、**ドキュメント即時反映**）。

最終更新: 2026-06-20

---

## 0. 背景と全体像

このアプリの最終目的（プロジェクト全体）:
**本の目次PDFを図書館カタログから取得 → OCR → エンベディング → PostgreSQL に投入し、
「目次から本のタイトルを検索」できるデータを作る。**

このアプリが担うのは **「OCR + PostgreSQL投入用データ（JSONL）の作成」まで**。
（PostgreSQLへの実際の投入・検索アプリ本体は別スコープ）

規模感: 最終的に **最大5万冊程度・出力レコードは100万件未満**。bge-m3 + JSONL で十分。

### 今回の設計変更の核

これまで「目次PDF単体」を入力に想定していたが、方針転換する:

> **入口を ISBN にし、図書館のSRUから「書誌メタデータ + 目次PDFのURL + 所蔵情報」を
> まとめて取得して、それを起点にパイプラインを回す。**

これにより、手作業のPDF収集とメタデータ入力が両方なくなり、出力JSONLのメタデータが
richになる（タイトル・著者・サブジェクト・分類・請求記号・配架場所まで入る）。

---

## 1. データソース: 図書館SRU（デフォルト: チューリッヒ大学図書館 UZB / SLSP SwissCovery）

- レコード形式: **MARC-XML**。
- 検索の入口は **ISBN**（MMS IDより運用が楽、というオーナー判断）。
- **エンドポイントや機関固有値はハードコードせず、コンフィグで設定**（§2）。
  UZBの値をデフォルトとして入れておき、他館の人は差し替えられる＝汎用アプリにする。

### SRUエンドポイント例（MMS ID検索）

```
https://uzb.swisscovery.ch/view/sru/41SLSP_UZB?version=1.2&operation=searchRetrieve&recordSchema=marcxml&query=alma.mms_id=99118249878905508
```

### ISBN検索（本番で使うクエリ）

```
https://uzb.swisscovery.ch/view/sru/41SLSP_UZB?version=1.2&operation=searchRetrieve&recordSchema=marcxml&query=alma.isbn=9784642306270
```

※ クエリインデックス名（`alma.isbn` / `alma.mms_id`）は実機で要確認。挙動が違えば
`alma.all_for_ui` 等にフォールバックする実装の余地を残すこと。

---

## 2. コンフィグ（汎用化のための設定項目）★

機関固有の値を**すべて設定化**する。デフォルトはUZBの値。

| 設定キー（仮） | 意味 | デフォルト |
|---------------|------|-----------|
| `sruEndpoint` | SRUのベースURL | `https://uzb.swisscovery.ch/view/sru/41SLSP_UZB` |
| `holdingFilterField` | 所蔵特定に使うAVAサブフィールド | `b` |
| `holdingFilterValue` | その値 | `UAOI` |
| `sourceLabel` | 出力 `source` に入れるラベル | `SLSP/UZB` |

- 既存のコンフィグ/設定の置き場所（`useAISettings` 等の localStorage 系、または Tauri 設定）に
  合わせて配置。AIキー保存と同様、ローカル保存でよい（機密ではない）。
- これにより「うちの図書館専用」を脱する。

---

## 3. 解決フロー（ISBN投入後のチェック順）★重要

ISBN1件ごとに、**以下の順で判定**する。途中で弾かれたら理由を表示して**次のISBNへ**。

```
ISBN投入
  │
  ├─① SRU検索 → ヒット無し ─────────────→ スキップ表示「見つからない」→ 次のISBN
  │
  ├─② 目次PDFの有無（856を §4.2 で選別）
  │      PDFなし ───────────────────────→ スキップ表示「目次PDFなし」→ 次のISBN
  │
  ├─③ 所蔵チェック（AVA holdingFilter, §4.3）
  │      所蔵なし ──────────────────────→ スキップ表示「所蔵なし(対象外)」→ 次のISBN
  │
  └─④ ①〜③クリア → 採用（メタデータ確定 + PDFダウンロードへ）
```

- **②（PDF有無）を③（所蔵）より先に判定する**（オーナー指定の順序）。
- スキップは黙って捨てず、必ず**行ごとの一覧に理由つきで表示**する（§6）。

---

## 4. MARC-XML パース仕様（最も事故りやすい）

実レコード（書名「大江戸怪談事情」, ISBN 9784642306270, MMS ID 99118249878905508）で
確認済みの構造を基準にする。

### 4.1 取得するフィールド

| 用途 | フィールド | 補足 |
|------|-----------|------|
| タイトル（翻字） | `245 $a $b` | 例: "Ōedo kaidan jijō" |
| タイトル（原表記） | `880`（245にリンク） | 例: "大江戸怪談事情『耳囊』の怪異をひもとく" |
| 著者（翻字） | `100 $a` / `700 $a` | 例: "Tsutsumi, Kunihiko" |
| 著者（原表記） | `880`（100にリンク） | 例: "堤, 邦彦" |
| 出版 | `264 $a $b $c`（無ければ`260`） | 地・出版者・年 |
| ISBN | `020 $a`（複数あり得る） | ISBN-10/13両方入ることがある |
| **サブジェクト** | **`6XX`（§4.4、複数）** | 650だけではない！ |
| 分類 | `084 $a` / `082 $a` / `050 $a` | NDC/DDC等 |
| **目次PDF URL** | **`856`（選別必須、§4.2）** | |
| **所蔵情報** | **`AVA`（選別必須、§4.3）** | Alma Availability |

### 4.2 856（電子的所在）の選別ルール — 目次PDFだけを拾う

1レコードに856が複数入り得る（表紙画像・全文・目次など）。**目次PDFだけ**を選ぶ:

```
856 の中から:
  $3 に "Inhaltsverzeichnis" を含む  かつ  $q == "PDF"
  → その $u が目次PDFのURL
```

実例:
```xml
<datafield tag="856" ind1="4" ind2="2">
  <subfield code="3">Titelblatt und Inhaltsverzeichnis</subfield>
  <subfield code="q">PDF</subfield>
  <subfield code="u">https://urn.ub.unibe.ch/urn:ch:slsp:zbz:4642306277:ihv:pdf</subfield>
</datafield>
```

- 条件に合う856が**無い**場合 → 解決フロー②でスキップ（「目次PDFなし」）。
- 複数該当した場合は最初の1件（要モニタリング、ログに出す）。

### 4.3 AVA（所蔵）の選別ルール — 「うちの本か」を確定

SRUが機関ゾーン（デフォルト `41SLSP_UZB`）で絞られている前提。機関内の**所蔵館**で特定する。
フィルタ条件はコンフィグ（`holdingFilterField`/`holdingFilterValue`、デフォルト `$b == "UAOI"`）:

```
AVA の中から:
  holdingFilterField の値 == holdingFilterValue  （デフォルト $b == "UAOI" = Asien-Orient）
  → そのAVAから所蔵情報を取得:
     $0 → MMS ID（= book_id に採用）
     $c → 配架場所         (location)
     $d → 請求記号         (call_number)
     $q → 所蔵館           (holding_library)
     $e → 在架状況         (holding_status, 任意)
```

実例:
```xml
<datafield tag="AVA" ind1=" " ind2=" ">
  <subfield code="0">99118249878905508</subfield>   <!-- MMS ID -->
  <subfield code="8">22574529380005508</subfield>   <!-- holding ID -->
  <subfield code="a">41SLSP_UZB</subfield>
  <subfield code="b">UAOI</subfield>
  <subfield code="c">ZUB (Zürichbergstrasse 4), Freihand (Japan)</subfield>
  <subfield code="d">UAOIJ J 576 / 019</subfield>
  <subfield code="e">available</subfield>
  <subfield code="q">UB Zürich, Asien-Orient</subfield>
</datafield>
```

- フィルタ条件に合うAVAが**無い**場合 → 解決フロー③でスキップ（「所蔵なし(対象外)」）。
- AVAは複数あり得る（機関内の複数館）。条件に合うものだけ採用。

### 4.4 サブジェクト（6XX）★注意

**650だけではない。** 6XXブロックを横断的に拾う。オーナー指定の必須:
**600（個人名）/ 610（団体名）/ 630（統一タイトル）/ 648（時代）/ 650（トピック）**。
加えて同系統も拾って取りこぼし防止: **611 / 647 / 651（地理）/ 653 / 655（ジャンル/形式）**。
- 各 `$a`（必要に応じ `$x $y $z $v` 等の細目）を収集。
- 和書なら**サブジェクトも880に原表記**があり得る → `$6` リンクで原表記も拾う。

### 4.5 880リンク解決（和書では必須）

スイスのカタログに入った和書は **245/100/6XX がローマ字翻字**、**原表記は880** にある。
最終目的が「目次から本のタイトルを検索」なので、**検索・埋め込み・表示のキーは
880の日本語原表記**。`$6` リンク（例: `245 $6 "880-01"` ↔ `880 $6 "245-01"`）を
解決して、翻字と原表記を**両方**保持すること。

---

## 5. book_id とスキーマ拡張

### 5.1 book_id

- **book_id = MMS ID**（AVA `$0`、URLの `docId=alma<MMS_ID>` とも一致）。
- ISBNは複数（上製/並製）・複数レコードがあり得るので、検索キーはISBN、
  **内部の一意キーはMMS ID**（冪等性: 同じ本は同じID → 再処理で重複しない）。

### 5.2 既存スキーマの現状（`src/pipeline/types.ts`）

- `OutputBook.title` は現在 `writer.ts`（`src/output/writer.ts`）で **`null` ハードコード**。
  → SRU連携でここを埋めるのが今回の主目的の一つ。
- `TocEntry` は既に `level`(1=部,2=章,3=節,4=項) / `seq` / `page_number` /
  `contributor` / `raw_ocr_text` / `confidence` / `source_page_index` を持つ。
  → 構造化はLLM（`src/ai/toc-structuring.ts`）が既に出力している。

### 5.3 `OutputBook` への追加フィールド（確定）

```ts
// 既存に加えて:
book_id: string            // = MMS ID（既存だがUUID→MMS IDに変更）
isbn: string[]             // 020 全件（正規化済み）
title_original: string | null     // 880（日本語原表記）★検索キー
title_romanized: string | null    // 245 $a $b（翻字）
subtitle: string | null
creator_original: string | null   // 880
creator_romanized: string | null  // 100/700
publisher: string | null   // 264/260 $b
pub_place: string | null   // 264/260 $a
pub_year: string | null    // 264/260 $c
subjects: string[]         // 6XX（原表記優先、§4.4）
classification: string[]   // 084/082/050
toc_pdf_url: string        // 856 $u（選別済み）
call_number: string | null // AVA $d
location: string | null    // AVA $c
holding_library: string | null  // AVA $q
holding_status: string | null   // AVA $e（任意）
source: string             // コンフィグ sourceLabel（例 "SLSP/UZB"）
embedding?: number[]       // 書籍レベルのベクトル（§7-a）
```

---

## 6. 入力UX: 単体ISBN ＋ CSV一括

既存 `src/views/InboxView.tsx`（バッチキュー）に乗せる。

- **単体入力**: アプリ起動後にISBNを1件入力して開始。
- **CSV一括入力**: 複数ISBNをまとめて投入。両者とも同じキューに流す。
  - CSV形式: **1行1ISBN**（確定）。ヘッダ有無は自動判定。
  - **ISBN正規化**: ハイフン除去、ISBN-10/13両対応（実レコードも `9784642306270` と
    `4642306277` の両方を保持していた）。どちらでもSRUで引けるようにする。
- **行ごとの解決ステータス**を一覧表示する（§3の各分岐に対応）:
  `採用` / `見つからない` / `目次PDFなし` / `所蔵なし(対象外)` / `重複`。

### 状態機械の拡張

既存 `BookStatus`（`src/pipeline/types.ts`）:
```
'pending' | 'ocr_done' | 'llm_done' | 'review_pending' | 'approved' | 'exported'
```
これの **手前に「解決ステップ」を追加** する:
```
'resolving' → 'resolved' / 'resolve_failed'  →（resolved後に）'pending' …
```
（具体的なenum名・遷移は実装時に確定。`resolve_failed` は失敗理由＝§3の分岐を保持できること。）

---

## 7. エンベディング: 2レベル構成（確定）

**(a) 書籍レベルのベクトル**（`books.jsonl` / `OutputBook.embedding`、新規）
- 入力テキスト = `title_original` + `subtitle` + `subjects`（+ 任意で部・章レベルの見出し概要）
- 用途 = 「この本は何の本か」の粗い検索・本単位の代表ベクトル

**(b) 目次チャンクのベクトル**（`entries.jsonl` / 既存 `OutputEntry.embedding`）
- 入力テキスト = 親章の文脈を前置した見出し（例: "第三章 経済 > 第一節 貿易"）
  親子は `level` を使って辿る
- 用途 = 「Xを扱っている本」の細かい検索。**目次の各エントリ = 1チャンク**が自然な単位

共通:
- 入力テキストは**日本語原表記（880）優先**（翻字は検索に弱い）
- モデルは既存の `bge-m3`（1024次元、多言語対応で日本語OK）
- 規模100万件未満なので性能・コストとも問題なし

---

## 8. PDF取得

- 856 `$u` のPDFを **Rust側コマンドでダウンロード**（CORS回避）。
  既存の `ollama_chat` コマンドと同じパターン（`src-tauri/src/lib.rs`）。
- ダウンロード後は既存のOCRフロー（DEIM + PARSeq + 数式認識）に流す。

---

## 9. レビューUI: (B)方式に確定

目次構造の人手レビューは、**LLMが出した構造化ドラフトを人間が「直すだけ」**
（ゼロから手入力しない）。`src/views/ReviewView.tsx` を拡張。

**(B)方式（採用）:**
- **Markdownは「階層 + 見出しテキスト」専用の編集面**（`#`深さ=level, テキスト=heading_text）。
- `page_number` / `contributor` は **Markdownに埋め込まず、専用フィールド/テーブルで別管理**。
  （理由: ページ番号や著者を文字列規約に埋め込む(A)案はパースが壊れやすくレビュー事故が増える）

**round-tripの勘所（実装時に必ず対処）:**
- Markdown側で行を増減・並べ替えると、別管理の `page_number` 等を `seq` で
  突き合わせると崩れる。対策として **各エントリに安定したID（行に隠しキー）を持たせる**、
  または **テーブルを真実の源（source of truth）にしてMarkdownをその派生編集ビュー** にする。

---

## 10. 出力（既存を踏襲）

`src/output/writer.ts` 経由で Tauri command（`append_output_record`）でディスク書き込み:
- `books.jsonl` … 1行=1冊（`OutputBook`、§5.3で拡張、書籍レベル埋め込み付き）
- `entries.jsonl` … 1行=1目次エントリ（`OutputEntry` = `ReviewedEntry` + id/book_id + embedding）

---

## 11. 実装の着手順（リスクの高い順）

1. **SRUクライアント + コンフィグ + スキーマ拡張**（最重要・最不確実）
   - 新規: `src/ai/sru-client.ts`（仮）= ISBN→SRU→MARC-XMLパース
     （§4の選別ルール全部: 245/880, 100/880, 264, 020, 6XX, 084, 856選別, AVA選別, $6解決）
   - コンフィグ（§2）の追加と読み込み。
   - 解決フロー（§3）の判定順を実装。
   - `src/pipeline/types.ts` の `OutputBook` 拡張（§5.3）
   - **実ISBN数件で通して検証してから次へ**（MARCパースが一番事故る）
2. **PDF取得**（Rustコマンド、CORS回避、§8）
3. **入力UX**（単体ISBN + CSV一括 → キュー投入、行ごと解決ステータス、状態機械拡張、§6）
4. **レビューUI**（(B)方式 Markdown階層エディタ + ページ/著者別入力、§9）
5. **エンベディング**（(a)書籍レベルベクトルの追加、(b)既存チャンクの入力テキスト改善、§7）

その後、既存の OCR → `toc-structuring` → `writer`（メタデータ埋め込み済み）に繋ぐ。

---

## 12. 確定した決定事項（チェックリスト）

- [x] 入口は **ISBN**（単体 + CSV一括、CSVは1行1ISBN）
- [x] データソースは **図書館SRU（MARC-XML）**、デフォルト UZB / SLSP
- [x] **SRUエンドポイント・所蔵フィルタ・sourceラベルをコンフィグ化**（ハードコードしない）
- [x] **book_id = MMS ID**（AVA `$0`）
- [x] 目次PDFは **856 を `$3=Inhaltsverzeichnis` + `$q=PDF` で選別** → `$u`
- [x] 所蔵特定は **AVA holdingFilter**（デフォルト `$b == "UAOI"`）
- [x] 解決チェック順は **①SRUヒット → ②目次PDF有無 → ③所蔵**、弾いたら理由表示して次へ
- [x] **目次PDFなし / 所蔵なし → スキップ + 理由を一覧表示**
- [x] サブジェクトは **6XX**（600/610/611/630/647/648/650/651/653/655）、650だけではない
- [x] 出力に **配架場所($c) / 請求記号($d) / 所蔵館($q)** を追加
- [x] **880（日本語原表記）と翻字を両方保持**、検索キーは原表記
- [x] エンベディングは **2レベル**（(a)書籍=タイトル+サブジェクト / (b)目次チャンク）
- [x] レビューUIは **(B)方式**（Markdown=階層+見出し、ページ/著者は別管理）
- [x] PDF取得は **RustコマンドでCORS回避**
- [x] 規模 最大5万冊・100万件未満 → bge-m3 + JSONL で問題なし

## 13. 実装時に確定する細部（未決・要判断）

- SRUクエリインデックス名（`alma.isbn` 等）の実機確認とフォールバック。
- 状態機械の具体的なenum名・遷移・失敗理由の保持方法。
- round-tripの安定IDの持たせ方（隠しID vs テーブルを真実の源）。
- 856が複数該当した場合の優先順位（現状: 先頭1件 + ログ）。
- 重複ISBN（同一MMS IDに解決）の扱い（現状想定: 「重複」表示でスキップ）。
- サブジェクト6XXで細目（$x/$y/$z/$v）を連結するか、$aのみにするか。

---

## 付録A: 検証に使った実レコード

- 書名: 大江戸怪談事情『耳囊』の怪異をひもとく（堤邦彦 著, 吉川弘文館, 2026）
- ISBN: 9784642306270 / 4642306277
- MMS ID: 99118249878905508
- 目次PDF: https://urn.ub.unibe.ch/urn:ch:slsp:zbz:4642306277:ihv:pdf
- ソースレコード画面:
  https://uzb.swisscovery.slsp.ch/discovery/sourceRecord?vid=41SLSP_UZB:UZB&docId=alma99118249878905508&recordOwner=41SLSP_NETWORK
- SRU(MMS ID):
  https://uzb.swisscovery.ch/view/sru/41SLSP_UZB?version=1.2&operation=searchRetrieve&recordSchema=marcxml&query=alma.mms_id=99118249878905508

---

## 14. レビュー画面の修正（2026-06-21 確定・実装引き継ぎ）★

ISBN→SRU→PDF取得→OCR までは動作確認済み。**レビュー画面 (`ReviewView.tsx`) に4つの問題**があり、
オーナー報告 → 設計レビュー（実コード検証済み）で原因を特定した。下記の修正版計画を**確定事項**として実装する。

### 14.0 報告された症状（オーナー）
1. OCRは動くが **LLM構造化が全くできず、レビュー時に目次構造が空**で出る。
2. ダークモード時に **黒背景に黒文字**で読めない箇所がある。
3. **PDF画像が小さく・荒く**、テキストが確認できない。
4. レイアウト検知のテキストボックスの座標が、**表示PDF画像の座標と全く合っていない**。
5. レビューは人手作業の最大のボトルネック → **作業しやすいUI**が必要。

### 14.1 原因（実コード検証で確定）

| 症状 | 真の原因（検証済み） |
|------|--------------------|
| LLM構造化が空 | **`lib.rs` の `OllamaChatRequest` が `options` を送っていない** → Ollama の `num_ctx` がデフォルト2048トークン。複数ページOCR＋プロンプトが超過し、**入力が末尾だけ残して切り捨て**られ、先頭のシステムプロンプトが消えて空・破綻出力になる。Ollamaの典型的落とし穴。 |
| 画像が荒い | ReviewView が `makeThumbnailDataUrl`（**最大幅200px**, `imageLoader.ts:8`）のサムネイルを ImageViewer に渡している。 |
| 座標ずれ | ImageViewer は `scaleX = imgSize / naturalSize` で**表示画像の自然サイズ基準に正規化**する（`ImageViewer.tsx:132`）。bbox座標はOCR時のスケール2.0空間なのに、表示が200pxサムネイル（natural=200px）なので基準が一致しない。→ **OCRと同じスケール2.0でラスタライズした画像を渡せば既存ロジックで自動的に合う。** |
| 黒地に黒文字 | CSSはほぼ `var(--color-*)` を使っており、ハードコード色が原因ではない。真因は **`.entry-row input, .entry-row select` に `color` 宣言が無い**（`index.css:3181`）→ ブラウザ既定の黒文字にフォールバック。編集モードの入力欄だけが黒地黒文字。 |

### 14.2 実装計画（優先度順・この順で着手）

**Phase 1: LLM構造化を動かす（最優先 — 対象が無いとレビューできない）**
1. `src-tauri/src/lib.rs`: `OllamaChatRequest` に `options: { num_ctx: 8192 }` を追加（切り捨て解消）。
   - `OllamaOptions { num_ctx: u32 }` 構造体を追加し `#[serde(skip_serializing_if=...)]` で任意化してもよい。
2. `src/ai/toc-structuring.ts`: パーサ堅牢化。`entries` キーが無くても **素の配列 / 他キー名 / ```json コードフェンス付き** に対応。失敗時は生レスポンスを保持して返す。
3. `src/views/ReviewView.tsx`: 構造化失敗時に **生LLMレスポンスを画面に表示**（デバッグ可能化）。

**Phase 2: 可読性の修正**
4. `src/views/ReviewView.tsx`: PDF画像を **OCRと同じスケール2.0でラスタライズ**し、`imageDataToDataUrl(imageData)`（フル解像度, `imageLoader.ts` に既存・App.tsxで使用中）で ImageViewer に渡す。サムネイルをやめる。→ 鮮明化＋座標一致。
   - 注: 現状の ReviewView は scale 1.5 で再ラスタライズしている。**2.0 に変更**（OCRの InboxView.processBook が 2.0 のため）。
5. ImageViewer 呼び出し: レビューでは `textBlocks={[]}` を渡して **OCR行枠を非表示**（目次レビューに行枠はノイズ。ズーム/パンは活かす）。座標は4で一致するので将来枠表示も可能。
6. `src/index.css`: `.entry-row input, .entry-row select` に `color: var(--color-text)` を追加（黒地黒文字の解消）。

**Phase 3: レビュー作業の効率化（Phase 1・2完了後、実データを見てから着手）**
- 現在ページに属するエントリのみフィルタ表示（`source_page_index` 利用）。
- キーボード操作（Tab/Enter/矢印で行移動・確定）。
- `raw_ocr_text`（OCR元）と校正後 `heading_text` の対比表示。
- ※ 過剰設計を避けるため、実データのレビュー体験を見てから具体化する。

### 14.3 実装上の注意
- **Phase 1 → 実出力を確認 → Phase 2 → Phase 3** の順で進めること（Phase 3 は先走らない）。
- `num_ctx` を上げると Ollama のメモリ使用が増える。8192 で目次数ページには十分。
- CLAUDE.md の開発ルール厳守（実装前にオーナー承認・バージョン3箇所更新・プッシュ禁止・ドキュメント即時反映）。
- 関連メモリ: [[ndl-toc-ocr-project]] / [[ndl-toc-sru-pivot]]
