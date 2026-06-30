/**
 * モデルのベースURLを環境に応じて返す。
 *
 * Tauri production:
 * - postbuild スクリプトで dist/models/ のシンボリックリンクを実ファイルに置換済み
 * - include_dir! でバイナリに埋め込まれ tauri://localhost/models/ でアクセス可能
 *
 * Dev / Browser:
 * - Vite が public/models/ を /models/ で配信
 */

export async function getModelBaseUrl(): Promise<string> {
  return '/models'
}
