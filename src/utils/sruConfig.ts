export interface SruConfig {
  sruEndpoint: string
  holdingFilterField: string
  holdingFilterValue: string
  sourceLabel: string
  monthlySearchField: string   // ローカルフィールド番号 (例: "990")
  monthlySearchPrefix: string  // クエリプレフィックス (例: "UAOIJ-")
}

export const DEFAULT_SRU_CONFIG: SruConfig = {
  sruEndpoint: 'https://uzb.swisscovery.ch/view/sru/41SLSP_UZB',
  holdingFilterField: 'b',
  holdingFilterValue: 'UAOI',
  sourceLabel: 'SLSP/UZB',
  monthlySearchField: '990',
  monthlySearchPrefix: '',
}

const STORAGE_KEY = 'ndlocr_sru_config'

export function loadSruConfig(): SruConfig {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return { ...DEFAULT_SRU_CONFIG }
  try {
    return { ...DEFAULT_SRU_CONFIG, ...(JSON.parse(stored) as Partial<SruConfig>) }
  } catch {
    return { ...DEFAULT_SRU_CONFIG }
  }
}

export function saveSruConfig(config: SruConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
