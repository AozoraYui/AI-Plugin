const DEFAULT_FAILURE_THRESHOLD = 2
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000
const DEFAULT_BLOCK_COOLDOWN_MS = 5 * 60 * 1000
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000

export function buildSearchAttemptKey(provider, query) {
    return `${String(provider || '').trim()}\u0000${String(query || '').replace(/\s+/g, ' ').trim()}`
}

export function parseRetryAfterMs(value, now = Date.now(), maxMs = MAX_RETRY_AFTER_MS) {
    if (value === undefined || value === null || value === '') return 0
    const raw = String(value).trim()
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs)
    const timestamp = Date.parse(raw)
    if (!Number.isFinite(timestamp)) return 0
    return Math.max(0, Math.min(timestamp - now, maxMs))
}

export function classifySearchFailure(error = {}) {
    const status = Number(error.status || error.statusCode || error.response?.status || 0)
    const message = String(error.message || error.cause?.message || error || '').toLowerCase()
    if (status === 429 || /rate.?limit|too many requests|请求过于频繁|访问频繁/.test(message)) return 'rate_limited'
    if ([403, 406, 407, 418].includes(status) || /captcha|challenge|forbidden|blocked|拦截|验证码|验证页/.test(message)) return 'blocked'
    if ([408, 504].includes(status) || /timeout|timed out|超时|socket hang up|econnreset|eai_again|fetch failed/.test(message)) return 'timeout'
    if (/parse|json|html|selector|解析|格式/.test(message)) return 'parse_failed'
    return 'network'
}

function createState() {
    return {
        failures: 0,
        unavailableUntil: 0,
        lastFailureType: '',
        lastError: '',
        lastRetryAfterMs: 0
    }
}

export function createSearchHealthManager(options = {}) {
    const failureThreshold = Math.max(1, Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD)
    const cooldownMs = Math.max(0, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS)
    const rateLimitCooldownMs = Math.max(0, Number(options.rateLimitCooldownMs) || DEFAULT_RATE_LIMIT_COOLDOWN_MS)
    const blockCooldownMs = Math.max(0, Number(options.blockCooldownMs) || DEFAULT_BLOCK_COOLDOWN_MS)
    const states = new Map()

    function getState(name) {
        if (!states.has(name)) states.set(name, createState())
        return states.get(name)
    }

    function check(name, now = Date.now()) {
        const state = getState(name)
        if (state.unavailableUntil > now) {
            return {
                allowed: false,
                status: 'skipped',
                reason: 'circuit_open',
                cooldownUntil: state.unavailableUntil,
                state: { ...state }
            }
        }
        return { allowed: true, status: 'ready', state: { ...state } }
    }

    function recordSuccess(name) {
        states.set(name, createState())
        return { ...states.get(name) }
    }

    function recordFailure(name, error = {}, now = Date.now()) {
        const state = getState(name)
        const failureType = classifySearchFailure(error)
        const explicitRetryAfterMs = Number(error.retryAfterMs)
        const retryAfterMs = Number.isFinite(explicitRetryAfterMs) && explicitRetryAfterMs >= 0
            ? Math.min(explicitRetryAfterMs, MAX_RETRY_AFTER_MS)
            : parseRetryAfterMs(error.retryAfter ?? error.response?.headers?.get?.('retry-after'), now)
        const failures = state.failures + 1
        let cooldown = 0
        if (failureType === 'rate_limited') cooldown = Math.max(rateLimitCooldownMs, retryAfterMs)
        else if (failureType === 'blocked') cooldown = blockCooldownMs
        else if (failures >= failureThreshold) cooldown = cooldownMs
        state.failures = failures
        state.unavailableUntil = cooldown > 0 ? now + cooldown : 0
        state.lastFailureType = failureType
        state.lastError = String(error.message || error).slice(0, 300)
        state.lastRetryAfterMs = retryAfterMs
        return {
            failures,
            failureType,
            cooldownMs: cooldown,
            cooldownUntil: state.unavailableUntil,
            retryAfterMs,
            state: { ...state }
        }
    }

    function snapshot(names = [], now = Date.now()) {
        return names.map(name => {
            const state = getState(name)
            return {
                name,
                status: state.unavailableUntil > now ? 'cooldown' : 'ready',
                failures: state.failures,
                failureType: state.lastFailureType,
                cooldownUntil: state.unavailableUntil,
                lastError: state.lastError
            }
        })
    }

    function clear() {
        states.clear()
    }

    return { check, recordSuccess, recordFailure, snapshot, clear }
}
