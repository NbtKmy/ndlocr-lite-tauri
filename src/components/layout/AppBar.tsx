import { memo } from 'react'
import { LANGUAGES, LANGUAGE_LABELS } from '../../i18n'
import type { Language } from '../../i18n'
import type { Theme } from '../../hooks/useTheme'

interface AppBarProps {
  lang: Language
  onToggleLang: (e: React.ChangeEvent<HTMLSelectElement>) => void
  theme: Theme
  onToggleTheme: () => void
  view: 'inbox' | 'credits'
  onViewChange: (v: 'inbox' | 'credits') => void
  onOpenSettings: () => void
}

export const AppBar = memo(function AppBar({
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
  view,
  onViewChange,
  onOpenSettings,
}: AppBarProps) {
  return (
    <header className="app-bar">
      <div className="app-bar-left">
        <span className="app-bar-title">NDLOCR Lite for TOC</span>
        <nav className="app-bar-tabs">
          <button
            className={`app-bar-tab ${view === 'inbox' ? 'active' : ''}`}
            onClick={() => onViewChange('inbox')}
          >
            {lang === 'ja' ? 'パイプライン' : 'Pipeline'}
          </button>
          <button
            className={`app-bar-tab ${view === 'credits' ? 'active' : ''}`}
            onClick={() => onViewChange('credits')}
          >
            {lang === 'ja' ? 'クリエイター' : 'Credits'}
          </button>
        </nav>
      </div>

      <div className="app-bar-right">
        <button
          className="app-bar-btn"
          onClick={onOpenSettings}
          title={lang === 'ja' ? 'パイプライン設定' : 'Pipeline settings'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{lang === 'ja' ? '設定' : 'Settings'}</span>
        </button>

        <button
          className="app-bar-btn app-bar-btn--icon"
          onClick={onToggleTheme}
          title={theme === 'dark'
            ? (lang === 'ja' ? 'ライトモードに切替' : 'Switch to light mode')
            : (lang === 'ja' ? 'ダークモードに切替' : 'Switch to dark mode')}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <select
          className="app-bar-select"
          value={lang}
          onChange={onToggleLang}
          title={lang === 'ja' ? '言語切替' : 'Language'}
        >
          {LANGUAGES.map(code => (
            <option key={code} value={code}>{LANGUAGE_LABELS[code]}</option>
          ))}
        </select>
      </div>
    </header>
  )
})
