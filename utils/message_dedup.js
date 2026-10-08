const MESSAGE_DEDUP_TTL_MS = 2 * 60 * 1000
const recentMessages = new Map()

function getBotId(event = {}) {
    return String(event.self_id || event.bot?.uin || event.bot?.self_id || '').trim()
}

export function buildMessageDedupKey(event = {}, scope = 'default') {
    const messageId = String(event.message_id || event.seq || event.source?.seq || '').trim()
    if (!messageId) return ''
    return [String(scope || 'default').trim(), getBotId(event), String(event.group_id || '').trim(), String(event.user_id || '').trim(), messageId].join(':')
}

export function claimMessageDedup(event = {}, scope = 'default', now = Date.now()) {
    if (typeof scope === 'number') {
        now = scope
        scope = 'default'
    }
    const key = buildMessageDedupKey(event, scope)
    if (!key) return { duplicate: false, key: '' }
    const existing = recentMessages.get(key)
    if (existing && existing.expiresAt > now) return { duplicate: true, key }
    const expiresAt = now + MESSAGE_DEDUP_TTL_MS
    recentMessages.set(key, { expiresAt })
    const timer = setTimeout(() => {
        const current = recentMessages.get(key)
        if (current?.expiresAt === expiresAt) recentMessages.delete(key)
    }, MESSAGE_DEDUP_TTL_MS)
    timer.unref?.()
    return { duplicate: false, key, expiresAt }
}

export function clearMessageDedupForTests() {
    recentMessages.clear()
}
