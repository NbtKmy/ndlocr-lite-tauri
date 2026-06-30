export interface OutputConfig {
  outputDir: string  // 空文字 = デフォルト（~/Library/Application Support/.../data/output）
}

export const DEFAULT_OUTPUT_CONFIG: OutputConfig = {
  outputDir: '',
}

const STORAGE_KEY = 'ndlocr_output_config'

export function loadOutputConfig(): OutputConfig {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return { ...DEFAULT_OUTPUT_CONFIG }
  try {
    return { ...DEFAULT_OUTPUT_CONFIG, ...(JSON.parse(stored) as Partial<OutputConfig>) }
  } catch {
    return { ...DEFAULT_OUTPUT_CONFIG }
  }
}

export function saveOutputConfig(config: OutputConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
