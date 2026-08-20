# Research Theme Search System Design

## 1. Purpose

This system provides a research-theme-oriented search interface over book contents.

It is not intended to replace the library discovery system. Book-level discovery is already handled by Primo VE. This system focuses on helping users find relevant sections, chapters, and table-of-contents entries inside books, then linking users back to the canonical Primo VE record when they need the full bibliographic record or access options.

## 2. Core Concept

The system searches two related layers of data:

- `books`: bibliographic and holding-level metadata for each book
- `entries`: searchable content units contained in books, such as table-of-contents headings, chapter titles, sections, and other extracted entry-level descriptions

The main search unit is `entries`, not `books`.

Search results should answer questions like:

- Which books contain sections related to this research theme?
- Which chapters or headings seem relevant?
- Which authors, subjects, classifications, or publication periods appear in the results?
- How can the user jump from a relevant entry to the library record in Primo VE?

## 3. Non-Goals

The first version should not try to become a full OPAC or discovery layer.

Out of scope for the MVP:

- Full bibliographic search replacement
- Circulation workflows
- User accounts, favorites, and saved searches
- Real-time book availability synchronization beyond stored `holding_status`
- Server-side batch embedding generation for imported books and entries
- Full-text OCR search unless reliable text is available later
- LLM-generated answers or RAG-style summaries

## 4. High-Level Architecture

```text
Local processing app
  └ generates books.jsonl / entries.jsonl
     └ includes precomputed bge-m3 embeddings

Upload / import
  ↓

Server / VPS
  ├ Next.js
  │   ├ search UI
  │   ├ API routes / server actions
  │   └ import endpoint or admin import command
  │
  ├ PostgreSQL
  │   ├ books
  │   ├ entries
  │   ├ pgvector
  │   ├ indexes
  │   └ search / facet SQL
  │
  └ Ollama
      └ bge-m3
          └ query embedding generation only
```

## 5. Component Responsibilities

### 5.1 Local Processing App

The local app is responsible for preparing importable JSONL data.

Responsibilities:

- Extract or receive bibliographic metadata
- Extract table-of-contents or entry-level content
- Generate embeddings for `books` and `entries`
- Write `books.jsonl` and `entries.jsonl`
- Ensure embeddings are generated with the same model family and settings used by the server query embedder

The server does not generate book or entry embeddings during import.

### 5.2 Next.js App

Next.js is the application layer.

Responsibilities:

- Render search UI
- Accept search requests
- Send the user query to Ollama for embedding
- Send vector search and filter parameters to PostgreSQL
- Return ranked results and facets to the frontend
- Provide import/admin endpoints if needed
- Construct Primo VE deep links from stored identifiers

Next.js should not run the embedding model in-process.

### 5.3 PostgreSQL

PostgreSQL is the search engine and metadata store.

Responsibilities:

- Store `books` and `entries`
- Store `vector(1024)` embeddings using `pgvector`
- Run vector similarity search
- Run keyword or trigram search where useful
- Join entry results to book metadata
- Calculate facets
- Enforce import constraints and model metadata checks

### 5.4 Ollama

Ollama manages the runtime embedding model used at query time.

Responsibilities:

- Serve `bge-m3` locally on the server
- Convert user search queries into 1024-dimensional vectors
- Keep query-time embedding generation separate from the Next.js process

Recommended rule:

- Use the same embedding implementation for local import generation and server query generation whenever possible.
- If local import generation uses a different implementation from Ollama, evaluate search quality before relying on the system.
- `bge-m3` does not require an instruction/query prefix (unlike some BGE English models). Generate both stored passages and query vectors with **no prefix**, identically, so the cosine space stays symmetric. The local app already embeds via Ollama `bge-m3`, so matching the server call is straightforward.

## 6. Data Model

### 6.1 `books`

A book is the bibliographic parent record for one or more entries.

Observed JSONL fields:

```text
book_id
call_number
classification
creator_original
creator_romanized
embed_dim
embed_model
embedding
holding_library
holding_status
isbn
llm_model
location
ocr_model_version
page_count
processed_at
pub_place
pub_year
publisher
source
source_pdf
subjects
subtitle
title_original
title_romanized
toc_pdf_url
```

Potential PostgreSQL schema:

```sql
create table books (
  book_id text primary key,
  title_original text,
  title_romanized text,
  subtitle text,
  creator_original text,
  creator_romanized text,
  publisher text,
  pub_place text,
  pub_year_raw text,   -- MARC由来の原文（"c2026", "[2026]", "昭和27年" 等）をそのまま保持
  pub_year integer,    -- pub_year_raw からパース成功時のみ。年範囲ファセット用。失敗時は null
  isbn text[],
  classification text[],
  subjects text[],
  call_number text,
  holding_library text,
  holding_status text,
  location text,
  source text,
  source_pdf text,
  toc_pdf_url text,
  page_count integer,
  processed_at text,
  ocr_model_version text,
  llm_model text,
  embed_model text not null,
  embed_dim integer not null,
  embedding vector(1024),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

Notes:

- `book_id` is the Primo VE MMS ID and is used for deep linking.
- No separate `mms_id` field is required unless the upstream format changes later.
- The app emits `pub_year` as a **string** (MARC-derived; see `OutputBook.pub_year: string | null`). Values can be `"2026"`, `"c2026"`, `"[2026]"`, `"2026."`, `"昭和27年"`, etc. Do NOT coerce blindly to integer — that loses or corrupts data. Store the original in `pub_year_raw`, and additionally parse a 4-digit year into `pub_year integer` only when extraction is unambiguous; leave `pub_year` null otherwise. Year-range facets use `pub_year`; display uses `pub_year_raw`.
- `processed_at`: confirm the exact emitted format before writing the importer. `docs/output-schema.md` historically described it as Unix seconds, but the app currently passes a `processed_at: string` of unconfirmed shape. Inspect one real `books.jsonl` record first, then store as `text` for MVP and convert to `timestamptz` once the format is verified.

### 6.2 `entries`

An entry is the main searchable unit.

Observed JSONL fields:

```text
id
book_id
heading_text
level
page_number
seq
source_page_index
confidence
reviewed
edited
contributor
raw_ocr_text
embedding
```

Potential PostgreSQL schema:

```sql
create table entries (
  id text primary key,
  book_id text not null references books(book_id) on delete cascade,
  heading_text text not null,
  level integer,
  page_number integer,
  seq integer,
  source_page_index integer,
  confidence numeric,
  reviewed boolean default false,
  edited boolean default false,
  contributor text,
  raw_ocr_text text,
  embedding vector(1024),   -- NULLABLE on purpose; see note below
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

Notes:

- `entries.heading_text` is the primary searchable text.
- `entries.raw_ocr_text` is currently not a reliable primary search field if often empty.
- `level`, `seq`, and `page_number` enable table-of-contents browsing.
- `confidence`, `reviewed`, and `edited` can support quality filters.
- **`embedding` must be NULLABLE.** The app has an `exported_no_embed` status: when Ollama embedding fails, books and their entries are exported *without* embeddings (`OutputEntry.embedding` is optional). A `NOT NULL` constraint would reject those records at import time. Semantic search must therefore restrict to `WHERE embedding IS NOT NULL`; embedding-less entries remain findable only via the keyword mode.

## 7. Indexing Strategy

### 7.1 Vector Search — Exact KNN for MVP, No Index

**Decision: the MVP uses exact (brute-force) KNN with no ANN index.**

At the expected scale (~5,000 entries, growing slowly), a sequential cosine scan in pgvector completes in single-digit milliseconds. Skipping HNSW for MVP buys two concrete advantages:

- **Exact results.** No recall loss.
- **Filters compose cleanly.** HNSW is approximate; combining it with `WHERE` filters (confidence, year, subjects, …) drops candidates *after* the ANN step and silently degrades recall. Exact KNN applies filters and ranking together with no surprises.

MVP query shape (no index needed):

```sql
select e.*, e.embedding <=> $1 as distance
from entries e
where e.embedding is not null
  -- + optional filters
order by e.embedding <=> $1
limit $2;
```

Add an ANN index **only when the dataset outgrows exact search** (rule of thumb: tens of thousands of entries, or measured query latency above ~50ms). At that point:

```sql
create index entries_embedding_hnsw_idx
on entries using hnsw (embedding vector_cosine_ops);
-- and re-evaluate filter recall (consider pgvector iterative scan)
```

Book-level vector search remains optional (the product focus is entry-level theme discovery) and likewise needs no index at MVP scale.

### 7.2 Metadata Indexes

Recommended indexes:

```sql
create index entries_book_id_idx on entries(book_id);
create index entries_level_idx on entries(level);
create index entries_reviewed_idx on entries(reviewed);
create index entries_confidence_idx on entries(confidence);
create index books_pub_year_idx on books(pub_year);
create index books_holding_status_idx on books(holding_status);
create index books_creator_original_idx on books(creator_original);
```

For array facets:

```sql
create index books_subjects_gin_idx on books using gin(subjects);
create index books_classification_gin_idx on books using gin(classification);
create index books_isbn_gin_idx on books using gin(isbn);
```

### 7.3 Keyword Search

Vector search should be the default, but keyword search should be available in the MVP as an explicit user-selectable mode. This is important for:

- names
- book titles
- transliterations
- ISBNs
- classifications
- exact Japanese terms
- rare proper nouns

Recommended MVP search modes:

1. `semantic`
   - default mode
   - embeds the query with Ollama `bge-m3` and searches `entries.embedding`
2. `keyword`
   - user-enabled mode
   - does not call Ollama
   - searches text and metadata fields using keyword matching
3. `hybrid`
   - optional early experiment
   - combines semantic and keyword candidates
   - ranking can be refined after evaluation

Keyword search should cover **both the original-script and romanized fields** (`title_original` + `title_romanized`, `creator_original` + `creator_romanized`), so a query in either script can match. This is the main reason keyword mode is needed alongside semantic search for names and titles.

Initial keyword implementation can use `ILIKE` and/or `pg_trgm`. PostgreSQL full-text search can be added later if it proves useful for Japanese and romanized fields.

For MVP, avoid overengineering keyword ranking. The important design goal is to let users compare semantic and keyword behavior directly.

## 8. Search Behavior

### 8.1 Basic Search Flow

```text
User query
  ↓
Next.js /api/search
  ↓
Select search mode
  ├ semantic: Ollama bge-m3 embedding → PostgreSQL vector search
  ├ keyword: PostgreSQL keyword search
  └ hybrid: combine semantic and keyword candidates
  ↓
JOIN books
  ↓
Apply filters, including default confidence threshold
  ↓
Compute facets (over the candidate pool, not just the top-`limit` page — see §9)
  ↓
Return results
```

### 8.2 Result Unit

The default result unit is an entry. The first UI should default to entry view rather than book-grouped view.

Each result should include:

```json
{
  "entry_id": "...",
  "score": 0.82,
  "heading_text": "仏教から怪談へ",
  "level": 2,
  "page_number": 22,
  "seq": 2,
  "book": {
    "book_id": "...",
    "title_original": "大江戸怪談事情",
    "title_romanized": "Ōedo kaidan jijō ...",
    "subtitle": "...",
    "creator_original": "堤, 邦彦",
    "creator_romanized": "Tsutsumi, Kunihiko",
    "pub_year": 2026,
    "publisher": "Yoshikawa Kōbunkan",
    "subjects": ["..."],
    "classification": ["..."],
    "holding_status": "available",
    "location": "...",
    "call_number": "...",
    "primo_url": "..."
  }
}
```

### 8.3 Default Quality Threshold

Entries should be visible by default only when they meet a minimum confidence threshold.

MVP default:

```text
min_confidence = 0.4
```

Users should be able to change this value in the UI. This allows broad exploratory searches while still giving users control over noisy OCR or TOC extraction results.

Reviewed and edited flags should remain available as filters, but they should not completely hide unreviewed entries by default.

### 8.4 Book Grouping

Entry-level results can produce many hits from the same book.

The UI should support two display modes:

1. Entry view
   - Shows the strongest individual entry matches
2. Book-grouped view
   - Groups matching entries under their parent book
   - Shows top matching entries per book
   - Sorts books by best entry score or aggregated score

Initial aggregation rule:

```text
book_score = max(entry_score) for entries in the book
```

Later alternatives:

```text
book_score = max(entry_score) + small boost for number of relevant entries
book_score = weighted average of top N entry scores
```

## 9. Facets

Facets should help users move from a broad research theme to a useful subset.

Recommended MVP facets:

- Creator / author
- Publication year or year range
- Subjects
- Classification
- Holding status
- Library / location
- Entry level
- Reviewed / unreviewed
- Confidence range

**Define the facet candidate pool explicitly — this is not "the current result set" in the naive sense.** Semantic search returns a ranked page of only `limit` rows (e.g. 20); computing facets over 20 rows is meaningless (every count is 1–4). Instead, facets are computed over a larger **candidate pool**:

- **Keyword / filter-only queries:** the candidate pool is *all* entries matching the active filters (no `limit`). Facets here are exact and useful.
- **Semantic queries:** retrieve a wider candidate set first (e.g. top `N = 200` by vector distance, after applying non-vector filters), compute facets over those `N`, and return only the top `limit` rows for display. `N` is a tunable knob (`facet_pool_size`), independent of the display `limit`.

Facets must never be computed over the whole database — they describe the current search, not the collection.

Initial facet response shape:

```json
{
  "facets": {
    "creator_original": [
      { "value": "堤, 邦彦", "count": 4 }
    ],
    "pub_year": [
      { "value": 2026, "count": 4 }
    ],
    "subjects": [
      { "value": "Mimibukuro", "count": 3 }
    ],
    "classification": [
      { "value": "KG745-R34", "count": 3 }
    ],
    "holding_status": [
      { "value": "available", "count": 4 }
    ],
    "level": [
      { "value": 2, "count": 4 }
    ]
  }
}
```

## 10. Table of Contents Browsing

Because `entries` has `level`, `seq`, and `page_number`, the system should expose a book detail view with a table-of-contents tree.

Book detail view should show:

- Bibliographic metadata
- Primo VE deep link
- Source TOC PDF link if available
- Entries sorted by `seq`
- Visual hierarchy using `level`
- Highlighted entries that matched the current search

Initial implementation can be a flat list with indentation by `level`.

Tree reconstruction can be improved later if parent-child relationships are added.

## 11. Primo VE Deep Linking

The system should link users back to Primo VE for the canonical library record.

Required field:

- `mms_id`, or use `book_id` if `book_id` is the MMS ID

Suggested helper:

```ts
function buildPrimoUrl(bookId: string): string {
  return `https://uzb.swisscovery.slsp.ch/permalink/41SLSP_UZB/pbgk0u/alma${bookId}`;
}
```

Confirmed Primo VE URL template:

```text
https://uzb.swisscovery.slsp.ch/permalink/41SLSP_UZB/pbgk0u/alma[book_id]
```

`[book_id]` is replaced with the stored `books.book_id` value.

Do not store the full Primo URL in result data. Store `book_id` and generate the URL at response time from environment configuration.

## 12. API Design

### 12.1 `POST /api/search`

Request:

```json
{
  "query": "江戸時代の怪談と仏教",
  "limit": 20,
  "offset": 0,
  "view": "entries",
  "search_mode": "semantic",
  "filters": {
    "creator_original": ["堤, 邦彦"],
    "pub_year_from": 2000,
    "pub_year_to": 2026,
    "subjects": ["Mimibukuro"],
    "classification": ["KG745-R34"],
    "holding_status": ["available"],
    "level": [2],
    "reviewed": true,
    "min_confidence": 0.4
  }
}
```

Response:

```json
{
  "query": "江戸時代の怪談と仏教",
  "results": [],
  "facets": {},
  "limit": 20,
  "offset": 0,
  "total_estimate": 0
}
```

`total_estimate` is meaningful for keyword/filter-only queries (an exact count of matching rows is cheap). For semantic queries it is effectively the candidate-pool size, not a true corpus-wide relevance count — treat it as advisory and document this in the UI.

### 12.2 `GET /api/books/:bookId`

Returns book metadata and entries sorted by `seq`.

### 12.3 `POST /api/import`

Optional admin-only endpoint.

Alternatives:

- implement import as a CLI script instead of an HTTP endpoint
- upload JSONL to a protected directory and run an import command
- import directly with `psql`/Node script

For early development, a CLI import script is safer than a public API endpoint.

## 13. Search SQL Sketch

A first version can use one SQL function for entry search.

```sql
create or replace function search_entries(
  query_embedding vector(1024),
  match_count integer default 20
)
returns table (
  entry_id text,
  book_id text,
  heading_text text,
  page_number integer,
  level integer,
  seq integer,
  distance double precision,
  title_original text,
  creator_original text,
  pub_year integer,
  subjects text[],
  classification text[],
  holding_status text,
  location text,
  call_number text
)
language sql
stable
as $$
  select
    e.id as entry_id,
    e.book_id,
    e.heading_text,
    e.page_number,
    e.level,
    e.seq,
    e.embedding <=> query_embedding as distance,
    b.title_original,
    b.creator_original,
    b.pub_year,
    b.subjects,
    b.classification,
    b.holding_status,
    b.location,
    b.call_number
  from entries e
  join books b on b.book_id = e.book_id
  where e.embedding is not null
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
```

This is exact KNN (no ANN index — see §7.1); the `where e.embedding is not null` guard skips entries exported under `exported_no_embed`.

Later versions should add filters, hybrid keyword boosts, and facet calculation.

## 14. Import Strategy

Import input:

- `books.jsonl`
- `entries.jsonl`

Import checks:

- Every entry has a matching `book_id`
- Every embedding has length 1024
- Embedding values are numeric
- `embed_model` is compatible with the configured query model
- `embedding` may be absent (book exported under `exported_no_embed`); import the entry with a NULL embedding rather than rejecting it
- `pub_year_raw` is preserved as-is; `pub_year` integer is set only when a 4-digit year is unambiguously parseable, else null
- Re-importing an existing `book_id` replaces that book's entries wholesale (delete-then-insert), so stale entries from renumbered `seq` cannot accumulate

Import and withdrawal modes:

1. Incremental import / upsert
   - primary mode
   - add new books and entries without replacing the full database
   - **books:** upsert keyed on `book_id` (stable — it is the MMS ID).
   - **entries:** do NOT upsert per `entry.id`. The entry `id` is `"{book_id}:{seq}"`, and `seq` is renumbered whenever a book is re-reviewed (entries added/removed). Per-id upsert would leave stale entries from a previous version as orphans. Instead, **re-import a book by replacing its entries wholesale**, inside one transaction:
     ```sql
     -- within a transaction, per book being (re)imported
     delete from entries where book_id = $1;
     -- then insert all current entries for $1
     ```
     This keeps `entries` an exact mirror of the latest export for each book, with no leftovers.
2. Book-level withdrawal
   - remove one or more books by `book_id`
   - related entries are removed automatically through `entries.book_id references books(book_id) on delete cascade`

Replace-all import is not the desired default because the collection will grow incrementally. It can remain as a development-only maintenance command if useful, but production-like workflows should use upsert and withdrawal.

Expected first production-like dataset:

- Approximately 1,000 purchased books
- TOC data expected for approximately 500 books
- Approximately 10 TOC entries per book
- Initial searchable scale: about 500 books and 5,000 entries

Recommended MVP:

- CLI import script
- transactional import
- fail fast on invalid embedding dimensions
- log counts of inserted, updated, skipped, and failed books/entries
- CLI withdrawal command by `book_id`

## 15. Deployment

Recommended MVP deployment:

```text
One VPS
  ├ Docker Compose
  ├ Next.js app
  ├ PostgreSQL with pgvector
  └ Ollama with bge-m3
```

Minimum practical VPS:

- 8GB RAM for small datasets and development
- 16GB RAM preferred if HNSW indexes and Ollama run on the same machine
- SSD storage
- regular database backups

Suggested Docker services:

```text
web       Next.js
postgres  PostgreSQL + pgvector
ollama    Ollama model server
nginx      reverse proxy / TLS termination, optional
```

## 16. Configuration

Environment variables:

```text
DATABASE_URL=
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_EMBED_MODEL=bge-m3
EMBED_DIM=1024
PRIMO_PERMALINK_TEMPLATE=https://uzb.swisscovery.slsp.ch/permalink/41SLSP_UZB/pbgk0u/alma{book_id}
```

## 17. Security and Operations

Important basics:

- Do not expose Ollama directly to the public internet
- Keep PostgreSQL private to the server network
- Protect import endpoints or prefer local CLI import
- Use TLS for public traffic
- Back up PostgreSQL regularly
- Log slow queries
- Monitor disk usage
- Add rate limiting to search API if public

## 18. MVP Feature List

### Must Have

- Import `books.jsonl` and `entries.jsonl`
- Store 1024-dimensional vectors in PostgreSQL
- Query embedding via Ollama `bge-m3`
- Entry-level semantic search
- User-selectable keyword search mode
- Join results with book metadata
- Primo VE deep link per result
- Basic facets
- Book detail page with entries sorted by `seq`

### Should Have

- Book-grouped result view
- Author / year / subject / classification filters
- Result highlighting by matched entry
- TOC PDF link
- Reviewed / confidence filters with default `min_confidence = 0.4`
- Optional hybrid search experiment

### Later

- Hybrid ranking
- Reranking
- Search analytics
- Saved searches
- User feedback on bad matches
- Admin review workflow
- Parent-child entry hierarchy
- Multilingual UI
- API for external systems

## 19. Decisions and Remaining Open Questions

### 19.1 Decisions

1. `book_id` is the Primo VE MMS ID.
2. Primo VE deep-link template:

   ```text
   https://uzb.swisscovery.slsp.ch/permalink/41SLSP_UZB/pbgk0u/alma[book_id]
   ```

3. The first UI defaults to entry view.
4. Entries use a default confidence threshold of `0.4`; users can change the threshold.
5. The initial production-like dataset is expected to be approximately 500 books with TOC data and about 5,000 entries, drawn from a larger purchased set of roughly 1,000 books.
6. Import should be incremental/upsert-based, not replace-all.
7. Book-level withdrawal is required; withdrawing a book should also remove its entries.
8. Keyword search should be available in MVP as a user-selectable mode.
9. The MVP uses **exact KNN with no ANN index** (~5,000 entries); HNSW is deferred until the dataset outgrows brute-force search (§7.1).
10. `entries.embedding` is **nullable**; books exported as `exported_no_embed` import with NULL embeddings and are excluded from semantic search (§6.2).
11. On re-import, a book's entries are **replaced wholesale (delete-then-insert)** because `entry.id` (`book_id:seq`) is not stable across re-review (§14).
12. `pub_year` is stored as **`pub_year_raw text` + parsed `pub_year integer`**; no lossy blind coercion (§6.1).
13. Facets are computed over a **candidate pool** (all filter-matching rows for keyword; top-`N` for semantic), not the display page and not the whole DB (§9).
14. Keyword search covers both original-script and romanized title/creator fields (§7.3).

### 19.2 Remaining Open Questions

1. Should book-level embeddings be used in active search, or only stored for future use?
2. Should hybrid search be enabled in the first public UI, or kept as an internal evaluation mode until ranking is tuned?
3. What exact keyword implementation should be used first: `ILIKE`, `pg_trgm`, PostgreSQL full-text search, or a combination?
4. Should withdrawal be soft-delete first, hard-delete, or both?

## 20. Initial Implementation Plan

1. Create PostgreSQL schema and indexes
2. Build JSONL incremental import/upsert script
3. Build book-level withdrawal command
4. Load sample `books.jsonl` and `entries.jsonl`
5. Add Ollama query embedding call in Next.js
6. Implement `POST /api/search` with `semantic` and `keyword` modes
7. Implement entry-level result UI as the default view
8. Add Primo VE deep links
9. Add confidence threshold control with default `0.4`
10. Add facets
11. Add book detail / TOC view
12. Evaluate semantic, keyword, and possible hybrid behavior with real research-theme queries

---

## Appendix A. 遊びフィーチャー構想メモ「意味の墨流し（Semantic Suminagashi）」

> ステータス: **アイデア段階 / 後日議論**。MVP（堅実検索）には含めない。本筋の検索フローには一切手を入れず、同じ DB（特に embeddings）だけを共有する独立機能として検討する。
> 着想元: 墨流し風のジェネラティブアート（例: https://suminagashi-fjdbyyqi.manus.space/ ）を「本の中身を探す」体験に接続できないか、という発想。

### 決定済みの方向性

- **コンセプト: A 意味の墨流し（本命）。** 埋め込み空間そのものを流体的な「蔵書の水面」として描画し、検索クエリを「墨を一滴落とす」操作にする。
- **位置づけ: 独立タブの遊び機能。** 堅実検索のリスト/ファセット UI とは分離。

### 設計原則（最重要）

> すべての視覚的ジェスチャーが実際のクエリに対応し、すべての模様が **本物の埋め込み幾何の決定論的な関数** であること。ランダムな模様は禁止。模様の渦＝蔵書の意味構造そのもの。これが「ただ綺麗なだけ」と「意味のある遊び」の分岐点。

### 体験のループ（骨格）

```
1. タブを開く → 蔵書全体が墨流しの水面として広がる（静かに揺らぐ）
2. 眺める/撫でる → テーマの帯・渦が見える。色は分類/件名。近いほど寄り集まる
3. 言葉を落とす → 検索窓に語を入れて水面をクリック＝「墨を一滴落とす」
4. 波紋が広がる → コサイン近傍の entry が発光し手前に浮上
5. 拾う → 光った見出しをクリック → heading_text / 本タイトル / Primo リンク
6. 戻る or 重ねる → もう一滴落として模様を育てる
```

裏側は本筋と同じ Ollama `bge-m3` 埋め込み。遊んでいる＝近傍探索している状態。

### データ準備（import 時に一度だけ）

- 全 entry の 1024 次元を **UMAP で 2D 射影** し、`entries.proj_x / proj_y` を DB に保存（リアルタイムにはやらない別バッチ）。
- 色 = `subjects` または `classification` をカテゴリ→色相にマップ。
- 水面の「静的な地形」はこれで決まる（決定論的）。クエリ側だけ動的: 検索語 → Ollama 埋め込み → 同じ UMAP で 2D に落とす。

### 近傍の拾い方（設計判断）

- 案1: 2D 平面距離で拾う（軽いが UMAP の局所性で意味的近さと乖離しうる）。
- 案2（**推奨**）: 発光対象は pgvector のコサイン近傍（本物）で決め、**位置だけ** 2D を使う。「遊びだが結果は本物」を担保。波紋半径と発光集合の多少のズレは「近傍を引き寄せる」演出として許容。

### 本筋検索への橋

- 浮上した見出しパネルに「この語で通常検索」ボタン → 既存 `/api/search` へ。
- 各 entry から Primo VE ディープリンク（`book_id`）と TOC PDF へ直行。
- 遊びが「入口」、堅実検索が「着地」。

### 詰めるべき技術リスク（後日議論）

1. **UMAP の新規点 transform**: 検索語を水面に落とすには学習済み UMAP モデルの保存が必要（`umap-learn` なら可）。代替案: import 時に全 entry のみ射影し、クエリは「最近傍 entry の位置に落とす」近似（モデル保存不要・軽量）。MVP はこの近似で十分な可能性。
2. **再 import で地図が動く**: 蔵書増加のたび UMAP 再計算すると全座標が変わる。遊びタブなので定期再計算で許容。
3. **5,000 点の描画**: WebGL なら余裕。Canvas2D でも可。滲み表現はシェーダ or ノイズテクスチャ。

### 次の論点（未着手）

- (a) 体験の UX モック（画面遷移）に落とす。
- (b) UMAP の新規点 transform を「学習済みモデル保存」か「最近傍落下の近似」かを決める。
