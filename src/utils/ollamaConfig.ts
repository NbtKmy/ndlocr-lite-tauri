export interface OllamaConfig {
  model: string
  embedModel: string
  baseUrl: string
  useVision: boolean
}

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  model: 'qwen2.5:3b',
  embedModel: 'bge-m3:latest',
  baseUrl: 'http://localhost:11434',
  useVision: false,
}

const STORAGE_KEY = 'ndlocr_ollama_config'

export function loadOllamaConfig(): OllamaConfig {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return { ...DEFAULT_OLLAMA_CONFIG }
  try {
    return { ...DEFAULT_OLLAMA_CONFIG, ...(JSON.parse(stored) as Partial<OllamaConfig>) }
  } catch {
    return { ...DEFAULT_OLLAMA_CONFIG }
  }
}

export function saveOllamaConfig(config: OllamaConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
