/**
 * 目次PDF出力（1書籍1ファイル、ファイル名は book_id/MMS ID）
 * pdf-lib + IPAexゴシック（TrueType）で日本語をサブセット埋め込み
 */
import { PDFDocument, PDFFont, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { ReviewedEntry } from '../pipeline/types'
import type { SruMetadata } from '../ai/sru-client'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 50
const INDENT_PER_LEVEL = 16

let cachedFontBytes: ArrayBuffer | null = null

async function loadFontBytes(): Promise<ArrayBuffer> {
  if (cachedFontBytes) return cachedFontBytes
  const res = await fetch('/fonts/ipaexg.ttf')
  if (!res.ok) throw new Error(`フォント読み込み失敗: ${res.status}`)
  cachedFontBytes = await res.arrayBuffer()
  return cachedFontBytes
}

function levelFontSize(level: number): number {
  if (level <= 1) return 14
  if (level === 2) return 12
  return 10.5
}

/** 日本語は単語区切りがないため1文字単位で幅を測って折り返す */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    const test = current + ch
    if (current && font.widthOfTextAtSize(test, size) > maxWidth) {
      lines.push(current)
      current = ch
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

export async function generateTocPdf(meta: SruMetadata, entries: ReviewedEntry[]): Promise<Uint8Array> {
  const fontBytes = await loadFontBytes()
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)
  const font = await pdfDoc.embedFont(fontBytes, { subset: true })

  const title = meta.titleOriginal ?? meta.titleRomanized ?? meta.mmsId

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const ensureSpace = (need: number) => {
    if (y - need < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      y = PAGE_HEIGHT - MARGIN
    }
  }

  const drawLine = (text: string, x: number, size: number, color = rgb(0, 0, 0)) => {
    page.drawText(text, { x, y, size, font, color })
  }

  // タイトル
  const titleLines = wrapText(title, font, 18, PAGE_WIDTH - MARGIN * 2)
  for (const line of titleLines) {
    ensureSpace(18 + 4)
    drawLine(line, MARGIN, 18)
    y -= 18 + 4
  }
  y -= 10

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: rgb(0.6, 0.6, 0.6),
  })
  y -= 20

  for (const entry of entries) {
    const size = levelFontSize(entry.level)
    const indent = MARGIN + Math.max(0, entry.level - 1) * INDENT_PER_LEVEL
    const maxWidth = PAGE_WIDTH - MARGIN - indent

    const headingLines = wrapText(entry.heading_text, font, size, maxWidth)
    for (const line of headingLines) {
      ensureSpace(size + 4)
      drawLine(line, indent, size)
      y -= size + 4
    }

    if (entry.contributor) {
      const contribLines = wrapText(entry.contributor, font, 9, maxWidth - 10)
      for (const line of contribLines) {
        ensureSpace(13)
        drawLine(line, indent + 10, 9, rgb(0.35, 0.35, 0.35))
        y -= 13
      }
    }
    y -= 6
  }

  return pdfDoc.save()
}
