import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { InboxView } from './views/InboxView.tsx'
import { ReviewView } from './views/ReviewView.tsx'

type View =
  | { mode: 'ocr' }
  | { mode: 'inbox' }
  | { mode: 'review'; bookId: string }

function Root() {
  const [view, setView] = useState<View>({ mode: 'ocr' })

  return (
    <>
      {/* モード切替タブ */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${view.mode === 'inbox' || view.mode === 'review' ? 'active' : ''}`}
          onClick={() => setView({ mode: 'inbox' })}
        >
          パイプライン
        </button>
        <button
          className={`mode-tab ${view.mode === 'ocr' ? 'active' : ''}`}
          onClick={() => setView({ mode: 'ocr' })}
        >
          OCR
        </button>
      </div>

      {view.mode === 'ocr' && <App />}
      {view.mode === 'inbox' && (
        <InboxView onReview={(bookId) => setView({ mode: 'review', bookId })} />
      )}
      {view.mode === 'review' && (
        <ReviewView
          bookId={view.bookId}
          onBack={() => setView({ mode: 'inbox' })}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
