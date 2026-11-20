import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { type WebSearchProvider, type WebSearchRequest } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_SEARCH_PROVIDER_ID,
  FIRECRAWL_SEARCH_PROVIDER_ID,
  mapFirecrawlSearch,
  registerFirecrawlSearch,
} from '../src/web-search-firecrawl.js'

const firecrawlBody = {
  success: true,
  data: {
    web: [
      { url: 'https://example.com/a', title: '甲', description: '第一条\n结果', position: 1 },
      { url: 'not a url', title: '坏的' },
      { url: 'https://example.com/b', description: '' },
    ],
  },
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function setup(options: { key?: string; respond?: () => Promise<Response> | Response } = {}) {
  const context = new Context()
  await context.plugin(WebRuntime, { searchProvider: FIRECRAWL_SEARCH_PROVIDER_ID })
  const fallbackSearch = vi.fn((request: WebSearchRequest) =>
    Promise.resolve({ sources: [{ url: `https://deepseek.example/${request.query}` }], truncated: false }),
  )
  const fallback: WebSearchProvider = {
    id: FALLBACK_SEARCH_PROVIDER_ID,
    available: () => true,
    search: fallbackSearch,
  }
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(options.respond?.() ?? json(200, firecrawlBody)))
  const warn = vi.fn()
  const credentials = {
    resolve: () => Promise.resolve(options.key === undefined ? undefined : { value: options.key }),
    describe: () => Promise.resolve({ configured: options.key !== undefined }),
  }
  registerFirecrawlSearch(context, credentials, { fetch: fetchMock, warn })
  // The DeepSeek plugin registers after the Firecrawl provider in the host; the lookup happens at search time.
  context.web.registerSearchProvider(fallback)
  return { context, fallbackSearch, fetchMock, warn }
}

describe('Firecrawl web search with DeepSeek fallback', () => {
  it('maps Firecrawl web results and drops entries without a valid URL', () => {
    expect(mapFirecrawlSearch(firecrawlBody)).toEqual([
      { url: 'https://example.com/a', title: '甲', snippet: '第一条 结果', summary: '第一条\n结果' },
      { url: 'https://example.com/b' },
    ])
    expect(() => mapFirecrawlSearch({ success: false })).toThrow('invalid response body')
  })

  it('searches through Firecrawl with the key and the requested result bound', async () => {
    const { context, fallbackSearch, fetchMock } = await setup({ key: 'fc-test' })
    const result = await context.web.search({ query: '豆沙包', maxResults: 3 })
    expect(result.sources.map(({ url }) => url)).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(fallbackSearch).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.firecrawl.dev/v2/search')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fc-test')
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({ query: '豆沙包', limit: 3 })
  })

  it.each([
    ['credits used up', () => json(402, { success: false, error: 'Insufficient credits' }), 'HTTP 402'],
    ['rate limited', () => json(429, { success: false, error: 'Rate limit exceeded' }), 'HTTP 429'],
    ['bad key', () => json(401, { success: false, error: 'Unauthorized: Invalid token' }), 'HTTP 401'],
    ['server error', () => new Response('<html>oops</html>', { status: 502 }), 'HTTP 502'],
    ['malformed body', () => json(200, { success: true, data: { web: 'x' } }), 'invalid response body'],
    ['network failure', () => Promise.reject(new TypeError('fetch failed')), 'fetch failed'],
  ])('falls back to the DeepSeek Search API when Firecrawl fails: %s', async (_name, respond, reason) => {
    const { context, fallbackSearch, warn } = await setup({ key: 'fc-test', respond })
    const result = await context.web.search({ query: '天气', maxResults: 5 })
    expect(result.sources).toEqual([{ url: 'https://deepseek.example/天气' }])
    expect(fallbackSearch).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason))
  })

  it('uses the fallback directly without a Firecrawl key', async () => {
    const { context, fallbackSearch, fetchMock } = await setup()
    await context.web.search({ query: '无钥匙' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fallbackSearch).toHaveBeenCalledOnce()
  })

  it('does not fall back when the search itself is cancelled', async () => {
    const controller = new AbortController()
    const { context, fallbackSearch } = await setup({
      key: 'fc-test',
      respond: () => {
        controller.abort()
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      },
    })
    await expect(context.web.search({ query: '取消' }, controller.signal)).rejects.toMatchObject({
      code: 'WEB_ABORTED',
    })
    expect(fallbackSearch).not.toHaveBeenCalled()
  })
})
