import { describe, expect, it } from 'vitest'
import {
  PLAIN_WEB_FETCH_POLICY,
  PLAIN_WEB_SEARCH_FETCH_POLICY,
  PLAIN_WEB_SEARCH_POLICY,
  plainWebSearchResult,
  plainWebSearchText,
  plainWebSections,
} from '../src/web-citation.js'

const SEARCH_RESULT = [
  '示例主题的搜索摘要。',
  'Sources:\n- [示例站点 A](https://a.example.test/page) — 一段摘要 (2026-11-01)\n- [https://b.example.test/](https://b.example.test/)\n- [](https://c.example.test/x)',
  '(Showing the first 3 sources. Refine the query for more.)',
  'Cite the relevant URLs above as markdown links in your answer.',
].join('\n\n')

describe('plain web citations', () => {
  it('drops the request for Markdown links and writes sources as title and address', () => {
    expect(plainWebSearchText(SEARCH_RESULT)).toBe(
      [
        '示例主题的搜索摘要。',
        'Sources:\n- 示例站点 A https://a.example.test/page — 一段摘要 (2026-11-01)\n- https://b.example.test/\n- https://c.example.test/x',
        '(Showing the first 3 sources. Refine the query for more.)',
      ].join('\n\n'),
    )
  })

  it('leaves other text alone and rewrites both the value and what the model reads', () => {
    expect(plainWebSearchText('没有链接的结果')).toBe('没有链接的结果')
    expect(plainWebSearchText('正文里提到 [方括号](不是来源列表)')).toBe('正文里提到 [方括号](不是来源列表)')
    const result = plainWebSearchResult({
      isError: false,
      value: SEARCH_RESULT,
      content: [{ type: 'text', text: SEARCH_RESULT }],
    })
    expect(result.value).toBe(plainWebSearchText(SEARCH_RESULT))
    expect(result.content).toEqual([{ type: 'text', text: plainWebSearchText(SEARCH_RESULT) }])
    const structured = plainWebSearchResult({ isError: false, value: { sources: [] }, content: [] })
    expect(structured.value).toEqual({ sources: [] })
  })

  it('rewrites the web sections of an assembled prompt and leaves the rest', () => {
    const sections = [
      { name: 'nekro-nxt:channel-context', text: '这个频道不显示 Markdown。' },
      { name: 'tool:web_search', text: 'cite the relevant URLs as markdown links.' },
      { name: 'tool:web_fetch', text: 'Cite the URL as a markdown link when you use its content.' },
    ]
    expect(plainWebSections(sections)).toEqual([
      sections[0],
      { name: 'tool:web_search', text: PLAIN_WEB_SEARCH_FETCH_POLICY },
      { name: 'tool:web_fetch', text: PLAIN_WEB_FETCH_POLICY },
    ])
    // Without fetch the search section does not point to it; empty sections stay empty.
    expect(
      plainWebSections([
        { name: 'tool:web_search', text: 'cite the relevant URLs as markdown links.' },
        { name: 'tool:web_fetch', text: '' },
      ]),
    ).toEqual([
      { name: 'tool:web_search', text: PLAIN_WEB_SEARCH_POLICY },
      { name: 'tool:web_fetch', text: '' },
    ])
  })
})
