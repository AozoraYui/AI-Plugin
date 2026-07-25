import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from './config.js'
import { ensureDir, formatDBTimestampToBeijing, getDBTimestamp, getTodayDateStr } from './common.js'
import { vectorDB } from './vector_db.js'

const VECTOR_DOC_MAX_CHARS = 4000
const AUTO_CONTEXT_TOP_K = 6
const AUTO_CONTEXT_MAX_CHARS = 6000
const BACKFILL_HISTORY_TURNS_PER_USER = 120
const BACKFILL_GROUP_LOGS = 300
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VECTOR_STATE_FILE = path.join(PLUGIN_DIR, 'data', 'vector_index_state.json')
const VECTOR_INDEX_SCHEMA_VERSION = 2
const VECTOR_MIGRATION_BATCH_SIZE = 96
const VECTOR_TEXT_CHUNK_CHARS = 1600
const VECTOR_TEXT_CHUNK_OVERLAP = 180
const VECTOR_STATE_SOURCES = ['user_histories', 'group_message_logs', 'memory_checkpoints', 'summary_cache', 'user_profiles']
let activeMigration = null

function hashText(text) {
    return crypto.createHash('sha1').update(String(text || '')).digest('hex')
}

function truncateText(text, maxChars = VECTOR_DOC_MAX_CHARS) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars) + '...'
}

function normalizeText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function splitTextChunks(text, maxChars = VECTOR_TEXT_CHUNK_CHARS, overlap = VECTOR_TEXT_CHUNK_OVERLAP) {
    const value = normalizeText(text)
    if (!value) return []
    if (value.length <= maxChars) return [value]

    const chunks = []
    const paragraphs = value.split(/\n{2,}/).map(item => item.trim()).filter(Boolean)
    let current = ''

    const pushCurrent = () => {
        if (!current.trim()) return
        chunks.push(current.trim())
        current = ''
    }

    for (const paragraph of paragraphs) {
        if (paragraph.length > maxChars) {
            pushCurrent()
            for (let start = 0; start < paragraph.length; start += Math.max(1, maxChars - overlap)) {
                chunks.push(paragraph.slice(start, start + maxChars).trim())
            }
            continue
        }

        const next = current ? `${current}\n\n${paragraph}` : paragraph
        if (next.length > maxChars) {
            pushCurrent()
            current = paragraph
        } else {
            current = next
        }
    }
    pushCurrent()
    return chunks
}

function buildChunkedDocs(source, sourceId, body, metadata = {}, headerLines = []) {
    const chunks = splitTextChunks(body)
    if (chunks.length === 0) return []
    const docKey = `${source}:${sourceId}`
    return chunks.map((chunk, index) => {
        const idSource = `${sourceId}:chunk:${index}`
        const text = [
            ...headerLines.filter(Boolean),
            chunks.length > 1 ? `片段: ${index + 1}/${chunks.length}` : '',
            chunk
        ].filter(Boolean).join('\n')
        return {
            id: buildDocId(source, idSource, text),
            text,
            metadata: {
                ...metadata,
                source,
                source_id: sourceId,
                doc_key: docKey,
                chunk_index: index,
                chunk_count: chunks.length
            }
        }
    })
}

function readVectorState() {
    try {
        if (!fs.existsSync(VECTOR_STATE_FILE)) return null
        return JSON.parse(fs.readFileSync(VECTOR_STATE_FILE, 'utf8'))
    } catch (err) {
        logger.warn(`[AI-Plugin] 读取向量索引状态失败: ${err.message}`)
        return null
    }
}

function createVectorState(extra = {}) {
    const now = getDBTimestamp()
    return {
        schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
        modelName: vectorDB.modelName,
        dataDir: vectorDB.dataDir,
        startedAt: now,
        updatedAt: now,
        completedAt: '',
        lastIds: Object.fromEntries(VECTOR_STATE_SOURCES.map(key => [key, 0])),
        indexedRows: Object.fromEntries(VECTOR_STATE_SOURCES.map(key => [key, 0])),
        indexedDocs: Object.fromEntries(VECTOR_STATE_SOURCES.map(key => [key, 0])),
        failures: [],
        ...extra
    }
}

function writeVectorState(state) {
    ensureDir(path.dirname(VECTOR_STATE_FILE))
    const next = {
        ...state,
        updatedAt: getDBTimestamp()
    }
    fs.writeFileSync(VECTOR_STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
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
    const docs = buildGroupMessageVectorDocs(log)
    return docs[0] || null
}

export function buildGroupMessageVectorDocs(log = {}) {
    const body = normalizeText(log.normalizedText || '')
    if (!isWorthIndexing(body)) return []
    const sourceId = log.id
        ? String(log.id)
        : `${log.groupId || log.group_id || ''}:${log.messageId || log.message_id || log.seq || hashText(body)}`
    const groupId = String(log.groupId || log.group_id || '')
    const userId = String(log.userId || log.user_id || '')
    const nickname = log.nickname || ''
    const createdAt = normalizeCreatedAt(log.createdAt || log.created_at)
    const imageCount = Array.isArray(log.imageMeta) ? log.imageMeta.length : 0
    return buildChunkedDocs('group_message', sourceId, body, {
        group_id: groupId,
        user_id: userId,
        nickname,
        message_id: String(log.messageId || log.message_id || ''),
        row_id: log.id ? Number(log.id) : '',
        created_at: createdAt,
        is_command: Boolean(log.isCommand || log.is_command),
        is_bot: Boolean(log.isBot || log.is_bot)
    }, [
        `群聊消息`,
        groupId ? `群号: ${groupId}` : '',
        nickname || userId ? `发送者: ${nickname || '用户'}(${userId})` : '',
        createdAt ? `时间: ${createdAt}` : '',
        imageCount > 0 ? `图片: ${imageCount} 张（仅元信息）` : '',
        '内容:'
    ])
}

export function buildHistoryRowVectorDocs(row = {}) {
    const role = row?.role === 'model' ? 'model' : 'user'
    const dateStr = row?.date_str || getTodayDateStr()
    const rawText = textFromParts(row?.parts || [])
    if (!isWorthIndexing(rawText)) return []
    const userId = String(row.user_id || row.userId || '')
    const sourceId = row.id
        ? String(row.id)
        : `${userId}:${dateStr}:${role}:${row.source_fallback_index ?? hashText(rawText).slice(0, 12)}`
    return buildChunkedDocs('user_history', sourceId, rawText, {
        user_id: userId,
        role,
        row_id: row.id ? Number(row.id) : '',
        date_str: dateStr,
        bucket_key: `user_history:${userId}:${dateStr}`,
        created_at: normalizeCreatedAt(row.created_at || row.createdAt, dateStr)
    }, [
        `${role === 'model' ? Config.AI_NAME : '用户'}:`,
        `日期: ${dateStr}`
    ])
}

export function buildHistoryVectorDocs(userId, history = []) {
    const docs = []
    const counters = new Map()
    for (const turn of history || []) {
        const dateStr = turn?.date_str || getTodayDateStr()
        const role = turn?.role === 'model' ? 'model' : 'user'
        const rawText = textFromParts(turn?.parts || [])
        const key = `${dateStr}:${role}`
        const index = counters.get(key) || 0
        counters.set(key, index + 1)
        docs.push(...buildHistoryRowVectorDocs({
            ...turn,
            user_id: String(userId),
            id: turn.id || '',
            date_str: dateStr,
            source_fallback_index: index,
            parts: turn.parts
        }))
    }
    return docs
}

export function buildSummaryVectorDoc(userId, content, dateStr, source = 'summary_cache', metadata = {}) {
    const docs = buildSummaryVectorDocs(userId, content, dateStr, source, metadata)
    return docs[0] || null
}

export function buildSummaryVectorDocs(userId, content, dateStr, source = 'summary_cache', metadata = {}) {
    const body = normalizeText(content || '')
    if (!isWorthIndexing(body)) return []
    const checkpointType = metadata.checkpointType || metadata.checkpoint_type || ''
    const sourceSuffix = source === 'memory_checkpoint' ? (checkpointType || 'default') : 'default'
    const sourceId = `${userId}:${dateStr}:${source}:${sourceSuffix}`
    return buildChunkedDocs(source, sourceId, body, {
        user_id: String(userId),
        row_id: metadata.id || metadata.row_id ? Number(metadata.id || metadata.row_id) : '',
        date_str: dateStr || '',
        created_at: normalizeCreatedAt(metadata.createdAt || metadata.created_at, dateStr),
        checkpoint_type: checkpointType,
        base_checkpoint_date: metadata.baseCheckpointDate || metadata.base_checkpoint_date || ''
    }, [
        source === 'memory_checkpoint'
            ? (checkpointType === 'full' ? '全量总结' : '记忆锚点')
            : '增量总结',
        dateStr ? `日期: ${dateStr}` : ''
    ])
}

export function buildUserProfileVectorDoc(userId, info, lastUpdated = '') {
    const docs = buildUserProfileVectorDocs(userId, info, lastUpdated)
    return docs[0] || null
}

export function buildUserProfileVectorDocs(userId, info, lastUpdated = '') {
    const body = normalizeText(info || '')
    if (!isWorthIndexing(body)) return []
    const sourceId = `${userId}:profile`
    return buildChunkedDocs('user_profile', sourceId, body, {
        user_id: String(userId),
        created_at: lastUpdated || ''
    }, [
        '个人档案',
        `用户: ${userId}`
    ])
}

export function queueVectorDocuments(docs = []) {
    const normalized = (Array.isArray(docs) ? docs : [docs]).filter(Boolean)
    if (normalized.length === 0 || Config.enable_vector_memory === false) return
    if (activeMigration) {
        logger.debug(`[AI-Plugin] 向量迁移运行中，跳过即时索引 ${normalized.length} 条文档，后续迁移会从 SQLite 补齐`)
        return
    }
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

export function queueReplaceVectorDocuments(where = {}, docs = []) {
    const normalized = (Array.isArray(docs) ? docs : [docs]).filter(Boolean)
    if (normalized.length === 0 || Config.enable_vector_memory === false) return
    if (activeMigration) {
        logger.debug(`[AI-Plugin] 向量迁移运行中，跳过即时替换索引 ${normalized.length} 条文档，后续迁移会从 SQLite 补齐`)
        return
    }
    setTimeout(async () => {
        try {
            await vectorDB.deleteWhere(where)
            const ok = await vectorDB.addDocuments(normalized)
            if (ok) logger.debug(`[AI-Plugin] 向量记忆已替换索引 ${normalized.length} 条文档`)
        } catch (err) {
            logger.warn(`[AI-Plugin] 向量记忆替换索引异常: ${err.message}`)
        }
    }, 0)
}

export function queueDeleteVectorWhere(where = {}) {
    if (!where || typeof where !== 'object' || Object.keys(where).length === 0 || Config.enable_vector_memory === false) return
    if (activeMigration) {
        logger.debug('[AI-Plugin] 向量迁移运行中，跳过即时删除索引，后续迁移/重建会校准索引')
        return
    }
    setTimeout(() => {
        vectorDB.deleteWhere(where).catch(err => {
            logger.warn(`[AI-Plugin] 向量记忆删除索引异常: ${err.message}`)
        })
    }, 0)
}

export function queueGroupMessageVectorIndex(log) {
    queueVectorDocuments(buildGroupMessageVectorDocs(log))
}

export function queueHistoryRowsVectorIndex(rows = []) {
    queueVectorDocuments(rows.flatMap(row => buildHistoryRowVectorDocs(row)))
}

export function replaceHistoryRowsVectorIndex(userId, dateStr, rows = []) {
    queueReplaceVectorDocuments(
        { bucket_key: `user_history:${String(userId)}:${dateStr}` },
        rows.flatMap(row => buildHistoryRowVectorDocs(row))
    )
}

export function queueHistoryVectorIndex(userId, history = []) {
    queueVectorDocuments(buildHistoryVectorDocs(userId, history))
}

export function queueSummaryVectorIndex(userId, content, dateStr, source = 'summary_cache', metadata = {}) {
    const docs = buildSummaryVectorDocs(userId, content, dateStr, source, metadata)
    const docKey = docs[0]?.metadata?.doc_key
    if (docKey) queueReplaceVectorDocuments({ doc_key: docKey }, docs)
}

export function queueUserProfileVectorIndex(userId, info, lastUpdated = '') {
    const docs = buildUserProfileVectorDocs(userId, info, lastUpdated)
    const docKey = docs[0]?.metadata?.doc_key
    if (docKey) queueReplaceVectorDocuments({ doc_key: docKey }, docs)
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

function buildCheckpointRowVectorDocs(row = {}) {
    return buildSummaryVectorDocs(row.user_id, row.content, row.date_str, 'memory_checkpoint', {
        id: row.id,
        checkpoint_type: row.checkpoint_type || '',
        created_at: row.created_at || ''
    })
}

function buildSummaryRowVectorDocs(row = {}) {
    return buildSummaryVectorDocs(row.user_id, row.content, row.date_str, 'summary_cache', {
        id: row.id,
        base_checkpoint_date: row.base_checkpoint_date || '',
        created_at: row.created_at || ''
    })
}

function buildProfileRowVectorDocs(row = {}) {
    return buildUserProfileVectorDocs(row.user_id, row.info, row.last_updated)
}

async function notifyProgress(onProgress, payload) {
    if (typeof onProgress !== 'function') return
    try {
        await onProgress(payload)
    } catch (err) {
        logger.warn(`[AI-Plugin] 向量迁移进度回调失败: ${err.message}`)
    }
}

async function ensureVectorReadyForMigration() {
    if (Config.enable_vector_memory === false) {
        return { ok: false, error: '本地向量记忆未启用，请先在 models_config.yaml 设置 enable_vector_memory: true。' }
    }
    const started = await vectorDB.init()
    if (!started) {
        return { ok: false, error: vectorDB.lastError || '本地向量服务启动失败。' }
    }
    const ready = await vectorDB.waitForReady(60000)
    if (!ready) {
        return { ok: false, error: vectorDB.lastError || '本地向量服务尚未就绪。' }
    }
    return { ok: true }
}

async function migrateIdSource({ db, state, sourceKey, label, totalCount, fetchRows, buildDocs, batchSize, onProgress }) {
    let lastId = Math.max(0, Number(state.lastIds?.[sourceKey]) || 0)
    let rowCount = 0
    let docCount = 0

    while (true) {
        const rows = await fetchRows(lastId, batchSize)
        if (!Array.isArray(rows) || rows.length === 0) break

        const docs = []
        for (const row of rows) {
            try {
                docs.push(...buildDocs(row))
            } catch (err) {
                state.failures.push({
                    source: sourceKey,
                    id: row?.id || '',
                    error: err.message,
                    at: getDBTimestamp()
                })
            }
            if (row?.id) lastId = Math.max(lastId, Number(row.id) || lastId)
        }

        if (docs.length > 0) {
            const ok = await vectorDB.addDocuments(docs)
            if (!ok) throw new Error(vectorDB.lastError || `${label} 写入向量库失败`)
        }

        rowCount += rows.length
        docCount += docs.length
        state.lastIds[sourceKey] = lastId
        state.indexedRows[sourceKey] = (state.indexedRows[sourceKey] || 0) + rows.length
        state.indexedDocs[sourceKey] = (state.indexedDocs[sourceKey] || 0) + docs.length
        state = writeVectorState(state)

        await notifyProgress(onProgress, {
            phase: 'batch',
            source: sourceKey,
            label,
            processedRows: rowCount,
            processedDocs: docCount,
            lastId,
            totalCount
        })
    }

    await notifyProgress(onProgress, {
        phase: 'source_done',
        source: sourceKey,
        label,
        processedRows: rowCount,
        processedDocs: docCount,
        lastId,
        totalCount
    })

    return { state, rowCount, docCount, lastId }
}

async function migrateProfiles({ db, state, onProgress }) {
    const rows = await db.getVectorProfileRows()
    let docCount = 0
    for (let i = 0; i < rows.length; i += VECTOR_MIGRATION_BATCH_SIZE) {
        const batch = rows.slice(i, i + VECTOR_MIGRATION_BATCH_SIZE)
        const docs = batch.flatMap(row => buildProfileRowVectorDocs(row))
        if (docs.length > 0) {
            const ok = await vectorDB.addDocuments(docs)
            if (!ok) throw new Error(vectorDB.lastError || '个人档案写入向量库失败')
        }
        docCount += docs.length
        state.indexedRows.user_profiles = i + batch.length
        state.indexedDocs.user_profiles = docCount
        state = writeVectorState(state)
        await notifyProgress(onProgress, {
            phase: 'batch',
            source: 'user_profiles',
            label: '个人档案',
            processedRows: i + batch.length,
            processedDocs: docCount,
            totalCount: rows.length
        })
    }
    await notifyProgress(onProgress, {
        phase: 'source_done',
        source: 'user_profiles',
        label: '个人档案',
        processedRows: rows.length,
        processedDocs: docCount,
        totalCount: rows.length
    })
    return { state, rowCount: rows.length, docCount }
}

async function runVectorMigration(db, options = {}) {
    if (!db) return { ok: false, error: '数据库未就绪。' }
    const ready = await ensureVectorReadyForMigration()
    if (!ready.ok) return ready

    const rebuild = options.rebuild === true
    const onProgress = options.onProgress
    const batchSize = Math.max(10, Math.min(Number(options.batchSize) || VECTOR_MIGRATION_BATCH_SIZE, 500))
    const startedAt = Date.now()
    const sqliteCounts = await db.getVectorSourceCounts()

    let state = rebuild ? null : readVectorState()
    if (state && (state.schemaVersion !== VECTOR_INDEX_SCHEMA_VERSION || state.modelName !== vectorDB.modelName)) {
        return {
            ok: false,
            needRebuild: true,
            error: '向量索引版本或 embedding 模型已变化，请使用 #ai向量重建 重新生成索引。'
        }
    }

    if (rebuild) {
        await notifyProgress(onProgress, { phase: 'reset', label: '清空向量索引' })
        const resetOk = await vectorDB.reset()
        if (!resetOk) return { ok: false, error: vectorDB.lastError || '向量索引重置失败。' }
        state = createVectorState({ mode: 'rebuild' })
    } else if (!state) {
        state = createVectorState({ mode: 'migrate' })
    } else {
        state = {
            ...createVectorState({ mode: state.mode || 'migrate' }),
            ...state,
            schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
            modelName: vectorDB.modelName,
            dataDir: vectorDB.dataDir
        }
    }

    state.startedAt = state.startedAt || getDBTimestamp()
    state = writeVectorState(state)

    const totals = { rows: 0, docs: 0 }
    const sourceResults = {}
    const addResult = (key, result) => {
        sourceResults[key] = {
            rows: result.rowCount || 0,
            docs: result.docCount || 0,
            lastId: result.lastId || state.lastIds?.[key] || 0
        }
        totals.rows += result.rowCount || 0
        totals.docs += result.docCount || 0
    }

    addResult('user_histories', await migrateIdSource({
        db,
        state,
        sourceKey: 'user_histories',
        label: '普通对话',
        totalCount: sqliteCounts.user_histories?.count || 0,
        fetchRows: (lastId, limit) => db.getVectorHistoryRowsAfter(lastId, limit),
        buildDocs: buildHistoryRowVectorDocs,
        batchSize,
        onProgress
    }))
    state = readVectorState() || state

    addResult('group_message_logs', await migrateIdSource({
        db,
        state,
        sourceKey: 'group_message_logs',
        label: '畅聊群流水',
        totalCount: sqliteCounts.group_message_logs?.count || 0,
        fetchRows: (lastId, limit) => db.getVectorGroupMessageRowsAfter(lastId, limit),
        buildDocs: buildGroupMessageVectorDocs,
        batchSize,
        onProgress
    }))
    state = readVectorState() || state

    addResult('memory_checkpoints', await migrateIdSource({
        db,
        state,
        sourceKey: 'memory_checkpoints',
        label: '全量/锚点总结',
        totalCount: sqliteCounts.memory_checkpoints?.count || 0,
        fetchRows: (lastId, limit) => db.getVectorCheckpointRowsAfter(lastId, Math.max(20, Math.floor(limit / 2))),
        buildDocs: buildCheckpointRowVectorDocs,
        batchSize,
        onProgress
    }))
    state = readVectorState() || state

    addResult('summary_cache', await migrateIdSource({
        db,
        state,
        sourceKey: 'summary_cache',
        label: '增量总结',
        totalCount: sqliteCounts.summary_cache?.count || 0,
        fetchRows: (lastId, limit) => db.getVectorSummaryRowsAfter(lastId, Math.max(20, Math.floor(limit / 2))),
        buildDocs: buildSummaryRowVectorDocs,
        batchSize,
        onProgress
    }))
    state = readVectorState() || state

    addResult('user_profiles', await migrateProfiles({ db, state, onProgress }))
    state = readVectorState() || state

    state.completedAt = getDBTimestamp()
    state.lastCounts = sqliteCounts
    state.lastRun = {
        rebuild,
        rows: totals.rows,
        docs: totals.docs,
        elapsedMs: Date.now() - startedAt
    }
    state = writeVectorState(state)

    const stats = await vectorDB.stats()
    return {
        ok: true,
        rebuild,
        elapsedMs: Date.now() - startedAt,
        rows: totals.rows,
        docs: totals.docs,
        sources: sourceResults,
        sqliteCounts,
        vectorStats: stats,
        state
    }
}

export async function migrateVectorMemoryFromSQLite(db, options = {}) {
    if (activeMigration) {
        return { ok: false, running: true, error: '已有向量迁移任务正在运行。' }
    }
    activeMigration = runVectorMigration(db, options)
    try {
        return await activeMigration
    } finally {
        activeMigration = null
    }
}

export async function getVectorMemoryStatus(db) {
    const sqliteCounts = db?.getVectorSourceCounts ? await db.getVectorSourceCounts().catch(err => ({ error: err.message })) : null
    const stats = await vectorDB.stats()
    return {
        enabled: Config.enable_vector_memory === true,
        running: Boolean(activeMigration),
        schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
        modelName: vectorDB.modelName,
        dataDir: vectorDB.dataDir,
        stateFile: VECTOR_STATE_FILE,
        state: readVectorState(),
        sqliteCounts,
        vectorStats: stats
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
        const counts = db.getVectorSourceCounts ? await db.getVectorSourceCounts() : {}
        if (db.getVectorHistoryRowsAfter) {
            const maxId = Number(counts.user_histories?.maxId) || 0
            const rows = await db.getVectorHistoryRowsAfter(Math.max(0, maxId - BACKFILL_HISTORY_TURNS_PER_USER), BACKFILL_HISTORY_TURNS_PER_USER)
            queueHistoryRowsVectorIndex(rows)
        }
        if (db.getVectorGroupMessageRowsAfter) {
            const maxId = Number(counts.group_message_logs?.maxId) || 0
            const rows = await db.getVectorGroupMessageRowsAfter(Math.max(0, maxId - BACKFILL_GROUP_LOGS), BACKFILL_GROUP_LOGS)
            queueVectorDocuments(rows.flatMap(log => buildGroupMessageVectorDocs(log)))
        }
        if (db.getVectorCheckpointRowsAfter) {
            const maxId = Number(counts.memory_checkpoints?.maxId) || 0
            const rows = await db.getVectorCheckpointRowsAfter(Math.max(0, maxId - 100), 100)
            queueVectorDocuments(rows.flatMap(row => buildCheckpointRowVectorDocs(row)))
        }
        if (db.getVectorSummaryRowsAfter) {
            const maxId = Number(counts.summary_cache?.maxId) || 0
            const rows = await db.getVectorSummaryRowsAfter(Math.max(0, maxId - 200), 200)
            queueVectorDocuments(rows.flatMap(row => buildSummaryRowVectorDocs(row)))
        }
        if (db.getVectorProfileRows) {
            const rows = await db.getVectorProfileRows()
            queueVectorDocuments(rows.flatMap(row => buildProfileRowVectorDocs(row)))
        }
        logger.info('[AI-Plugin] 向量记忆后台轻量回填已调度')
    },

    search: searchSemanticMemory,
    formatContext: formatSemanticMemoryContext,
    buildContext: buildSemanticMemoryContext,
    getStatus: getVectorMemoryStatus,
    migrateFromSQLite: migrateVectorMemoryFromSQLite,
    queueDocument: queueVectorDocument,
    queueDocuments: queueVectorDocuments,
    replaceDocuments: queueReplaceVectorDocuments,
    deleteWhere: queueDeleteVectorWhere,
    queueGroupMessage: queueGroupMessageVectorIndex,
    queueHistory: queueHistoryVectorIndex,
    queueSummary: queueSummaryVectorIndex,
    queueUserProfile: queueUserProfileVectorIndex
}
