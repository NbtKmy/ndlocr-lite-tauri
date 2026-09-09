import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../pipeline/api', () => ({
  pipeline: { httpGet: vi.fn() },
}))

import { pipeline } from '../pipeline/api'
import { lookupCiniiNcid, parseCiniiResponse } from '../ai/cinii-client'
import { CINII_HIT1, CINII_HIT0, CINII_HIT3 } from './fixtures/ciniiResponses'

const httpGet = vi.mocked(pipeline.httpGet)

describe('parseCiniiResponse', () => {
  it('1件ヒットで NCID を抽出する', () => {
    expect(parseCiniiResponse(CINII_HIT1)).toEqual({ hits: 1, ncid: 'BB08395220' })
  })

  it('0件（items キーなし）でも例外を投げず ncid=null を返す', () => {
    expect(parseCiniiResponse(CINII_HIT0)).toEqual({ hits: 0, ncid: null })
  })

  it('複数ヒットで先頭の NCID を採用し hits を保持する', () => {
    expect(parseCiniiResponse(CINII_HIT3)).toEqual({ hits: 3, ncid: 'BB08395220' })
  })

  it('NCID の形式が不正なら ncid=null を返す', () => {
    const bad = JSON.stringify({
      '@graph': [
        {
          'opensearch:totalResults': '1',
          items: [{ '@id': 'https://ci.nii.ac.jp/ncid/BAD ID!' }],
        },
      ],
    })
    expect(parseCiniiResponse(bad)).toEqual({ hits: 1, ncid: null })
  })
})

describe('lookupCiniiNcid', () => {
  beforeEach(() => {
    httpGet.mockReset()
  })

  it('ハイフンと付記を除去した ISBN で照会する', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['978-4-16-713711-3 (pbk)'])
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113&format=json'
    )
    expect(r.ncid).toBe('BB08395220')
    expect(r.hits).toBe(1)
    expect(r.queriedIsbn).toBe('9784167137113')
  })

  it('ISBN-10 の末尾 X を有効な候補として扱う', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['4-16-713711-X'])
    expect(r.queriedIsbn).toBe('416713711X')
  })

  it('ISBN-10 の末尾が小文字 x でも有効な候補として扱い、大文字化して照会する', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['4-16-713711-x'])
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=416713711X&format=json'
    )
    expect(r.queriedIsbn).toBe('416713711X')
  })

  it('桁数が不正な候補は照会しない', async () => {
    const r = await lookupCiniiNcid(['12345', '978416713711'])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbn: null })
  })

  it('候補が空なら httpGet を呼ばない', async () => {
    const r = await lookupCiniiNcid([])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbn: null })
  })

  it('1番目が0件・2番目がヒットなら2番目を採用する', async () => {
    httpGet.mockResolvedValueOnce(CINII_HIT0).mockResolvedValueOnce(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784100000000', '9784167137113'])
    expect(httpGet).toHaveBeenCalledTimes(2)
    expect(r.ncid).toBe('BB08395220')
    expect(r.queriedIsbn).toBe('9784167137113')
  })

  it('全候補0件なら error を設定せず最後の候補を queriedIsbn に入れる', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    const r = await lookupCiniiNcid(['9784100000000', '9784200000000'])
    expect(r.ncid).toBeNull()
    expect(r.hits).toBe(0)
    expect(r.queriedIsbn).toBe('9784200000000')
    expect(r.error).toBeUndefined()
  })

  it('全候補で通信失敗なら error を設定する', async () => {
    httpGet.mockRejectedValue(new Error('http_get error: 503'))
    const r = await lookupCiniiNcid(['9784100000000'])
    expect(r.ncid).toBeNull()
    expect(r.error).toContain('503')
    expect(r.queriedIsbn).toBe('9784100000000')
  })

  it('本文が不正なJSONなら error を設定する', async () => {
    httpGet.mockResolvedValue('not json at all')
    const r = await lookupCiniiNcid(['9784167137113'])
    expect(r.ncid).toBeNull()
    expect(r.error).toContain('解析失敗')
    expect(r.queriedIsbn).toBe('9784167137113')
  })

  it('0件と通信失敗が混在する場合は error を設定しない', async () => {
    httpGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(CINII_HIT0)
    const r = await lookupCiniiNcid(['9784100000000', '9784200000000'])
    expect(r.ncid).toBeNull()
    expect(r.error).toBeUndefined()
  })

  it('正規化後に重複する候補は1度しか照会しない', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    await lookupCiniiNcid(['978-4-10-000000-0', '9784100000000'])
    expect(httpGet).toHaveBeenCalledTimes(1)
  })

  it('NCID 形式が不正な候補は採用せず次の候補に進む', async () => {
    const badNcid = JSON.stringify({
      '@graph': [
        { 'opensearch:totalResults': '1', items: [{ '@id': 'https://ci.nii.ac.jp/ncid/BAD ID!' }] },
      ],
    })
    httpGet.mockResolvedValueOnce(badNcid).mockResolvedValueOnce(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784100000000', '9784167137113'])
    expect(r.ncid).toBe('BB08395220')
    expect(r.queriedIsbn).toBe('9784167137113')
  })
})
