/**
 * モデルファイルのロード管理
 * すべてのモード（dev/prod, Tauri/browser）で /models/ からfetch
 * prod Tauri: dist/models/ がbundled appリソースとしてアクセス可能
 * dev: public/models/ が Vite で /models/ として配信
 * IndexedDBキャッシュはローカルファイル読み込みのため廃止
 */

import type { RecognitionLanguage } from '../types/model-config'

export const MODEL_VERSION = '1.0.0'

// ワーカー初期化時に useOCRWorker から渡されるベースURL
let _modelBaseUrl = '/models'

export function setModelBaseUrl(url: string) {
  _modelBaseUrl = url
}

// IPC経由でメインスレッドから転送されたモデルバッファのキャッシュ
const _preloadedBuffers = new Map<string, ArrayBuffer>()

export function setPreloadedBuffer(modelType: string, buffer: ArrayBuffer) {
  _preloadedBuffers.set(modelType, buffer)
}

function getModelUrl(modelType: string): string {
  const base = _modelBaseUrl
  const map: Record<string, string> = {
    layout:              `${base}/deim-s-1024x1024.onnx`,
    recognition30:       `${base}/parseq-ndl-30.onnx`,
    recognition50:       `${base}/parseq-ndl-50.onnx`,
    recognition100:      `${base}/parseq-ndl-100.onnx`,
    recognitionEuropean: `${base}/parseq-multilingual.onnx`,
    mathEncoder:         `${base}/mfr-encoder.onnx`,
    mathDecoder:         `${base}/mfr-decoder.onnx`,
  }
  return map[modelType]
}

async function downloadWithProgress(
  url: string,
  onProgress?: (progress: number) => void
): Promise<ArrayBuffer> {
  console.log(`[model-loader] Fetching from: ${url}`)
  const response = await fetch(url)

  if (!response.ok) {
    console.error(`[model-loader] Fetch failed: status=${response.status}, url=${url}`)
    throw new Error(`HTTP error! status: ${response.status} url: ${url}`)
  }
  console.log(`[model-loader] Fetch succeeded, content-type: ${response.headers.get('content-type')}`)

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    throw new Error(`Model file not found (HTML returned): ${url}`)
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
  let receivedLength = 0
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    receivedLength += value.length
    if (onProgress && contentLength > 0) {
      onProgress(receivedLength / contentLength)
    }
  }

  const allChunks = new Uint8Array(receivedLength)
  let position = 0
  for (const chunk of chunks) {
    allChunks.set(chunk, position)
    position += chunk.length
  }

  return allChunks.buffer
}

export async function loadModel(
  modelType: string,
  onProgress?: (progress: number) => void,
  _language?: RecognitionLanguage
): Promise<ArrayBuffer> {
  const preloaded = _preloadedBuffers.get(modelType)
  if (preloaded) {
    console.log(`[model-loader] Using preloaded buffer for ${modelType}`)
    onProgress?.(1)
    return preloaded
  }

  const modelUrl = getModelUrl(modelType)
  if (!modelUrl) {
    throw new Error(`Unknown model type: ${modelType}`)
  }
  console.log(`Loading model ${modelType} from ${modelUrl}`)
  return downloadWithProgress(modelUrl, onProgress)
}

// 後方互換用（SettingsModal などから参照されている場合のため残す）
export async function clearModelCache(): Promise<void> {
  // IndexedDBキャッシュ廃止のため何もしない
}
