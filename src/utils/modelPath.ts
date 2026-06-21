/**
 * モデルのベースURLを環境に応じて返す。
 * - Tauri production : asset:// プロトコルでリソースディレクトリから配信
 * - Tauri dev / ブラウザ : Vite が public/models/ を /models/ で配信
 *
 * public/models/ は src-tauri/resources/models/ へのシンボリックリンクなので
 * dev と production でファイルは同一のものを参照する。
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isDev = import.meta.env.DEV

export async function getModelBaseUrl(): Promise<string> {
  // dev（Tauri dev / ブラウザ）: Vite が /models/ でサーブ
  if (!isTauri || isDev) return '/models'

  // production Tauri: Tauri v2 asset:// リソースプロトコル
  // tauri.conf.json で "resources/models/*.onnx": "models/" として定義されているため
  // リソースは app.bundle.resources に基づいて $RESOURCE/models/ にマップされる
  try {
    // Tauri v2: convertFileSrc は不要、直接 asset:// URLを使用
    // リソースはデフォルトで asset://localhost/<resource_path> でアクセス可能
    const url = 'asset://localhost/models'
    console.log('[modelPath] Using production Tauri asset protocol:', url)
    return url
  } catch (err) {
    console.error('[modelPath] Error in asset protocol:', err)
    // fallback
    return 'asset://localhost/models'
  }
}
