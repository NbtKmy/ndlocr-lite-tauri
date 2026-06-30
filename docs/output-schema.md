# 出力スキーマ（postgres投入用）

## ファイル構成

```
data/output/
  books.jsonl   … 1行1書籍
  entries.jsonl … 1行1目次エントリ（pgvector想定）
```

## books.jsonl

```json
{
  "book_id": "string",          // PDFファイル名（拡張子なし）またはSRU ID
  "source_pdf": "string",       // 元PDFの絶対パス
  "title": "string | null",     // 書名（将来的に外部メタデータから補完）
  "page_count": 12,             // 目次PDFのページ数
  "ocr_model_version": "1.0.0", // NDL OCRモデルバージョン
  "llm_model": "string",        // 校正・構造化に使用したOllamaモデル名
  "embed_model": "bge-m3",      // 埋め込みモデル名
  "embed_dim": 1024,            // 埋め込み次元数
  "processed_at": "string"      // Unix秒（ISO8601はDB側で変換）
}
```

## entries.jsonl

```json
{
  "id": "book_id:seq",          // 一意ID
  "book_id": "string",          // 書籍ID（books.jsonl の book_id と一致）
  "seq": 7,                     // エントリ通し番号（1始まり）
  "level": 2,                   // 階層（1=部, 2=章, 3=節, 4=項）
  "heading_text": "string",     // 校正・確定済み見出しテキスト
  "page_number": 23,            // 開始ページ番号（不明時はnull）
  "contributor": "string|null", // 章の著者名（なければnull）
  "raw_ocr_text": "string",     // 生OCRテキスト（監査用）
  "source_page_index": 2,       // 元PDFの何ページ目（0始まり）
  "confidence": 0.87,           // OCR信頼度推定値
  "reviewed": true,             // 人によるレビュー済みか
  "edited": false,              // 人が手修正したか
  "embedding": [/* 1024 floats */] // bge-m3 埋め込みベクトル
}
```

## postgres / pgvector 利用想定

```sql
-- books テーブル
CREATE TABLE toc_books (
  book_id TEXT PRIMARY KEY,
  source_pdf TEXT,
  title TEXT,
  page_count INT,
  ocr_model_version TEXT,
  llm_model TEXT,
  embed_model TEXT,
  embed_dim INT,
  processed_at BIGINT
);

-- entries テーブル（pgvector必須）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE toc_entries (
  id TEXT PRIMARY KEY,
  book_id TEXT REFERENCES toc_books(book_id),
  seq INT,
  level INT,
  heading_text TEXT,
  page_number INT,
  contributor TEXT,
  raw_ocr_text TEXT,
  source_page_index INT,
  confidence REAL,
  reviewed BOOLEAN,
  edited BOOLEAN,
  embedding vector(1024)
);
CREATE INDEX ON toc_entries USING hnsw (embedding vector_cosine_ops);

-- JSONL → postgres ロード例
COPY toc_books FROM '/path/to/books.jsonl' (FORMAT text);
-- または psql の \copy + jsonb_populate_record を使う
```

## 注意事項

- `embedding` 次元数 (`embed_dim`) はモデル設定に依存。変更時はpgvectorの `vector(N)` も変更が必要。
- `processed_at` はUnix秒。DB側で `TO_TIMESTAMP(processed_at)` でtimestamptz変換可能。
- このスキーマはアプリの出力仕様。DB側プロジェクトはこのJSONLをそのまま取り込める前提で設計。
