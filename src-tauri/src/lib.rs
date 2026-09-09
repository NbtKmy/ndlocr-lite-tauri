use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri::ipc::Response;

// ─── 状態機械 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BookStatus {
    Resolving,
    ResolveFailed,
    Pending,
    OcrDone,
    LlmDone,
    ReviewPending,
    Approved,
    Exported,
    ExportedNoEmbed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookManifest {
    pub book_id: String,
    pub source_pdf: String,
    pub status: BookStatus,
    pub page_count: Option<u32>,
    pub ocr_model_version: Option<String>,
    pub llm_model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve_fail_reason: Option<String>,
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data")
}

fn work_dir(app: &AppHandle, book_id: &str) -> PathBuf {
    data_dir(app).join("work").join(book_id)
}

fn now_unix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

// ─── Tauri コマンド ──────────────────────────────────────────────────────────

#[tauri::command]
async fn list_inbox(app: AppHandle) -> Result<Vec<String>, String> {
    let inbox = data_dir(&app).join("inbox");
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut pdfs: Vec<String> = fs::read_dir(&inbox)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    pdfs.sort();
    Ok(pdfs)
}

#[tauri::command]
async fn list_books(app: AppHandle) -> Result<Vec<BookManifest>, String> {
    let work = data_dir(&app).join("work");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut books = Vec::new();
    if let Ok(entries) = fs::read_dir(&work) {
        for entry in entries.filter_map(|e| e.ok()) {
            let manifest_path = entry.path().join("manifest.json");
            if manifest_path.exists() {
                if let Ok(content) = fs::read_to_string(&manifest_path) {
                    if let Ok(m) = serde_json::from_str::<BookManifest>(&content) {
                        books.push(m);
                    }
                }
            }
        }
    }
    books.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(books)
}

#[tauri::command]
async fn get_or_create_book(
    app: AppHandle,
    book_id: String,
    source_pdf: String,
) -> Result<BookManifest, String> {
    let dir = work_dir(&app, &book_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest_path = dir.join("manifest.json");
    if manifest_path.exists() {
        let content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&content).map_err(|e| e.to_string());
    }
    let manifest = BookManifest {
        book_id,
        source_pdf,
        status: BookStatus::Pending,
        page_count: None,
        ocr_model_version: None,
        llm_model: None,
        created_at: now_unix(),
        updated_at: now_unix(),
        resolve_fail_reason: None,
    };
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, json).map_err(|e| e.to_string())?;
    Ok(manifest)
}

#[tauri::command]
async fn set_book_status(
    app: AppHandle,
    book_id: String,
    status: BookStatus,
) -> Result<(), String> {
    let path = work_dir(&app, &book_id).join("manifest.json");
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut m: BookManifest = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    m.status = status;
    m.updated_at = now_unix();
    fs::write(&path, serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_stage_json(
    app: AppHandle,
    book_id: String,
    stage: String,
) -> Result<serde_json::Value, String> {
    let path = work_dir(&app, &book_id).join(format!("{stage}.json"));
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_stage_json(
    app: AppHandle,
    book_id: String,
    stage: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let dir = work_dir(&app, &book_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{stage}.json"));
    fs::write(&path, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn move_to_done(app: AppHandle, pdf_path: String) -> Result<(), String> {
    let src = PathBuf::from(&pdf_path);
    let done_dir = data_dir(&app).join("done");
    fs::create_dir_all(&done_dir).map_err(|e| e.to_string())?;
    let filename = src.file_name().ok_or("invalid path")?;
    fs::rename(&src, done_dir.join(filename)).map_err(|e| e.to_string())
}

/// デフォルト出力ディレクトリのパスを返す（設定UIのプレースホルダ表示用）
#[tauri::command]
async fn get_default_output_dir(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app).join("output").to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_book(app: AppHandle, book_id: String) -> Result<(), String> {
    let dir = work_dir(&app, &book_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // inbox PDF も削除してキャッシュ残留・重複インポートを防ぐ
    let pdf = data_dir(&app).join("inbox").join(format!("{book_id}.pdf"));
    if pdf.exists() {
        let _ = fs::remove_file(&pdf);
    }
    Ok(())
}

// ─── Ollama ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct OllamaOptions {
    num_ctx: u32,
}

#[derive(Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    options: OllamaOptions,
}

#[derive(Serialize, Deserialize, Clone)]
struct OllamaMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
}

#[tauri::command]
async fn ollama_chat(
    model: String,
    system_prompt: String,
    user_prompt: String,
    images: Option<Vec<String>>,
    json_mode: bool,
    ollama_url: Option<String>,
) -> Result<String, String> {
    let url = format!(
        "{}/api/chat",
        ollama_url.as_deref().unwrap_or("http://localhost:11434")
    );

    let user_msg = OllamaMessage {
        role: "user".to_string(),
        content: user_prompt,
        images,
    };

    let body = OllamaChatRequest {
        model,
        messages: vec![
            OllamaMessage { role: "system".to_string(), content: system_prompt, images: None },
            user_msg,
        ],
        stream: false,
        format: if json_mode { Some("json".to_string()) } else { None },
        options: OllamaOptions { num_ctx: 8192 },
    };

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama error: {}", resp.status()));
    }

    Ok(resp
        .json::<OllamaChatResponse>()
        .await
        .map_err(|e| format!("Ollama parse failed: {e}"))?
        .message
        .content)
}

#[tauri::command]
async fn ollama_embed(
    model: String,
    text: String,
    ollama_url: Option<String>,
) -> Result<Vec<f32>, String> {
    let url = format!(
        "{}/api/embed",
        ollama_url.as_deref().unwrap_or("http://localhost:11434")
    );

    #[derive(Serialize)]
    struct Req { model: String, input: String }
    #[derive(Deserialize)]
    struct Resp { embeddings: Vec<Vec<f32>> }

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&Req { model, input: text })
        .send()
        .await
        .map_err(|e| format!("Embed request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Embed error: {}", resp.status()));
    }

    resp.json::<Resp>().await
        .map_err(|e| format!("Embed parse: {e}"))?
        .embeddings
        .into_iter()
        .next()
        .ok_or_else(|| "Embed error: empty embeddings array".to_string())
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/// 任意のURLをGETしてレスポンスボディをUTF-8文字列で返す（SRU等のCORS回避用）
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("http_get failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http_get error: {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("http_get read failed: {e}"))
}

/// URLからPDFをダウンロードしてinboxディレクトリに保存、保存先フルパスを返す
#[tauri::command]
async fn download_pdf(app: AppHandle, url: String, filename: String) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download_pdf failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download_pdf error: {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("download_pdf read: {e}"))?;
    let inbox = data_dir(&app).join("inbox");
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let dest = inbox.join(&filename);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

// ─── ファイルI/O ─────────────────────────────────────────────────────────────

/// 任意のファイルをバイト列として返す（PDF等のパイプライン読み込み用）
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("read_file_bytes: {e}"))
}

/// ONNXモデルをResourcesディレクトリから読み込みバイナリで返す
/// WKWebViewのWKURLSchemeHandlerはWorkerからの大ファイルfetchをブロックするため
/// IPC経由でメインスレッドに転送し、postMessageでWorkerに渡す
#[tauri::command]
async fn read_model_file(app: AppHandle, name: String) -> Result<Response, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Invalid model name".to_string());
    }
    let path = app.path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("models")
        .join(&name);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read_model_file {name}: {e}"))?;
    Ok(Response::new(bytes))
}

// ─── 出力ライター ────────────────────────────────────────────────────────────

#[tauri::command]
async fn append_output_record(
    app: AppHandle,
    file: String,
    record: serde_json::Value,
    output_dir: Option<String>,
) -> Result<(), String> {
    let dir = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir(&app).join("output"),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&file);
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    let mut content = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&line);
    content.push('\n');
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// 指定 book_id のレコードを削除してから新レコードを末尾に書き込む（上書きupsert）
#[tauri::command]
async fn upsert_output_records(
    app: AppHandle,
    file: String,
    book_id: String,
    records: Vec<serde_json::Value>,
    output_dir: Option<String>,
) -> Result<(), String> {
    let dir = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir(&app).join("output"),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&file);

    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| {
            if line.trim().is_empty() {
                return false;
            }
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| {
                    v.get("book_id")
                        .and_then(|id| id.as_str())
                        .map(|id| id != book_id)
                })
                .unwrap_or(true)
        })
        .map(|s| s.to_string())
        .collect();

    for record in &records {
        lines.push(serde_json::to_string(record).map_err(|e| e.to_string())?);
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    };
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_output_file(app: AppHandle, file: String, output_dir: Option<String>) -> Result<String, String> {
    let dir = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir(&app).join("output"),
    };
    let path = dir.join(&file);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 目次PDFを output_dir/toc_pdf/{book_id}.pdf に書き込む（1書籍1ファイル）
#[tauri::command]
async fn write_output_pdf(
    app: AppHandle,
    book_id: String,
    bytes: Vec<u8>,
    output_dir: Option<String>,
) -> Result<String, String> {
    if book_id.contains('/') || book_id.contains('\\') || book_id.contains("..") {
        return Err("Invalid book_id".to_string());
    }
    let dir = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => data_dir(&app).join("output"),
    };
    let pdf_dir = dir.join("toc_pdf");
    fs::create_dir_all(&pdf_dir).map_err(|e| e.to_string())?;
    let path = pdf_dir.join(format!("{book_id}.pdf"));
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

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

// ─── エントリポイント ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("data");
            for sub in &["inbox", "work", "output", "done"] {
                let _ = fs::create_dir_all(data.join(sub));
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_default_output_dir,
            http_get,
            download_pdf,
            read_file_bytes,
            list_inbox,
            list_books,
            get_or_create_book,
            set_book_status,
            read_stage_json,
            write_stage_json,
            move_to_done,
            delete_book,
            ollama_chat,
            ollama_embed,
            append_output_record,
            upsert_output_records,
            read_output_file,
            write_output_pdf,
            append_output_text,
            read_model_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
