/**
 * Web search through Firecrawl that falls back to the DeepSeek Search API. Any Firecrawl failure (credits used up,
 * rate limit, bad key, outage, timeout) or a missing FIRECRAWL_API_KEY sends the same search to the registered
 * `deepseek-search-api` provider, so the agent can always search. Fetch stays on the DeepSeek Fetch API.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from '@deepseek-ai/dsh-web'

export const FIRECRAWL_SEARCH_PROVIDER_ID = 'firecrawl-search'
export const FIRECRAWL_API_KEY = credentialRef('FIRECRAWL_API_KEY')
export const FALLBACK_SEARCH_PROVIDER_ID = 'deepseek-search-api'

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search'
const FIRECRAWL_TIMEOUT_MS = 30_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const SNIPPET_CHARS = 240
const SUMMARY_CHARS = 2_000

export interface FirecrawlSearchOptions {
  /** The Firecrawl API key; undefined or empty searches through the fallback directly. */
  readonly resolveKey: () => Promise<string | undefined>
  /** Whether a key is stored, without reading it. */
  readonly keyConfigured: () => Promise<boolean>
  /** The DeepSeek Search API provider, looked up at search time. */
  readonly fallback: () => WebSearchProvider | undefined
  readonly fetch?: typeof fetch
  readonly warn?: (message: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text)

/** Validate a Firecrawl `/v2/search` response and project its web results. */
export const mapFirecrawlSearch = (payload: unknown): WebSearchSource[] => {
  if (!isRecord(payload) || payload['success'] !== true || !isRecord(payload['data'])) {
    throw new Error('invalid response body')
  }
  const web = payload['data']['web'] ?? []
  if (!Array.isArray(web)) throw new Error('invalid response body')
  return web.flatMap((item): WebSearchSource[] => {
    if (!isRecord(item) || typeof item['url'] !== 'string' || !URL.canParse(item['url'])) return []
    const title = typeof item['title'] === 'string' && item['title'].trim() !== '' ? item['title'].trim() : undefined
    const description =
      typeof item['description'] === 'string' && item['description'].trim() !== ''
        ? item['description'].trim()
        : undefined
    return [
      {
        url: item['url'],
        ...(title === undefined ? {} : { title }),
        ...(description === undefined
          ? {}
          : {
              snippet: clip(description.replace(/\s+/gu, ' '), SNIPPET_CHARS),
              summary: clip(description, SUMMARY_CHARS),
            }),
      },
    ]
  })
}

const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class FirecrawlSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_SEARCH_PROVIDER_ID
  readonly title = 'Firecrawl'
  readonly description = {
    en: 'Searches with Firecrawl; falls back to the DeepSeek Search API when Firecrawl fails or its credits run out.',
    zh: '用 Firecrawl 搜索；Firecrawl 出错或额度用完时改用 DeepSeek Search API。',
  }

  constructor(private readonly options: FirecrawlSearchOptions) {}

  available(): boolean {
    return true
  }

  async ready(llmProvider: string | undefined): Promise<boolean> {
    if (await this.options.keyConfigured().catch(() => false)) return true
    const fallback = this.options.fallback()
    return fallback === undefined ? false : ((await fallback.ready?.(llmProvider)) ?? true)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let failure: string
    try {
      const key = await this.options.resolveKey()
      if (key !== undefined && key !== '') return await this.#firecrawl(key, request, signal)
      failure = 'FIRECRAWL_API_KEY 未配置'
    } catch (error) {
      if (signal?.aborted === true) throw new WebError('web search was cancelled', 'WEB_ABORTED')
      failure = failureText(error)
    }
    const fallback = this.options.fallback()
    if (fallback === undefined) {
      throw new WebError(`Firecrawl search failed (${failure}) and no fallback is registered`, 'WEB_PROVIDER_ERROR')
    }
    this.options.warn?.(`[nekro-nxt] Firecrawl 搜索失败（${failure}），改用 DeepSeek Search API`)
    return await fallback.search(request, signal)
  }

  async #firecrawl(key: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, request.maxResults ?? DEFAULT_LIMIT))
    const timeout = AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS)
    const response = await (this.options.fetch ?? fetch)(FIRECRAWL_SEARCH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: request.query, limit }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload['error'] === 'string' ? `: ${clip(payload['error'], 200)}` : ''
      throw new Error(`HTTP ${response.status}${detail}`)
    }
    return { sources: mapFirecrawlSearch(payload).slice(0, limit), truncated: false }
  }
}

const isSearchProvider = (value: unknown): value is WebSearchProvider =>
  isRecord(value) &&
  value['id'] === FALLBACK_SEARCH_PROVIDER_ID &&
  typeof value['available'] === 'function' &&
  typeof value['search'] === 'function'

interface CredentialReader {
  resolve(ref: CredentialRef): Promise<{ readonly value: string } | undefined>
  describe(ref: CredentialRef): Promise<{ readonly configured: boolean }>
}

/**
 * Register the Firecrawl search provider on `ctx.web`. The fallback is read from the web runtime's registry at search
 * time: the seam has no public lookup by id, and reading it lazily keeps the DeepSeek plugin's own registration and
 * live settings.
 */
export function registerFirecrawlSearch(
  ctx: Context,
  credentials: CredentialReader,
  options: Pick<FirecrawlSearchOptions, 'fetch' | 'warn'> = {},
): () => void {
  const fallback = (): WebSearchProvider | undefined => {
    const providers: unknown = Reflect.get(ctx.web, 'searchProviders')
    const provider: unknown = providers instanceof Map ? providers.get(FALLBACK_SEARCH_PROVIDER_ID) : undefined
    return isSearchProvider(provider) ? provider : undefined
  }
  return ctx.web.registerSearchProvider(
    new FirecrawlSearchProvider({
      resolveKey: async () => (await credentials.resolve(FIRECRAWL_API_KEY))?.value,
      keyConfigured: async () => (await credentials.describe(FIRECRAWL_API_KEY)).configured,
      fallback,
      ...options,
    }),
  )
}
