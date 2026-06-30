import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { InboxView } from './views/InboxView.tsx'
import { ReviewView } from './views/ReviewView.tsx'
import { CreditsView } from './views/CreditsView.tsx'
import { AppBar } from './components/layout/AppBar.tsx'
import { useTheme } from './hooks/useTheme.ts'
import { useI18n } from './hooks/useI18n.ts'

type View =
  | { mode: 'inbox' }
  | { mode: 'review'; bookId: string }
  | { mode: 'credits' }

function Root() {
  const [view, setView] = useState<View>({ mode: 'inbox' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const { lang, toggleLanguage } = useI18n()

  const mainView = view.mode === 'review' ? 'inbox' : view.mode as 'inbox' | 'credits'

  return (
    <>
      <AppBar
        lang={lang}
        onToggleLang={toggleLanguage}
        theme={theme}
        onToggleTheme={toggleTheme}
        view={mainView}
        onViewChange={(v) => setView({ mode: v })}
        onOpenSettings={() => setSettingsOpen(v => !v)}
      />

      {(view.mode === 'inbox' || view.mode === 'review') && (
        <InboxView
          onReview={(bookId) => setView({ mode: 'review', bookId })}
          settingsOpen={settingsOpen}
          onSettingsClose={() => setSettingsOpen(false)}
          hidden={view.mode === 'review'}
        />
      )}
      {view.mode === 'review' && (
        <ReviewView
          bookId={view.bookId}
          onBack={() => setView({ mode: 'inbox' })}
        />
      )}
      {view.mode === 'credits' && <CreditsView />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
