const DEFAULT_TTL_SECONDS = 180
const CONFIRMATION_HINT = '请用 #c 继续回复，明确表示执行或取消这次待确认操作；系统会按这份清单判断，不会重新解析目标。'

function getRedis() {
    return typeof redis !== 'undefined' && redis?.get && redis?.set ? redis : null
}

export function pendingActionKey(userId) {
    return `AI-Plugin:pendingAction:${userId || 'unknown'}`
}

export function createPendingId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export async function savePendingAction(userId, action = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const r = getRedis()
    if (!r) return { ok: false, error: 'Redis 不可用，无法保存待确认操作。' }
    const record = {
        ...action,
        id: action.id || createPendingId(),
        userId: String(userId || ''),
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlSeconds * 1000
    }
    await r.set(pendingActionKey(userId), JSON.stringify(record), { EX: ttlSeconds })
    return { ok: true, record }
}

export async function loadPendingAction(userId) {
    const r = getRedis()
    if (!r) return null
    const raw = await r.get(pendingActionKey(userId))
    if (!raw) return null
    try {
        const record = JSON.parse(raw)
        if (!record?.type || !record?.id) return null
        if (record.expiresAt && Date.now() > Number(record.expiresAt)) {
            await clearPendingAction(userId)
            return null
        }
        return record
    } catch {
        return null
    }
}

export async function clearPendingAction(userId) {
    const r = getRedis()
    if (!r) return false
    if (r.del) {
        await r.del(pendingActionKey(userId))
        return true
    }
    await r.set(pendingActionKey(userId), '', { EX: 1 })
    return true
}

export function formatPendingActionHint() {
    return CONFIRMATION_HINT
}

export function formatPendingTtl(record = {}) {
    if (!record.expiresAt) return '短时间内'
    const seconds = Math.max(Math.ceil((Number(record.expiresAt) - Date.now()) / 1000), 1)
    return `${seconds} 秒内`
}
