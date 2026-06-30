import { useState } from 'react'
import { clearResults } from '../../utils/db'
import type { AISettings, AIProvider, AIConnectionMode } from '../../types/ai'
import { DEFAULT_MODELS, DEFAULT_PROOFREAD_PROMPT } from '../../types/ai'
import type { AIConnectionStatus } from '../../hooks/useAISettings'
import type { Language } from '../../i18n'
import type { ModelConfig } from '../../types/model-config'
import { MATH_DOWNLOAD_SIZE, saveModelConfig } from '../../types/model-config'
import { loadOllamaConfig, saveOllamaConfig, DEFAULT_OLLAMA_CONFIG } from '../../utils/ollamaConfig'
import type { OllamaConfig } from '../../utils/ollamaConfig'

interface SettingsModalProps {
  onClose: () => void
  lang: Language
  aiSettings: AISettings
  onUpdateAISettings: (update: Partial<AISettings>) => void
  onSwitchProvider: (provider: AIProvider) => Promise<void>
  connectionStatus: AIConnectionStatus
  onTestConnection: () => Promise<boolean>
  modelConfig: ModelConfig
  onUpdateModelConfig: (config: ModelConfig) => void
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  groq: 'Groq',
  custom: 'Custom Endpoint',
}

export function SettingsModal({
  onClose,
  lang,
  aiSettings,
  onUpdateAISettings,
  onSwitchProvider,
  connectionStatus,
  onTestConnection,
  modelConfig,
  onUpdateModelConfig,
}: SettingsModalProps) {
  const [clearingHistory, setClearingHistory] = useState(false)
  const [clearedHistory, setClearedHistory] = useState(false)
  const [activeTab, setActiveTab] = useState<'ai' | 'ocr-model' | 'local-llm' | 'cache'>('ai')
  const [pendingModelConfig, setPendingModelConfig] = useState<ModelConfig>(modelConfig)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)
  const [ollamaDraft, setOllamaDraft] = useState<OllamaConfig>(loadOllamaConfig)
  const [ollamaSaved, setOllamaSaved] = useState(false)

  const handleTestConnection = async () => {
    setTestResult(null)
    const ok = await onTestConnection()
    setTestResult(ok ? 'success' : 'fail')
    setTimeout(() => setTestResult(null), 3000)
  }

  const handleModeChange = (mode: AIConnectionMode) => {
    onUpdateAISettings({ mode })
  }

  const handleProviderChange = async (provider: AIProvider) => {
    await onSwitchProvider(provider)
    // デフォルトモデルを設定
    const models = DEFAULT_MODELS[provider]
    if (models.length > 0) {
      onUpdateAISettings({ directApi: { ...aiSettings.directApi, provider, model: models[0] } })
    }
  }

  const statusLabel = (() => {
    switch (connectionStatus) {
      case 'connected': return lang === 'ja' ? '接続済み' : 'Connected'
      case 'connecting': return lang === 'ja' ? '接続中...' : 'Connecting...'
      case 'error': return lang === 'ja' ? '接続エラー' : 'Connection Error'
      default: return lang === 'ja' ? '未接続' : 'Disconnected'
    }
  })()

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>{lang === 'ja' ? '設定' : 'Settings'}</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        {/* タブ */}
        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'ai' ? 'active' : ''}`}
            onClick={() => setActiveTab('ai')}
          >
            {lang === 'ja' ? 'AI校正' : 'AI Proofreading'}
          </button>
          <button
            className={`settings-tab ${activeTab === 'ocr-model' ? 'active' : ''}`}
            onClick={() => setActiveTab('ocr-model')}
          >
            {lang === 'ja' ? 'OCRモデル' : 'OCR Model'}
          </button>
          <button
            className={`settings-tab ${activeTab === 'local-llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('local-llm')}
          >
            {lang === 'ja' ? 'ローカルLLM' : 'Local LLM'}
          </button>
          <button
            className={`settings-tab ${activeTab === 'cache' ? 'active' : ''}`}
            onClick={() => setActiveTab('cache')}
          >
            {lang === 'ja' ? 'キャッシュ' : 'Cache'}
          </button>
        </div>

        <div className="panel-body">
          {/* ===== AI接続タブ ===== */}
          {activeTab === 'ai' && (
            <>
              {/* 接続モード切替 */}
              <section className="settings-section">
                <h3>{lang === 'ja' ? '接続モード' : 'Connection Mode'}</h3>
                <div className="settings-mode-toggle">
                  <button
                    className={`btn ${aiSettings.mode === 'direct' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleModeChange('direct')}
                  >
                    Direct API
                  </button>
                  <button
                    className={`btn ${aiSettings.mode === 'mcp' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleModeChange('mcp')}
                  >
                    MCP Server
                  </button>
                </div>
              </section>

              {/* Direct API設定 */}
              {aiSettings.mode === 'direct' && (
                <section className="settings-section">
                  <h3>{lang === 'ja' ? 'プロバイダ' : 'Provider'}</h3>
                  <select
                    className="settings-select"
                    value={aiSettings.directApi.provider}
                    onChange={(e) => handleProviderChange(e.target.value as AIProvider)}
                  >
                    {(Object.keys(PROVIDER_LABELS) as AIProvider[]).map((p) => (
                      <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                    ))}
                  </select>

                  {/* APIキー */}
                  <h3>{lang === 'ja' ? 'APIキー' : 'API Key'}</h3>
                  <input
                    type="password"
                    className="settings-input"
                    value={aiSettings.directApi.apiKey}
                    onChange={(e) => onUpdateAISettings({
                      directApi: { ...aiSettings.directApi, apiKey: e.target.value },
                    })}
                    placeholder={lang === 'ja' ? 'APIキーを入力' : 'Enter API key'}
                  />
                  <p className="settings-description">
                    {lang === 'ja'
                      ? 'APIキーはアプリ内で暗号化して保存されます。外部サーバーには送信されません。'
                      : 'API keys are encrypted and stored within the app. They are never sent to external servers.'}
                  </p>

                  {/* モデル選択 */}
                  <h3>{lang === 'ja' ? 'モデル' : 'Model'}</h3>
                  {DEFAULT_MODELS[aiSettings.directApi.provider].length > 0 ? (
                    <select
                      className="settings-select"
                      value={aiSettings.directApi.model}
                      onChange={(e) => onUpdateAISettings({
                        directApi: { ...aiSettings.directApi, model: e.target.value },
                      })}
                    >
                      <option value="">{lang === 'ja' ? 'モデルを選択' : 'Select model'}</option>
                      {DEFAULT_MODELS[aiSettings.directApi.provider].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="settings-input"
                      value={aiSettings.directApi.model}
                      onChange={(e) => onUpdateAISettings({
                        directApi: { ...aiSettings.directApi, model: e.target.value },
                      })}
                      placeholder={lang === 'ja' ? 'モデル名を入力' : 'Enter model name'}
                    />
                  )}

                  {/* カスタムエンドポイント */}
                  {aiSettings.directApi.provider === 'custom' && (
                    <>
                      <h3>{lang === 'ja' ? 'エンドポイントURL' : 'Endpoint URL'}</h3>
                      <input
                        type="url"
                        className="settings-input"
                        value={aiSettings.directApi.endpoint ?? ''}
                        onChange={(e) => onUpdateAISettings({
                          directApi: { ...aiSettings.directApi, endpoint: e.target.value },
                        })}
                        placeholder="https://..."
                      />
                    </>
                  )}
                </section>
              )}

              {/* MCP Server設定 */}
              {aiSettings.mode === 'mcp' && (
                <section className="settings-section">
                  <h3>{lang === 'ja' ? 'MCPサーバーURL' : 'MCP Server URL'}</h3>
                  <input
                    type="url"
                    className="settings-input"
                    value={aiSettings.mcp.serverUrl}
                    onChange={(e) => onUpdateAISettings({
                      mcp: { ...aiSettings.mcp, serverUrl: e.target.value },
                    })}
                    placeholder="http://localhost:3000/mcp"
                  />
                  <p className="settings-description">
                    {lang === 'ja'
                      ? 'MCPプロトコル対応のサーバーURLを指定してください。Streamable HTTP Transportを使用します。'
                      : 'Specify the URL of your MCP-compatible server. Uses Streamable HTTP Transport.'}
                  </p>

                  <h3>{lang === 'ja' ? 'ツール名（任意）' : 'Tool Name (optional)'}</h3>
                  <input
                    type="text"
                    className="settings-input"
                    value={aiSettings.mcp.toolName ?? ''}
                    onChange={(e) => onUpdateAISettings({
                      mcp: { ...aiSettings.mcp, toolName: e.target.value || undefined },
                    })}
                    placeholder={lang === 'ja' ? '空欄で自動検出' : 'Leave empty for auto-detection'}
                  />
                </section>
              )}

              {/* 校正プロンプト */}
              <section className="settings-section">
                <h3>{lang === 'ja' ? '校正プロンプト' : 'Proofreading Prompt'}</h3>
                <textarea
                  className="settings-textarea"
                  value={aiSettings.customPrompt}
                  onChange={(e) => onUpdateAISettings({ customPrompt: e.target.value })}
                  rows={6}
                />
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => onUpdateAISettings({ customPrompt: DEFAULT_PROOFREAD_PROMPT })}
                >
                  {lang === 'ja' ? 'デフォルトに戻す' : 'Reset to Default'}
                </button>
              </section>

              {/* 接続テスト */}
              <section className="settings-section">
                <div className="settings-connection-row">
                  <button
                    className="btn btn-primary"
                    onClick={handleTestConnection}
                    disabled={connectionStatus === 'connecting'}
                  >
                    {connectionStatus === 'connecting'
                      ? (lang === 'ja' ? 'テスト中...' : 'Testing...')
                      : (lang === 'ja' ? '接続テスト' : 'Test Connection')}
                  </button>
                  <span className={`settings-connection-status status-${connectionStatus}`}>
                    {statusLabel}
                  </span>
                  {testResult === 'success' && (
                    <span className="settings-test-ok">
                      {lang === 'ja' ? '成功' : 'Success'}
                    </span>
                  )}
                  {testResult === 'fail' && (
                    <span className="settings-test-fail">
                      {lang === 'ja' ? '失敗' : 'Failed'}
                    </span>
                  )}
                </div>
              </section>
            </>
          )}

          {/* ===== OCRモデルタブ ===== */}
          {activeTab === 'ocr-model' && (
            <section className="settings-section">
              <h3>{lang === 'ja' ? '数式認識（オプション）' : 'Math Recognition (optional)'}</h3>
              <label className="settings-model-option">
                <input
                  type="checkbox"
                  checked={pendingModelConfig.mathEnabled}
                  onChange={(e) => setPendingModelConfig(prev => ({ ...prev, mathEnabled: e.target.checked }))}
                />
                <div className="settings-model-option-content">
                  <div className="settings-model-option-header">
                    <span className="settings-model-option-label">
                      {lang === 'ja' ? '数式認識を有効にする' : 'Enable math recognition'}
                    </span>
                    <span className="settings-model-option-size">+{MATH_DOWNLOAD_SIZE}</span>
                  </div>
                  <span className="settings-model-option-desc">
                    {lang === 'ja'
                      ? '数式画像をLaTeX形式で出力（MathJaxで表示）'
                      : 'Output math formulas as LaTeX (rendered with MathJax)'}
                  </span>
                </div>
              </label>

              <p className="settings-description" style={{ marginTop: '1rem' }}>
                {lang === 'ja'
                  ? '文書の言語はOCR開始ボタンの横で選択できます。言語に応じたOCRモデルが自動的にダウンロードされます。'
                  : 'Document language can be selected next to the OCR start button. The appropriate model is downloaded automatically.'}
              </p>

              {pendingModelConfig.mathEnabled !== modelConfig.mathEnabled && (
                <button
                  className="btn btn-primary"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    saveModelConfig(pendingModelConfig)
                    onUpdateModelConfig(pendingModelConfig)
                    window.location.reload()
                  }}
                >
                  {lang === 'ja' ? '適用してリロード' : 'Apply & Reload'}
                </button>
              )}
            </section>
          )}

          {/* ===== ローカルLLMタブ ===== */}
          {activeTab === 'local-llm' && (
            <section className="settings-section">
              <p className="settings-description" style={{ marginBottom: '1rem' }}>
                {lang === 'ja'
                  ? 'パイプライン専用のローカルLLM設定。OpenAI互換APIに対応しているため、Ollama以外のサーバーも使用可能。'
                  : 'Local LLM settings for the pipeline. Compatible with any OpenAI-style API endpoint, not limited to Ollama.'}
              </p>

              <h3>{lang === 'ja' ? 'API エンドポイント URL' : 'API Endpoint URL'}</h3>
              <input
                type="url"
                className="settings-input"
                value={ollamaDraft.baseUrl}
                onChange={e => setOllamaDraft(d => ({ ...d, baseUrl: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.baseUrl}
              />

              <h3>{lang === 'ja' ? '構造化LLMモデル' : 'Structuring LLM Model'}</h3>
              <input
                type="text"
                className="settings-input"
                value={ollamaDraft.model}
                onChange={e => setOllamaDraft(d => ({ ...d, model: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.model}
              />
              <p className="settings-description">
                {lang === 'ja'
                  ? '役割: PDFをOCR後、そのテキストを読み込んで誤字・誤認識を修正し、目次エントリ（見出し・階層・ページ番号）に構造化する。ビジョンOCRチェックを有効にすると、ページ画像も参照して精度を高める。'
                  : 'Role: After OCR, reads the extracted text, corrects errors and misrecognitions, and structures it into TOC entries (heading, level, page number). Enable Vision OCR Check to also reference page images for higher accuracy.'}
              </p>

              <h3>{lang === 'ja' ? '埋め込みモデル' : 'Embedding Model'}</h3>
              <input
                type="text"
                className="settings-input"
                value={ollamaDraft.embedModel}
                onChange={e => setOllamaDraft(d => ({ ...d, embedModel: e.target.value }))}
                placeholder={DEFAULT_OLLAMA_CONFIG.embedModel}
              />
              <p className="settings-description">
                {lang === 'ja'
                  ? '役割: レビュー・承認後の目次エントリと書籍情報をベクトル化し、JSONL出力に含める（意味検索用）。'
                  : 'Role: Vectorizes approved TOC entries and book metadata, storing embeddings in the JSONL output for semantic search.'}
              </p>

              <label className="settings-model-option" style={{ marginTop: '1rem' }}>
                <input
                  type="checkbox"
                  checked={ollamaDraft.useVision}
                  onChange={e => setOllamaDraft(d => ({ ...d, useVision: e.target.checked }))}
                />
                <div className="settings-model-option-content">
                  <div className="settings-model-option-header">
                    <span className="settings-model-option-label">
                      {lang === 'ja' ? 'ビジョンでOCRチェック' : 'Vision OCR Check'}
                    </span>
                  </div>
                  <span className="settings-model-option-desc">
                    {lang === 'ja'
                      ? 'ビジョン対応モデル使用時、ページ画像もLLMに送って誤字を修正（処理時間が増加）'
                      : 'Send page images to LLM for error correction when using a vision-capable model (slower)'}
                  </span>
                </div>
              </label>

              <div style={{ display: 'flex', gap: '8px', marginTop: '1rem' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => setOllamaDraft({ ...DEFAULT_OLLAMA_CONFIG })}
                >
                  {lang === 'ja' ? 'デフォルトに戻す' : 'Reset to Default'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    saveOllamaConfig(ollamaDraft)
                    setOllamaSaved(true)
                    setTimeout(() => setOllamaSaved(false), 2000)
                  }}
                >
                  {ollamaSaved
                    ? (lang === 'ja' ? '✓ 保存済み' : '✓ Saved')
                    : (lang === 'ja' ? '保存' : 'Save')}
                </button>
              </div>
            </section>
          )}

          {/* ===== キャッシュタブ ===== */}
          {activeTab === 'cache' && (
            <section className="settings-section">
              <h3>{lang === 'ja' ? 'ONNXモデル' : 'ONNX Models'}</h3>
              <p className="settings-description">
                {lang === 'ja'
                  ? 'ONNXモデルはアプリに同梱されているため、ダウンロード不要です。モデルを更新するにはアプリを再インストールしてください。'
                  : 'ONNX models are bundled with the app — no download required. To update models, reinstall the app.'}
              </p>

              <h3 style={{ marginTop: '1.2rem' }}>{lang === 'ja' ? 'OCR履歴' : 'OCR History'}</h3>
              <p className="settings-description">
                {lang === 'ja'
                  ? 'OCRタブの「履歴」パネルに表示される実行ログをクリアします（最大100件）。'
                  : 'Clears the run log shown in the OCR tab History panel (up to 100 entries).'}
              </p>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  setClearingHistory(true)
                  try {
                    await clearResults()
                    setClearedHistory(true)
                    setTimeout(() => setClearedHistory(false), 2000)
                  } catch (err) {
                    alert((err as Error).message)
                  } finally {
                    setClearingHistory(false)
                  }
                }}
                disabled={clearingHistory}
              >
                {clearedHistory
                  ? (lang === 'ja' ? '✓ クリア完了' : '✓ Cleared')
                  : clearingHistory
                    ? (lang === 'ja' ? 'クリア中...' : 'Clearing...')
                    : (lang === 'ja' ? 'OCR履歴をクリア' : 'Clear OCR History')}
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
