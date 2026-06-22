/**
 * モデルのベースURLを環境に応じて返す。
 *
 * Tauri production:
 * - frontendDist が dist/ に設定されているので、dist/models/ のファイルが
 *   bundled app から /models/ でアクセス可能
 * - public/models -> src-tauri/resources/models のシンボリックリンク
 * - npm run build で dist/models/ にコピーされる
 *
 * Dev / Browser:
 * - Vite が public/models/ を /models/ で配信
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isDev = import.meta.env.DEV

export async function getModelBaseUrl(): Promise<string> {
  // すべてのモード（dev/prod Tauri/browser）で /models を使用
  // dist/models はビルド時に自動的にコピーされ、production でもアクセス可能
  console.log('[modelPath] Using /models path')
  console.log('[modelPath] isTauri:', isTauri, 'isDev:', isDev)
  return '/models'
}
