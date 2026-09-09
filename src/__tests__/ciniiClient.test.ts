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

  it('1候補ならクエリに OR を含まない', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['978-4-16-713711-3 (pbk)'])
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113&format=json',
      15
    )
    expect(r.ncid).toBe('BB08395220')
    expect(r.hits).toBe(1)
    expect(r.queriedIsbns).toEqual(['9784167137113'])
  })

  it('複数候補は %20OR%20 でつなぎ、httpGet は1回だけ呼ばれる', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784167137113', '9784101132150'])
    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113%20OR%209784101132150&format=json',
      15
    )
    expect(r.queriedIsbns).toEqual(['9784167137113', '9784101132150'])
  })

  it('httpGet の第2引数に 15 (タイムアウト秒) を渡す', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    await lookupCiniiNcid(['9784167137113'])
    expect(httpGet.mock.calls[0][1]).toBe(15)
  })

  it('ISBN-10 の末尾 X を有効な候補として扱う', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['4-16-713711-X'])
    expect(r.queriedIsbns).toEqual(['416713711X'])
  })

  it('ISBN-10 の末尾が小文字 x でも有効な候補として扱い、大文字化して照会する', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['4-16-713711-x'])
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=416713711X&format=json',
      15
    )
    expect(r.queriedIsbns).toEqual(['416713711X'])
  })

  it('桁数が不正な候補は照会しない', async () => {
    const r = await lookupCiniiNcid(['12345', '978416713711'])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbns: [] })
  })

  it('候補が空なら httpGet を呼ばない', async () => {
    const r = await lookupCiniiNcid([])
    expect(httpGet).not.toHaveBeenCalled()
    expect(r).toEqual({ ncid: null, hits: 0, queriedIsbns: [] })
  })

  it('1件ヒットで NCID を採用し queriedIsbns は全候補になる', async () => {
    httpGet.mockResolvedValue(CINII_HIT1)
    const r = await lookupCiniiNcid(['9784167137113', '9784101132150'])
    expect(r.ncid).toBe('BB08395220')
    expect(r.hits).toBe(1)
    expect(r.queriedIsbns).toEqual(['9784167137113', '9784101132150'])
  })

  it('0件（items キーなしのフィクスチャ）なら ncid=null, hits=0 を返す', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    const r = await lookupCiniiNcid(['9784100000000'])
    expect(r.ncid).toBeNull()
    expect(r.hits).toBe(0)
    expect(r.error).toBeUndefined()
  })

  it('複数ヒットなら items[0] の NCID を採用し hits を保持する', async () => {
    httpGet.mockResolvedValue(CINII_HIT3)
    const r = await lookupCiniiNcid(['9784167137113'])
    expect(r.ncid).toBe('BB08395220')
    expect(r.hits).toBe(3)
  })

  it('NCID が解析不能でも hits は保持する（CiNii は持っているがIDが読めない場合の区別）', async () => {
    const badNcid = JSON.stringify({
      '@graph': [
        { 'opensearch:totalResults': '1', items: [{ '@id': 'https://ci.nii.ac.jp/ncid/BAD ID!' }] },
      ],
    })
    httpGet.mockResolvedValue(badNcid)
    const r = await lookupCiniiNcid(['9784167137113'])
    expect(r.ncid).toBeNull()
    expect(r.hits).toBe(1)
    expect(r.error).toBeUndefined()
  })

  it('通信失敗なら error を設定する', async () => {
    httpGet.mockRejectedValue(new Error('http_get error: 503'))
    const r = await lookupCiniiNcid(['9784100000000'])
    expect(r.ncid).toBeNull()
    expect(r.hits).toBe(0)
    expect(r.error).toContain('503')
    expect(r.queriedIsbns).toEqual(['9784100000000'])
  })

  it('本文が不正なJSONなら error を設定する', async () => {
    httpGet.mockResolvedValue('not json at all')
    const r = await lookupCiniiNcid(['9784167137113'])
    expect(r.ncid).toBeNull()
    expect(r.error).toContain('解析失敗')
    expect(r.queriedIsbns).toEqual(['9784167137113'])
  })

  it('正規化後に重複する候補は1度だけクエリに含まれる', async () => {
    httpGet.mockResolvedValue(CINII_HIT0)
    const r = await lookupCiniiNcid(['978-4-10-000000-0', '9784100000000'])
    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(httpGet).toHaveBeenCalledWith(
      'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784100000000&format=json',
      15
    )
    expect(r.queriedIsbns).toEqual(['9784100000000'])
  })
})
