import { createTimeoutSignal, fetchWithProxy, isAbortError, readResponseBodyTextLimited, throwIfAborted } from './common.js'

const DEFAULT_PROVIDER_TIMEOUT_MS = 25000
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_RESULT_CONTENT_CHARS = 4000

const PROVIDERS = {
    tavily: {
        name: 'Tavily',
        apiKeyEnv: 'TAVILY_API_KEY',
        keyless: true
    },
    exa: {
        name: 'Exa',
        apiKeyEnv: 'EXA_API_KEY',
        keyless: false
    },
    firecrawl: {
        name: 'Firecrawl',
        apiKeyEnv: 'FIRECRAWL_API_KEY',
        keyless: false
    }
}

function asText(value = '') {
    return String(value ?? '').trim()
}

function positiveInteger(value, fallback, min = 1, max = 20) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
}

function normalizeProviderId(value = '') {
    return asText(value).toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

function resolveApiKey(config = {}) {
    const direct = asText(config.api_key)
    if (direct) return direct
    const envName = asText(config.api_key_env)
    if (envName && asText(process.env[envName])) return asText(process.env[envName])
    const defaultEnv = PROVIDERS[config.provider]?.apiKeyEnv
    return defaultEnv ? asText(process.env[defaultEnv]) : ''
}

export function normalizeSearchProviderMode(value = 'api_first') {
    const mode = asText(value).toLowerCase()
    return ['api_first', 'hybrid', 'html_only', 'api_only'].includes(mode) ? mode : 'api_first'
}

export function normalizeSearchProviderConfigs(rawConfig = {}) {
    const source = rawConfig?.search_providers ?? rawConfig?.searchProviders ?? []
    const entries = Array.isArray(source) ? source : []
    const seen = new Set()
    const providers = []

    for (const entry of entries) {
        const raw = typeof entry === 'string' ? { provider: entry } : entry
        if (!raw || typeof raw !== 'object' || raw.enabled === false) continue
        const provider = normalizeProviderId(raw.provider || raw.id || raw.name)
        const definition = PROVIDERS[provider]
        if (!definition || seen.has(provider)) continue
        seen.add(provider)
        const apiKey = resolveApiKey({ ...raw, provider })
        providers.push({
            provider,
            name: definition.name,
            apiKey,
            configured: Boolean(apiKey) || definition.keyless === true,
            keyless: definition.keyless === true && !apiKey,
            timeoutMs: positiveInteger(raw.timeout_ms ?? raw.timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, 1000, 60000),
            maxResults: positiveInteger(raw.max_results ?? raw.maxResults, 8, 1, 20)
        })
    }
    return providers
}

function normalizePublished(value) {
    if (value === undefined || value === null || value === '') return undefined
    const timestamp = typeof value === 'number' ? value : Date.parse(String(value))
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function truncateContent(value = '') {
    const text = asText(value)
    return text.length > MAX_RESULT_CONTENT_CHARS ? text.slice(0, MAX_RESULT_CONTENT_CHARS) : text
}

function normalizeResults(providerName, items = []) {
    const results = []
    const seen = new Set()
    for (const item of Array.isArray(items) ? items : []) {
        const url = asText(item?.url || item?.link)
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
        seen.add(url)
        const content = truncateContent(item?.content || item?.text || item?.markdown || item?.description || item?.snippet)
        const result = {
            title: asText(item?.title || item?.name || url),
            url,
            snippet: content || '无摘要',
            source: providerName,
            providerContent: content
        }
        const published = normalizePublished(item?.publishedDate ?? item?.published_date ?? item?.published)
        if (published !== undefined) result.publishedAt = published
        results.push(result)
    }
    return results
}

async function readProviderResponse(response, providerName) {
    const retryAfterRaw = response?.headers?.get?.('retry-after')
    const retryAfterSeconds = Number(retryAfterRaw)
    const retryAfterDate = Number.isFinite(retryAfterSeconds) ? NaN : Date.parse(String(retryAfterRaw || ''))
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : (Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate - Date.now()) : 0)
    if (!response?.ok) {
        const body = await response.text().catch(() => '')
        const error = new Error(`${providerName} HTTP ${response?.status || 'unknown'}: ${body.slice(0, 300)}`)
        error.status = Number(response?.status) || 0
        error.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0
        throw error
    }
    const text = await readResponseBodyTextLimited(response, MAX_PROVIDER_RESPONSE_BYTES)
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(`${providerName} 返回了无法解析的 JSON`)
    }
}

async function executeTavily(config, query, count, options) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    else headers['X-Tavily-Access-Mode'] = 'keyless'
    const response = await options.fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            query,
            search_depth: 'basic',
            chunks_per_source: 3,
            max_results: Math.min(count, config.maxResults),
            include_answer: false,
            include_raw_content: false
        }),
        signal: createTimeoutSignal(config.timeoutMs, options.signal),
        timeout: config.timeoutMs,
        autoDetectProxy: true,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES
    })
    const data = await readProviderResponse(response, 'Tavily')
    return normalizeResults(config.name, data?.results)
}

async function executeExa(config, query, count, options) {
    if (!config.apiKey) throw new Error('Exa 缺少 API Key')
    const response = await options.fetchImpl('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': config.apiKey
        },
        body: JSON.stringify({
            query,
            numResults: Math.min(count, config.maxResults),
            contents: {
                text: { maxCharacters: MAX_RESULT_CONTENT_CHARS },
                highlights: { numSentences: 3 }
            }
        }),
        signal: createTimeoutSignal(config.timeoutMs, options.signal),
        timeout: config.timeoutMs,
        autoDetectProxy: true,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES
    })
    const data = await readProviderResponse(response, 'Exa')
    const results = normalizeResults(config.name, data?.results)
    for (const result of results) {
        const source = data?.results?.find(item => item?.url === result.url)
        const highlights = Array.isArray(source?.highlights) ? source.highlights.filter(Boolean).join('\n') : ''
        if (!result.providerContent && highlights) {
            result.providerContent = truncateContent(highlights)
            result.snippet = result.providerContent
        }
    }
    return results
}

async function executeFirecrawl(config, query, count, options) {
    if (!config.apiKey) throw new Error('Firecrawl 缺少 API Key')
    const response = await options.fetchImpl('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
            query,
            limit: Math.min(count, config.maxResults),
            sources: ['web'],
            scrapeOptions: {
                formats: ['markdown'],
                onlyMainContent: true
            }
        }),
        signal: createTimeoutSignal(config.timeoutMs, options.signal),
        timeout: config.timeoutMs,
        autoDetectProxy: true,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES
    })
    const data = await readProviderResponse(response, 'Firecrawl')
    const items = Array.isArray(data?.data?.web)
        ? data.data.web
        : (Array.isArray(data?.data) ? data.data : data?.web)
    return normalizeResults(config.name, items)
}

export async function executeSearchProvider(config = {}, query = '', count = 8, options = {}) {
    throwIfAborted(options.signal)
    const value = asText(query)
    if (!value) return []
    if (!config.configured) throw new Error(`${config.name || config.provider} 未配置 API Key`)
    const fetchImpl = options.fetchImpl || fetchWithProxy
    const requestOptions = { ...options, fetchImpl }
    if (config.provider === 'tavily') return executeTavily(config, value, count, requestOptions)
    if (config.provider === 'exa') return executeExa(config, value, count, requestOptions)
    if (config.provider === 'firecrawl') return executeFirecrawl(config, value, count, requestOptions)
    throw new Error(`不支持的搜索 provider: ${config.provider}`)
}

export function isSearchProviderAbort(error, signal) {
    return error?.code === 'AGENT_CANCELLED' || isAbortError(error, signal)
}

export { PROVIDERS as SEARCH_PROVIDER_DEFINITIONS }
