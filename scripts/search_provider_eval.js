import assert from 'node:assert/strict'

globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} }

const {
    executeSearchProvider,
    normalizeSearchProviderConfigs,
    normalizeSearchProviderMode
} = await import('../utils/search_providers.js')

function response(data, options = {}) {
    return {
        ok: options.ok !== false,
        status: options.status || 200,
        headers: {
            get(name) {
                return String(name).toLowerCase() === 'retry-after' ? options.retryAfter || null : null
            }
        },
        async text() {
            return JSON.stringify(data)
        }
    }
}

const configs = normalizeSearchProviderConfigs({
    search_providers: [
        { provider: 'tavily', api_key: 'tavily-key', max_results: 6 },
        { provider: 'exa', api_key: 'exa-key', timeout_ms: 12000 },
        { provider: 'firecrawl', api_key_env: 'AI_PLUGIN_UNSET_FIRECRAWL_KEY' },
        { provider: 'unknown', api_key: 'ignored' }
    ]
})
assert.deepEqual(configs.map(item => item.provider), ['tavily', 'exa', 'firecrawl'])
assert.equal(configs[0].maxResults, 6)
assert.equal(configs[1].timeoutMs, 12000)
assert.equal(configs[2].configured, false)
assert.equal(normalizeSearchProviderMode('hybrid'), 'hybrid')
assert.equal(normalizeSearchProviderMode('invalid'), 'api_first')

let tavilyRequest = null
const tavilyResults = await executeSearchProvider(configs[0], '测试查询', 8, {
    async fetchImpl(url, options) {
        tavilyRequest = { url, options }
        return response({
            results: [
                { title: 'Tavily 结果', url: 'https://example.com/tavily', content: 'Tavily 返回的正文内容', published_date: '2026-10-20' },
                { title: '重复结果', url: 'https://example.com/tavily', content: '重复内容' }
            ]
        })
    }
})
assert.equal(tavilyRequest.url, 'https://api.tavily.com/search')
assert.equal(tavilyRequest.options.headers.Authorization, 'Bearer tavily-key')
assert.equal(tavilyResults.length, 1)
assert.equal(tavilyResults[0].source, 'Tavily')
assert.match(tavilyResults[0].snippet, /正文内容/)
assert.equal(Number.isFinite(tavilyResults[0].publishedAt), true)

const keylessConfig = normalizeSearchProviderConfigs({ search_providers: ['tavily'] })[0]
let keylessHeaders = null
await executeSearchProvider(keylessConfig, '无密钥查询', 3, {
    async fetchImpl(url, options) {
        keylessHeaders = options.headers
        return response({ results: [] })
    }
})
assert.equal(keylessHeaders['X-Tavily-Access-Mode'], 'keyless')
assert.equal(keylessHeaders.Authorization, undefined)

const exaResults = await executeSearchProvider(configs[1], 'Exa 查询', 5, {
    async fetchImpl(url, options) {
        assert.equal(url, 'https://api.exa.ai/search')
        assert.equal(options.headers['x-api-key'], 'exa-key')
        return response({
            results: [{ title: 'Exa 结果', url: 'https://example.com/exa', text: '', highlights: ['重点一', '重点二'] }]
        })
    }
})
assert.equal(exaResults[0].providerContent, '重点一\n重点二')

const firecrawlConfig = { ...configs[2], configured: true, apiKey: 'firecrawl-key' }
const firecrawlResults = await executeSearchProvider(firecrawlConfig, 'Firecrawl 查询', 5, {
    async fetchImpl(url, options) {
        assert.equal(url, 'https://api.firecrawl.dev/v2/search')
        assert.equal(options.headers.Authorization, 'Bearer firecrawl-key')
        return response({
            data: {
                web: [{ title: 'Firecrawl 结果', url: 'https://example.com/firecrawl', description: '抓取摘要' }]
            }
        })
    }
})
assert.equal(firecrawlResults[0].snippet, '抓取摘要')

await assert.rejects(
    () => executeSearchProvider(configs[0], '限流查询', 5, {
        async fetchImpl() {
            return response({ error: 'rate limited' }, { ok: false, status: 429, retryAfter: '3' })
        }
    }),
    error => error.status === 429 && error.retryAfterMs === 3000
)

console.log('Search provider eval: passed')
