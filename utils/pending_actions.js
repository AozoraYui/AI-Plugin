const DEFAULT_TTL_SECONDS = 180
const CONFIRMATION_HINT = '请用 #c 继续回复，明确表示执行或取消这次待确认操作；系统会按这份清单判断，不会重新解析目标。'
const pendingLocks = new Map()

function getRedis() {
    return typeof redis !== 'undefined' && redis?.get && redis?.set ? redis : null
}

export function pendingActionKey(userId, pendingId = '') {
    const base = `AI-Plugin:pendingAction:${userId || 'unknown'}`
    return pendingId ? `${base}:${pendingId}` : base
}

export function pendingActionIndexKey(userId) {
    return `AI-Plugin:pendingActionIndex:${userId || 'unknown'}`
}

export function createPendingId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function parseRecord(raw) {
    if (!raw) return null
    try {
        const record = JSON.parse(raw)
        return record?.type && record?.id ? record : null
    } catch {
        return null
    }
}

function parseIndex(raw) {
    if (!raw) return []
    try {
        const items = JSON.parse(raw)
        return Array.isArray(items) ? items.filter(item => item?.id) : []
    } catch {
        return []
    }
}

async function withPendingLock(userId, operation) {
    const key = String(userId || 'unknown')
    const previous = pendingLocks.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const chain = previous.then(() => current)
    pendingLocks.set(key, chain)
    await previous
    try {
        return await operation()
    } finally {
        release()
        if (pendingLocks.get(key) === chain) pendingLocks.delete(key)
    }
}

async function storeIndex(r, userId, items) {
    const now = Date.now()
    const active = items
        .filter(item => Number(item.expiresAt) > now)
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
        .slice(-20)
    if (active.length === 0) {
        if (r.del) await r.del(pendingActionIndexKey(userId))
        else await r.set(pendingActionIndexKey(userId), '', { EX: 1 })
        return []
    }
    const ttlSeconds = Math.max(1, Math.ceil((Math.max(...active.map(item => Number(item.expiresAt))) - now) / 1000))
    await r.set(pendingActionIndexKey(userId), JSON.stringify(active), { EX: ttlSeconds })
    return active
}

export async function savePendingAction(userId, action = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const r = getRedis()
    if (!r) return { ok: false, error: 'Redis 不可用，无法保存待确认操作。' }
    return withPendingLock(userId, async () => {
        const now = Date.now()
        const record = {
            ...action,
            id: action.id || createPendingId(),
            userId: String(userId || ''),
            createdAt: now,
            expiresAt: now + ttlSeconds * 1000
        }
        const index = parseIndex(await r.get(pendingActionIndexKey(userId)))
            .filter(item => item.id !== record.id)
        index.push({ id: record.id, createdAt: record.createdAt, expiresAt: record.expiresAt })
        await r.set(pendingActionKey(userId, record.id), JSON.stringify(record), { EX: ttlSeconds })
        await storeIndex(r, userId, index)
        return { ok: true, record }
    })
}

export async function listPendingActions(userId) {
    const r = getRedis()
    if (!r) return []
    const index = parseIndex(await r.get(pendingActionIndexKey(userId)))
    const active = []
    for (const item of index) {
        if (Number(item.expiresAt) <= Date.now()) {
            if (r.del) await r.del(pendingActionKey(userId, item.id))
            continue
        }
        const record = parseRecord(await r.get(pendingActionKey(userId, item.id)))
        if (record && (!record.expiresAt || Date.now() <= Number(record.expiresAt))) active.push(record)
    }
    await storeIndex(r, userId, active.map(record => ({ id: record.id, createdAt: record.createdAt, expiresAt: record.expiresAt })))
    active.sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    return active
}

export async function loadPendingAction(userId, pendingId = '') {
    const r = getRedis()
    if (!r) return null
    if (pendingId) {
        const record = parseRecord(await r.get(pendingActionKey(userId, pendingId)))
        if (!record) return null
        if (record.expiresAt && Date.now() > Number(record.expiresAt)) {
            await clearPendingAction(userId, pendingId)
            return null
        }
        return record
    }
    const records = await listPendingActions(userId)
    if (records.length > 0) return records[0]

    const legacyRecord = parseRecord(await r.get(pendingActionKey(userId)))
    if (!legacyRecord) return null
    if (legacyRecord.expiresAt && Date.now() > Number(legacyRecord.expiresAt)) {
        if (r.del) await r.del(pendingActionKey(userId))
        return null
    }
    return legacyRecord
}

export async function clearPendingAction(userId, pendingId = '') {
    const r = getRedis()
    if (!r) return false
    return withPendingLock(userId, async () => {
        let targetId = pendingId
        if (!targetId) {
            const latest = await loadPendingAction(userId)
            targetId = latest?.id || ''
            if (!targetId) return false
        }

        if (r.del) await r.del(pendingActionKey(userId, targetId))
        else await r.set(pendingActionKey(userId, targetId), '', { EX: 1 })
        const index = parseIndex(await r.get(pendingActionIndexKey(userId)))
        await storeIndex(r, userId, index.filter(item => item.id !== targetId))

        const legacyRecord = parseRecord(await r.get(pendingActionKey(userId)))
        if (legacyRecord?.id === targetId) {
            if (r.del) await r.del(pendingActionKey(userId))
            else await r.set(pendingActionKey(userId), '', { EX: 1 })
        }
        return true
    })
}

export function formatPendingActionHint() {
    return CONFIRMATION_HINT
}

export function formatPendingTtl(record = {}) {
    if (!record.expiresAt) return '短时间内'
    const seconds = Math.max(Math.ceil((Number(record.expiresAt) - Date.now()) / 1000), 1)
    return `${seconds} 秒内`
}

export function parseStrictPendingDecision(record = {}, instruction = '') {
    if (!['shell_exec', 'shell_session', 'tool_call'].includes(record?.type) && record?.risk !== 'high') return null
    const normalized = String(instruction || '').replace(/^#[A-Za-z0-9_]+\s*/i, '').trim()
    if (/^(?:确认执行|确认|同意执行|继续执行|执行)$/.test(normalized)) {
        return { decision: 'confirm', reason: '高风险操作明确确认短语' }
    }
    if (/^(?:取消|取消执行|不要执行|别执行|停止)$/.test(normalized)) {
        return { decision: 'cancel', reason: '高风险操作明确取消短语' }
    }
    return { decision: 'none', reason: '高风险操作只接受明确确认或取消短语' }
}

export function parseStandalonePendingCommand(instruction = '') {
    const normalized = String(instruction || '').replace(/^\s*#(?:uc|c|pc|sc)\b\s*/i, '').trim()
    if (/^(?:确认执行|确认|同意执行|继续执行|执行)$/.test(normalized)) return 'confirm'
    if (/^(?:取消|取消执行|不要执行|别执行|停止)$/.test(normalized)) return 'cancel'
    return ''
}
