import { open } from '@tauri-apps/plugin-dialog'

/** ネイティブフォルダ選択ダイアログを開き、選択パスを返す。キャンセルは null */
export async function pickFolder(title = '出力フォルダを選択'): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title,
  })
  if (typeof result === 'string' && result.length > 0) return result
  return null
}
