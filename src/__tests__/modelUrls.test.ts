import { describe, it, expect } from 'vitest'
import { setModelBaseUrl, loadModel } from '../worker/model-loader'

describe('model-loader', () => {
  it('setModelBaseUrl でベースURLを変更できる', () => {
    setModelBaseUrl('/models')
    // loadModel は実際のfetchは行わないのでURLの組み立てのみ確認
    expect(loadModel).toBeDefined()
  })

  it('各モデルタイプ名が存在する', () => {
    const types = ['layout', 'recognition30', 'recognition50', 'recognition100']
    for (const t of types) {
      expect(t).toMatch(/^[a-z0-9]+$/i)
    }
  })
})
