/**
 * Web Crypto API を使った APIキーの暗号化/復号化
 * localStorage に保存する際に平文ではなく暗号化して保存する
 */

const STORAGE_KEY_PREFIX = 'ndlocr_ai_'
const KEY_NAME = 'ndlocr_crypto_key'

/** 暗号化キーを取得（なければ生成してIndexedDBに保存） */
async function getOrCreateKey(): Promise<CryptoKey> {
  // IndexedDB から既存キーを取得
  const existing = await loadKeyFromIDB()
  if (existing) return existing

  // 新規生成
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // extractable = false（セキュリティのため）
    ['encrypt', 'decrypt'],
  )
  await saveKeyToIDB(key)
  return key
}

function openKeyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ndlocr_crypto', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveKeyToIDB(key: CryptoKey): Promise<void> {
  const db = await openKeyDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite')
    tx.objectStore('keys').put(key, KEY_NAME)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function loadKeyFromIDB(): Promise<CryptoKey | null> {
  const db = await openKeyDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readonly')
    const req = tx.objectStore('keys').get(KEY_NAME)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

/** 文字列を暗号化してBase64文字列として返す */
async function encrypt(plaintext: string): Promise<string> {
  const key = await getOrCreateKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  )
  // iv + ciphertext を結合してBase64に
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

/** Base64暗号文を復号して元の文字列を返す */
async function decrypt(base64: string): Promise<string> {
  const key = await getOrCreateKey()
  const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  )
  return new TextDecoder().decode(decrypted)
}

/** APIキーを暗号化して localStorage に保存 */
export async function saveApiKey(provider: string, apiKey: string): Promise<void> {
  if (!apiKey) {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${provider}`)
    return
  }
  const encrypted = await encrypt(apiKey)
  localStorage.setItem(`${STORAGE_KEY_PREFIX}${provider}`, encrypted)
}

/** localStorage から暗号化済みAPIキーを復号して返す */
export async function loadApiKey(provider: string): Promise<string> {
  const encrypted = localStorage.getItem(`${STORAGE_KEY_PREFIX}${provider}`)
  if (!encrypted) return ''
  try {
    return await decrypt(encrypted)
  } catch {
    // キーが変わったなどで復号できない場合は空文字を返す
    return ''
  }
}
