/**
 * テキストのダウンロード・クリップボードコピー
 */

export function downloadText(text: string, fileName: string): void {
  const baseName = fileName.replace(/\.[^/.]+$/, '')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${baseName}_ocr.txt`
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
