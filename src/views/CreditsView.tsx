import { useI18n } from '../hooks/useI18n'

export function CreditsView() {
  const { lang } = useI18n()

  return (
    <div className="credits-view">
      <h2 className="credits-title">
        {lang === 'ja' ? 'クリエイター・帰属表示' : 'Credits & Attribution'}
      </h2>

      <section className="credits-section">
        <h3>{lang === 'ja' ? 'このアプリについて' : 'About this app'}</h3>
        <p>
          {lang === 'ja' ? (
            <>
              本ツールは国立国会図書館（NDL Lab）が開発した{' '}
              <a href="https://github.com/ndl-lab/ndlocr-lite" target="_blank" rel="noopener noreferrer">
                NDLOCR-Lite
              </a>{' '}
              をベースとしたデスクトップアプリケーション版です。図書館向けパイプライン機能（ISBN入力→目次PDF取得→OCR→LLM構造化→レビュー→JSONL出力）を搭載しています。
            </>
          ) : (
            <>
              This is a desktop application based on{' '}
              <a href="https://github.com/ndl-lab/ndlocr-lite" target="_blank" rel="noopener noreferrer">
                NDLOCR-Lite
              </a>{' '}
              developed by the National Diet Library of Japan (NDL Lab). It includes a library pipeline for table-of-contents processing (ISBN → PDF → OCR → LLM structuring → review → JSONL output).
            </>
          )}
        </p>
      </section>

      <section className="credits-section">
        <h3>{lang === 'ja' ? 'クリエイター' : 'Creators'}</h3>
        <ul className="credits-list">
          <li>
            <span className="credits-role">{lang === 'ja' ? 'OCRエンジン' : 'OCR engine'}</span>
            <span className="credits-name">
              <a href="https://github.com/ndl-lab/ndlocr-lite" target="_blank" rel="noopener noreferrer">
                NDLOCR-Lite
              </a>
              {lang === 'ja' ? ' — 国立国会図書館（NDL Lab）' : ' — National Diet Library of Japan (NDL Lab)'}
            </span>
          </li>
          <li>
            <span className="credits-role">{lang === 'ja' ? 'Web移植' : 'Web port'}</span>
            <span className="credits-name">
              <a href="https://github.com/yuta1984/ndlocrlite-web" target="_blank" rel="noopener noreferrer">
                {lang === 'ja' ? '橋本雄太' : 'Yuta Hashimoto'}
              </a>
              {lang === 'ja' ? ' — 国立歴史民俗博物館' : ' — National Museum of Japanese History'}
            </span>
          </li>
          <li>
            <span className="credits-role">{lang === 'ja' ? 'UI拡張機能（ダークモード、デザイン、画像前処理）' : 'UI enhancements (dark mode, design, image preprocessing)'}</span>
            <span className="credits-name">
              <a href="https://researchmap.jp/SoMiyagawa" target="_blank" rel="noopener noreferrer">
                {lang === 'ja' ? '宮川創' : 'So Miyagawa'}
              </a>
              {lang === 'ja' ? ' — 筑波大学' : ' — University of Tsukuba'}
            </span>
          </li>
          <li>
            <span className="credits-role">{lang === 'ja' ? 'AI校正機能' : 'AI proofreading'}</span>
            <span className="credits-name">
              {lang === 'ja' ? '小形克宏 — 一般社団法人ビブリオスタイル' : 'Katsuhiro Ogata — Bibliostyle'}
            </span>
          </li>
          <li>
            <span className="credits-role">{lang === 'ja' ? 'パイプライン・デスクトップ化' : 'Pipeline & desktop app'}</span>
            <span className="credits-name">
              <a href="https://github.com/ogwata/ndlocr-lite-web-ai" target="_blank" rel="noopener noreferrer">
                {lang === 'ja' ? '小形克宏' : 'Katsuhiro Ogata'}
              </a>
            </span>
          </li>
        </ul>
      </section>

      <section className="credits-section">
        <h3>{lang === 'ja' ? 'ライセンス' : 'License'}</h3>
        <ul className="credits-list credits-list--plain">
          <li>
            {lang === 'ja'
              ? '本プロジェクトの追加コード: MIT License'
              : 'Additional code in this project: MIT License'}
          </li>
          <li>
            {lang === 'ja'
              ? 'OCRモデル・アルゴリズム: CC BY 4.0（国立国会図書館）'
              : 'OCR model & algorithms: CC BY 4.0 (National Diet Library of Japan)'}
          </li>
        </ul>
      </section>

      <section className="credits-section">
        <h3>{lang === 'ja' ? 'リンク' : 'Links'}</h3>
        <ul className="credits-list credits-list--plain">
          <li>
            <a href="https://github.com/ogwata/ndlocr-lite-web-ai" target="_blank" rel="noopener noreferrer">
              GitHub {lang === 'ja' ? 'リポジトリ' : 'Repository'} ↗
            </a>
          </li>
          <li>
            <a href="https://github.com/ndl-lab/ndlocr-lite" target="_blank" rel="noopener noreferrer">
              NDLOCR-Lite ↗
            </a>
          </li>
        </ul>
      </section>
    </div>
  )
}
