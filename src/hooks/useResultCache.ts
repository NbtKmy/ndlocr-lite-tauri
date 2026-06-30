import { useState, useEffect, useCallback } from 'react'
import type { DBRunEntry } from '../types/db'
import { getAllRuns, saveRun, clearResults } from '../utils/db'

export function useResultCache() {
  const [runs, setRuns] = useState<DBRunEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    getAllRuns()
      .then(setRuns)
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [])

  const save = useCallback(async (entry: DBRunEntry) => {
    await saveRun(entry)
    const updated = await getAllRuns()
    setRuns(updated)
  }, [])

  const clear = useCallback(async () => {
    await clearResults()
    setRuns([])
  }, [])

  return { runs, isLoading, saveRun: save, clearResults: clear }
}
