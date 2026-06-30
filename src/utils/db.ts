/**
 * IndexedDB 低レベル操作
 * DB名: NDLOCRLiteDB, Version: 2
 * ストア: models (ONNXモデルキャッシュ), results (OCR実行履歴)
 */

import type { DBRunEntry } from '../types/db'

const DB_NAME = 'NDLOCRLiteDB'
const DB_VERSION = 2
const RESULTS_MAX = 100

let dbInstance: IDBDatabase | null = null

export function initDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      dbInstance = request.result
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains('models')) {
        db.createObjectStore('models', { keyPath: 'name' })
      }

      // Version 2: results ストアを再作成（per-run スキーマに変更）
      if (db.objectStoreNames.contains('results')) {
        db.deleteObjectStore('results')
      }
      const store = db.createObjectStore('results', { keyPath: 'id' })
      store.createIndex('by_createdAt', 'createdAt', { unique: false })
    }
  })
}

// ---- results ストア ----

export async function saveRun(entry: DBRunEntry): Promise<void> {
  const db = await initDB()

  // 100件制限: 超えたら最古を削除
  const count = await countRuns(db)
  if (count >= RESULTS_MAX) {
    const oldest = await getOldestRun(db)
    if (oldest) await deleteRun(db, oldest.id)
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite')
    const store = tx.objectStore('results')
    const req = store.put(entry)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

export async function getAllRuns(): Promise<DBRunEntry[]> {
  const db = await initDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readonly')
    const store = tx.objectStore('results')
    const index = store.index('by_createdAt')
    const req = index.getAll()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve((req.result as DBRunEntry[]).reverse())
  })
}

export async function clearResults(): Promise<void> {
  const db = await initDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite')
    const store = tx.objectStore('results')
    const req = store.clear()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

async function countRuns(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readonly')
    const store = tx.objectStore('results')
    const req = store.count()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
  })
}

async function getOldestRun(db: IDBDatabase): Promise<DBRunEntry | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readonly')
    const store = tx.objectStore('results')
    const index = store.index('by_createdAt')
    const req = index.openCursor(null, 'next') // 昇順（最古が最初）
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const cursor = req.result
      resolve(cursor ? (cursor.value as DBRunEntry) : undefined)
    }
  })
}

async function deleteRun(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite')
    const store = tx.objectStore('results')
    const req = store.delete(id)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

// ---- models ストア ----

export async function clearModels(): Promise<void> {
  const db = await initDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('models', 'readwrite')
    const store = tx.objectStore('models')
    const req = store.clear()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}
