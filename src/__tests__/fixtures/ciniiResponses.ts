/**
 * CiNii Books OpenSearch API レスポンスのテストフィクスチャ
 * HIT1 / HIT0 は 2026-09-09 に実 API から取得した値。HIT3 は HIT1 の items を 3 件に増やした加工版
 */

/** ISBN 9784167137113 で 1 件ヒット */
export const CINII_HIT1 = JSON.stringify({
  '@id': 'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784167137113&format=json',
  '@graph': [
    {
      title: 'CiNii Books OpenSearch - 9784167137113',
      '@type': 'channel',
      'opensearch:totalResults': '1',
      'opensearch:startIndex': '0',
      'opensearch:itemsPerPage': '1',
      items: [
        {
          title: '夕陽カ丘三号館',
          '@id': 'https://ci.nii.ac.jp/ncid/BB08395220',
          '@type': 'item',
          'rdfs:seeAlso': { '@id': 'https://ci.nii.ac.jp/ncid/BB08395220.json' },
          'dc:date': '2012',
          'dc:creator': '有吉佐和子著',
          'dc:publisher': ['文藝春秋'],
          'cinii:ownerCount': '15',
        },
      ],
    },
  ],
})

/** ヒット 0 件。items キー自体が存在しないことが重要 */
export const CINII_HIT0 = JSON.stringify({
  '@id': 'https://ci.nii.ac.jp/books/opensearch/search?isbn=9784100000000&format=json',
  '@graph': [
    {
      title: 'CiNii Books OpenSearch - 9784100000000',
      '@type': 'channel',
      'opensearch:totalResults': '0',
      'opensearch:startIndex': '0',
      'opensearch:itemsPerPage': '0',
    },
  ],
})

/** 3 件ヒット（加工版）。先頭が採用されることを確認するため 3 件の NCID を別々にする */
export const CINII_HIT3 = JSON.stringify({
  '@graph': [
    {
      '@type': 'channel',
      'opensearch:totalResults': '3',
      items: [
        { '@id': 'https://ci.nii.ac.jp/ncid/BB08395220', title: '夕陽カ丘三号館' },
        { '@id': 'https://ci.nii.ac.jp/ncid/BN00564770', title: '夕陽カ丘三号館' },
        { '@id': 'https://ci.nii.ac.jp/ncid/BA12345678', title: '夕陽ヶ丘三号館' },
      ],
    },
  ],
})
