import crypto from 'node:crypto'
import { Config } from './config.js'
import { formatDBTimestampToBeijing, getTodayDateStr } from './common.js'
import { vectorDB } from './vector_db.js'

const VECTOR_DOC_MAX_CHARS = 4000
const AUTO_CONTEXT_TOP_K = 6
const AUTO_CONTEXT_MAX_CHARS = 6000
const BACKFILL_HISTORY_TURNS_PER_USER = 120
const BACKFILL_GROUP_LOGS = 300

function hashText(text) {
    return crypto.createHash('sha1').update(String(text || '')).digest('hex')
}

function truncateText(text, maxChars = VECTOR_DOC_MAX_CHARS) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars) + '...'
}

function textFromParts(parts = []) {
    if (!Array.isArray(parts)) return ''
    return parts
        .map(part => part?.text ? String(part.text) : '')
        .filter(Boolean)
        .join('\n')
        .trim()
}

function normalizeCreatedAt(value, fallbackDate = '') {
    if (value) return String(value)
    if (fallbackDate) return `${fallbackDate} 12:00:00`
    return ''
}

function buildDocId(source, sourceId, text = '') {
    const base = `${source}:${sourceId}`
    if (base.length <= 220) return base
    return `${source}:${hashText(base)}:${hashText(text).slice(0, 10)}`
}

function isWorthIndexing(text) {
    const value = String(text || '').trim()
    if (value.length < 2) return false
    if (/^\[图片\]$/.test(value)) return false
    return true
}

function sourceLabel(metadata = {}) {
    const source = metadata.source
    if (source === 'group_message') return metadata.group_id ? `群聊 ${metadata.group_id}` : '群聊'
    if (source === 'user_history') return metadata.role === 'model' ? '普通对话/AI回复' : '普通对话/用户'
    if (source === 'summary_cache') return '增量总结'
    if (source === 'memory_checkpoint') return metadata.checkpoint_type === 'full' ? '全量总结' : '记忆锚点'
    if (source === 'user_profile') return '个人档案'
    return source || '记忆'
}

function canReadHit(hit = {}, options = {}) {
    const metadata = hit.metadata || {}
    const source = metadata.source || ''
    const actorUserId = String(options.actorUserId || '').trim()
    const currentGroupId = String(options.currentGroupId || '').trim()
    const isMaster = options.isMaster === true
    const allowCrossGroup = options.allowCrossGroup === true && isMaster
    const requestedUserId = String(options.userId || '').trim()
    const requestedGroupId = String(options.groupId || '').trim()

    if (requestedUserId && String(metadata.user_id || '') !== requestedUserId) return false
    if (requestedGroupId && String(metadata.group_id || '') !== requestedGroupId) return false

    if (source === 'group_message') {
        if (allowCrossGroup) return true
        const groupId = String(metadata.group_id || '')
        const userId = String(metadata.user_id || '')
        return (currentGroupId && groupId === currentGroupId) || (actorUserId && userId === actorUserId)
    }

    if (['user_history', 'summary_cache', 'memory_checkpoint', 'user_profile'].includes(source)) {
        const userId = String(metadata.user_id || '')
        if (actorUserId && userId === actorUserId) return true
        return isMaster && requestedUserId && userId === requestedUserId
    }

    return false
}

function normalizeHit(raw = {}) {
    const metadata = raw.metadata || {}
    const distance = Number(raw.distance)
    return {
        id: raw.id || '',
        text: String(raw.text || '').trim(),
        metadata,
        distance: Number.isFinite(distance) ? distance : 0,
        label: sourceLabel(metadata)
    }
}

function formatHitLine(hit, index, maxTextChars = 700) {
    const metadata = hit.metadata || {}
    const time = metadata.created_at || metadata.date_str || ''
    const timeText = time ? ` ${formatDBTimestampToBeijing(time)}` : ''
    const speaker = metadata.nickname
        ? ` ${metadata.nickname}(${metadata.user_id || ''})`
        : (metadata.user_id ? ` 用户${metadata.user_id}` : '')
    const text = truncateText(hit.text, maxTextChars)
    return `${index}. [${hit.label}${timeText}]${speaker}: ${text}`
}

export function buildGroupMessageVectorDoc(log = {}) {
    const body = truncateText(log.normalizedText || '')
    if (!isWorthIndexing(body)) return null
    const sourceId = `${log.groupId || log.group_id || ''}:${log.messageId || log.message_id || log.seq || hashText(body)}`
    const groupId = String(log.groupId || log.group_id || '')
    const userId = String(log.userId || log.user_id || '')
    const nickname = log.nickname || ''
    const createdAt = normalizeCreatedAt(log.createdAt || log.created_at)
    const imageCount = Array.isArray(log.imageMeta) ? log.imageMeta.length : 0
    const text = [
        `群聊消息`,
        groupId ? `群号: ${groupId}` : '',
        nickname || userId ? `发送者: ${nickname || '用户'}(${userId})` : '',
        createdAt ? `时间: ${createdAt}` : '',
        imageCount > 0 ? `图片: ${imageCount} 张（仅元信息）` : '',
        `内容: ${body}`
    ].filter(Boolean).join('\n')
    return {
        id: buildDocId('group_message', sourceId, text),
        text,
        metadata: {
            source: 'group_message',
            source_id: sourceId,
            group_id: groupId,
            user_id: userId,
            nickname,
            message_id: String(log.messageId || log.message_id || ''),
            created_at: createdAt,
            is_command: Boolean(log.isCommand || log.is_command),
            is_bot: Boolean(log.isBot || log.is_bot)
        }
    }
}

export function buildHistoryVectorDocs(userId, history = []) {
    const counters = new Map()
    const docs = []
    for (const turn of history || []) {
        const role = turn?.role === 'model' ? 'model' : 'user'
        const dateStr = turn?.date_str || getTodayDateStr()
        const key = `${dateStr}:${role}`
        const index = counters.get(key) || 0
        counters.set(key, index + 1)
        const rawText = textFromParts(turn?.parts || [])
        if (!isWorthIndexing(rawText)) continue
        const text = `${role === 'model' ? Config.AI_NAME : '用户'}: ${truncateText(rawText)}`
        const sourceId = `${userId}:${dateStr}:${role}:${index}`
        docs.push({
            id: buildDocId('user_history', sourceId, text),
            text,
            metadata: {
                source: 'user_history',
                source_id: sourceId,
                user_id: String(userId),
                role,
                date_str: dateStr,
                created_at: normalizeCreatedAt('', dateStr)
            }
        })
    }
    return docs
}

export function buildSummaryVectorDoc(userId, content, dateStr, source = 'summary_cache', metadata = {}) {
    const body = truncateText(content || '', VECTOR_DOC_MAX_CHARS * 2)
    if (!isWorthIndexing(body)) return null
    const sourceId = `${userId}:${dateStr}:${source}:${metadata.checkpointType || metadata.checkpoint_type || ''}`
    return {
        id: buildDocId(source, sourceId, body),
        text: body,
        metadata: {
            source,
            source_id: sourceId,
            user_id: String(userId),
            date_str: dateStr || '',
            created_at: normalizeCreatedAt('', dateStr),
            checkpoint_type: metadata.checkpointType || metadata.checkpoint_type || ''
        }
    }
}

export function buildUserProfileVectorDoc(userId, info, lastUpdated = '') {
    const body = truncateText(info || '', VECTOR_DOC_MAX_CHARS * 3)
    if (!isWorthIndexing(body)) return null
    const sourceId = `${userId}:profile`
    return {
        id: buildDocId('user_profile', sourceId, body),
        text: body,
        metadata: {
            source: 'user_profile',
            source_id: sourceId,
            user_id: String(userId),
            created_at: lastUpdated || ''
        }
    }
}

export function queueVectorDocuments(docs = []) {
    const normalized = docs.filter(Boolean)
    if (normalized.length === 0 || Config.enable_vector_memory === false) return
    setTimeout(() => {
        vectorDB.addDocuments(normalized).then(ok => {
            if (ok) logger.debug(`[AI-Plugin] 向量记忆已索引 ${normalized.length} 条文档`)
        }).catch(err => {
            logger.warn(`[AI-Plugin] 向量记忆索引异常: ${err.message}`)
        })
    }, 0)
}

export function queueVectorDocument(doc) {
    if (doc) queueVectorDocuments([doc])
}

export function queueGroupMessageVectorIndex(log) {
    queueVectorDocument(buildGroupMessageVectorDoc(log))
}

export function queueHistoryVectorIndex(userId, history = []) {
    queueVectorDocuments(buildHistoryVectorDocs(userId, history))
}

export function queueSummaryVectorIndex(userId, content, dateStr, source = 'summary_cache', metadata = {}) {
    queueVectorDocument(buildSummaryVectorDoc(userId, content, dateStr, source, metadata))
}

export function queueUserProfileVectorIndex(userId, info, lastUpdated = '') {
    queueVectorDocument(buildUserProfileVectorDoc(userId, info, lastUpdated))
}

export async function searchSemanticMemory(query, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || AUTO_CONTEXT_TOP_K, 1), 20)
    const rawLimit = Math.min(Math.max(limit * 5, 20), 80)
    const where = {}
    if (options.userId) where.user_id = String(options.userId)
    if (options.groupId) where.group_id = String(options.groupId)
    const rawHits = await vectorDB.search(query, rawLimit, Object.keys(where).length > 0 ? { where } : {})
    const seen = new Set()
    const hits = []
    for (const raw of rawHits) {
        const hit = normalizeHit(raw)
        if (!hit.id || !hit.text || seen.has(hit.id)) continue
        if (!canReadHit(hit, options)) continue
        seen.add(hit.id)
        hits.push(hit)
        if (hits.length >= limit) break
    }
    return hits
}

export function formatSemanticMemoryContext(hits = [], options = {}) {
    if (!Array.isArray(hits) || hits.length === 0) return ''
    const maxChars = Math.max(1200, Number(options.maxChars) || AUTO_CONTEXT_MAX_CHARS)
    const lines = [
        '【语义相关记忆】以下内容来自本地向量检索，只作为当前问题的相关历史线索；请结合当前聊天环境与隐私边界使用，不要把未被用户询问的隐私档案主动摊开。'
    ]
    let used = lines[0].length
    let index = 1
    for (const hit of hits) {
        const line = formatHitLine(hit, index)
        if (used + line.length + 2 > maxChars) break
        lines.push(line)
        used += line.length + 1
        index++
    }
    lines.push('【语义相关记忆结束】')
    return `\n\n${lines.join('\n')}\n`
}

export async function buildSemanticMemoryContext(db, query, options = {}) {
    if (Config.enable_vector_memory === false) return ''
    const text = String(query || '').trim()
    if (text.length < 3) return ''
    const hits = await searchSemanticMemory(text, {
        ...options,
        limit: options.limit || AUTO_CONTEXT_TOP_K
    })
    if (hits.length === 0) return ''
    logger.info(`[AI-Plugin] 向量记忆自动检索命中 ${hits.length} 条`)
    return formatSemanticMemoryContext(hits, {
        maxChars: options.maxChars || Config.VECTOR_AUTO_CONTEXT_MAX_CHARS || AUTO_CONTEXT_MAX_CHARS
    })
}

async function backfillUser(db, userId) {
    try {
        const history = await db.getConversationHistory(userId)
        if (history.length > 0) {
            queueHistoryVectorIndex(userId, history.slice(-BACKFILL_HISTORY_TURNS_PER_USER))
        }
        if (db.getAllSummaryCaches) {
            const summaries = await db.getAllSummaryCaches(userId)
            for (const summary of summaries) {
                queueSummaryVectorIndex(userId, summary.content, summary.dateStr, 'summary_cache', {
                    base_checkpoint_date: summary.baseCheckpointDate || ''
                })
            }
        }
        if (db.getAllCheckpoints) {
            const checkpoints = await db.getAllCheckpoints(userId)
            for (const checkpoint of checkpoints) {
                queueSummaryVectorIndex(userId, checkpoint.content, checkpoint.dateStr, 'memory_checkpoint', {
                    checkpoint_type: checkpoint.checkpointType || ''
                })
            }
        }
        if (db.getUserProfile) {
            const profile = await db.getUserProfile(userId)
            if (profile?.info) queueUserProfileVectorIndex(userId, profile.info, profile.lastUpdated)
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] 向量记忆回填用户 ${userId} 失败: ${err.message}`)
    }
}

export const vectorMemory = {
    async init({ db } = {}) {
        if (Config.enable_vector_memory === false) return false
        const ok = await vectorDB.init()
        if (!ok) return false
        if (db) {
            setTimeout(() => this.backfillRecent(db).catch(err => {
                logger.warn(`[AI-Plugin] 向量记忆后台回填失败: ${err.message}`)
            }), 5000)
        }
        return true
    },

    async backfillRecent(db) {
        if (!db || Config.enable_vector_memory === false) return
        const userIds = db.getAllUserIds ? await db.getAllUserIds() : []
        for (const userId of userIds.slice(0, 50)) {
            await backfillUser(db, userId)
        }
        if (db.getGroupMessageLogs) {
            const logs = await db.getGroupMessageLogs({ limit: BACKFILL_GROUP_LOGS })
            queueVectorDocuments(logs.map(log => buildGroupMessageVectorDoc(log)).filter(Boolean))
        }
        logger.info(`[AI-Plugin] 向量记忆后台回填已调度: 用户=${Math.min(userIds.length, 50)}, 群流水<=${BACKFILL_GROUP_LOGS}`)
    },

    search: searchSemanticMemory,
    formatContext: formatSemanticMemoryContext,
    buildContext: buildSemanticMemoryContext,
    queueDocument: queueVectorDocument,
    queueDocuments: queueVectorDocuments,
    queueGroupMessage: queueGroupMessageVectorIndex,
    queueHistory: queueHistoryVectorIndex,
    queueSummary: queueSummaryVectorIndex,
    queueUserProfile: queueUserProfileVectorIndex
}
