import assert from 'node:assert/strict'

global.logger = {
    info() {},
    debug() {},
    warn() {},
    error() {}
}

const { fetchWithProxy, isAbortError, readResponseBodyTextLimited } = await import('../utils/common.js')
const { fetchHttpWithRecovery, webFetchTool } = await import('../tools/web_fetch.js')
const { weatherTool } = await import('../tools/weather.js')
const { toolRegistry } = await import('../tools/registry.js')

async function testLimitedResponseBody() {
    const small = await readResponseBodyTextLimited(new Response('hello', {
        headers: { 'content-length': '5' }
    }), 1024)
    assert.equal(small, 'hello')

    await assert.rejects(
        () => readResponseBodyTextLimited(new Response('x'.repeat(2048)), 1024),
        /响应体超过 1024 字节上限/
    )
}

async function testTimeoutAndCancellationAreDistinguished() {
    const cancellation = new AbortController()
    cancellation.abort()
    const cancelled = new Error('请求已取消')
    cancelled.code = 'AGENT_CANCELLED'
    assert.equal(isAbortError(cancelled, cancellation.signal), true)

    const timeoutSignal = AbortSignal.timeout(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    await assert.rejects(
        () => fetchWithProxy('http://127.0.0.1:1', { signal: timeoutSignal, allowPrivateNetwork: true }),
        error => error.code === 'ETIMEDOUT' && error.message === '请求超时'
    )
    assert.equal(isAbortError({ code: 'ETIMEDOUT', message: '请求超时' }, timeoutSignal), false)
}

async function testWebFetchHttpRecoveryRotatesProfiles() {
    const statuses = [403, 406, 200]
    const profiles = []
    const result = await fetchHttpWithRecovery('https://example.com/article', {
        profiles: [
            { name: 'desktop', headers: { 'User-Agent': 'desktop' } },
            { name: 'compatible', headers: { 'User-Agent': 'compatible' } },
            { name: 'mobile', headers: { 'User-Agent': 'mobile' } },
        ],
        allowDirectFallback: false,
    }, async (_url, options) => {
        profiles.push(options.headers['User-Agent'])
        const status = statuses.shift()
        return { status, ok: status >= 200 && status < 300, headers: new Headers() }
    })
    assert.equal(result.response.status, 200)
    assert.equal(result.profile, 'mobile')
    assert.equal(result.attempts, 3)
    assert.deepEqual(profiles, ['desktop', 'compatible', 'mobile'])
}

async function testWebFetchHttpRecoveryStopsOnRateLimit() {
    let calls = 0
    const result = await fetchHttpWithRecovery('https://example.com/article', {
        profiles: [{ name: 'desktop', headers: {} }, { name: 'compatible', headers: {} }],
        allowDirectFallback: false,
    }, async () => {
        calls++
        return { status: 429, ok: false, headers: new Headers({ 'retry-after': '30' }) }
    })
    assert.equal(result.response.status, 429)
    assert.equal(result.profile, 'desktop')
    assert.equal(result.attempts, 1)
    assert.equal(calls, 1)
}

async function testWebFetchHttpRecoveryCancellationDuringRetry() {
    const controller = new AbortController()
    const promise = fetchHttpWithRecovery('https://example.com/article', {
        profiles: [{ name: 'desktop', headers: {} }, { name: 'compatible', headers: {} }],
        allowDirectFallback: false,
        signal: controller.signal,
    }, async () => ({ status: 403, ok: false, headers: new Headers() }))
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(promise, error => error.code === 'AGENT_CANCELLED' || error.name === 'AbortError')
}

async function testWebFetchCancellationPropagates() {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        () => webFetchTool.execute({ url: 'https://example.com' }, { signal: controller.signal }),
        error => error.code === 'AGENT_CANCELLED'
    )
}

async function testWeatherCancellationPropagates() {
    const previousAmapKey = toolRegistry.weatherApiKey
    const previousOpenWeatherMapKey = toolRegistry.openWeatherMapApiKey
    toolRegistry.weatherApiKey = 'test-amap-key'
    toolRegistry.openWeatherMapApiKey = null
    const controller = new AbortController()
    controller.abort()
    try {
        await assert.rejects(
            () => weatherTool.execute({ city: '北京' }, { signal: controller.signal }),
            error => error.code === 'AGENT_CANCELLED'
        )
    } finally {
        toolRegistry.weatherApiKey = previousAmapKey
        toolRegistry.openWeatherMapApiKey = previousOpenWeatherMapKey
    }
}

await testLimitedResponseBody()
await testTimeoutAndCancellationAreDistinguished()
await testWebFetchHttpRecoveryRotatesProfiles()
await testWebFetchHttpRecoveryStopsOnRateLimit()
await testWebFetchHttpRecoveryCancellationDuringRetry()
await testWebFetchCancellationPropagates()
await testWeatherCancellationPropagates()
console.log('Network eval: 7 passed, 0 failed')
