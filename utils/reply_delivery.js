import { pluginLogger } from './plugin_logger.js'
import crypto from 'node:crypto'
import { classifyMessageSendFailure, extractMessageSendError } from './message_delivery.js'

const DEFAULT_MAX_CHARS = 3500
const DEFAULT_MAX_BYTES = 3500
const DELIVERY_CACHE_TTL_MS = 30 * 60 * 1000
const DELIVERY_PERSIST_TTL_MS = 24 * 60 * 60 * 1000
const DELIVERY_CACHE_MAX_ENTRIES = 1024
const DELIVERY_CACHE_KEY = '__AI_PLUGIN_REPLY_DELIVERY_CACHE__'
const deliveryCache = global[DELIVERY_CACHE_KEY] instanceof Map
    ? global[DELIVERY_CACHE_KEY]
    : (global[DELIVERY_CACHE_KEY] = new Map())

function normalizeDeliveryPart(value) {
    return String(value ?? '').trim().slice(0, 1000)
}

function hashDeliveryValue(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

export function buildDeliveryKey({
    requestId = '',
    taskId = '',
    stepId = '',
    targetId = '',
    method = '',
    segmentIndex = 0,
    message = '',
    scope = '',
    toolCallId = ''
} = {}) {
    const parts = [
        'ai-delivery-v1',
        normalizeDeliveryPart(scope),
        normalizeDeliveryPart(requestId),
        normalizeDeliveryPart(taskId),
        normalizeDeliveryPart(stepId),
        normalizeDeliveryPart(targetId),
        normalizeDeliveryPart(method),
        normalizeDeliveryPart(toolCallId),
        String(Number.isFinite(Number(segmentIndex)) ? Number(segmentIndex) : 0),
        hashDeliveryValue(message)
    ]
    return parts.join(':')
}

function pruneDeliveryCache(now = Date.now()) {
    for (const [key, entry] of deliveryCache) {
        if (entry.status !== 'pending' && now - entry.createdAt > DELIVERY_CACHE_TTL_MS) {
            deliveryCache.delete(key)
        }
    }
    while (deliveryCache.size > DELIVERY_CACHE_MAX_ENTRIES) {
        const oldestKey = deliveryCache.keys().next().value
        if (oldestKey === undefined) break
        const oldest = deliveryCache.get(oldestKey)
        if (oldest?.status === 'pending') break
        deliveryCache.delete(oldestKey)
    }
}

function logDelivery(logger, level, logPrefix, message) {
    logger?.[level]?.(`${logPrefix} ${message}`)
}

function formatDeliveryContext(context = {}) {
    const requestId = normalizeDeliveryPart(context.requestId) || '-'
    const taskId = normalizeDeliveryPart(context.taskId || context.agentTaskId) || '-'
    const stepId = normalizeDeliveryPart(context.stepId) || '-'
    const targetId = normalizeDeliveryPart(context.targetId) || '-'
    const toolCallId = normalizeDeliveryPart(context.toolCallId) || '-'
    return `request=${requestId}, task=${taskId}, step=${stepId}, tool=${toolCallId}, target=${targetId}`
}

function getDeliveryDatabase() {
    const db = global.AIPluginConversationManager?.db
    if (!db || typeof db.getOutboundDeliveryState !== 'function' || typeof db.saveOutboundDeliveryState !== 'function') return null
    return db
}

async function loadPersistedDeliveryState(deliveryKey, logger, logPrefix) {
    const db = getDeliveryDatabase()
    if (!db) return null
    try {
        return await db.getOutboundDeliveryState(deliveryKey)
    } catch (error) {
        logger?.warn?.(`${logPrefix} 读取持久化投递状态失败，继续按首次发送处理: key=${deliveryKey}, 原因=${error?.message || String(error)}`)
        return null
    }
}

function compactDeliveryResult(result) {
    if (result === undefined || result === null) return result
    if (typeof result !== 'object') return result
    const output = {}
    for (const key of ['status', 'retcode', 'message_id', 'messageId', 'seq', 'error', 'msg']) {
        if (result[key] !== undefined && result[key] !== null) output[key] = result[key]
    }
    if (result.data && typeof result.data === 'object') {
        const data = {}
        for (const key of ['status', 'retcode', 'message_id', 'messageId', 'seq', 'error', 'msg']) {
            if (result.data[key] !== undefined && result.data[key] !== null) data[key] = result.data[key]
        }
        if (Object.keys(data).length > 0) output.data = data
    }
    return output
}

async function persistDeliveryState(deliveryKey, outcome, entry, logger, logPrefix) {
    const db = getDeliveryDatabase()
    if (!db) return false
    try {
        await db.saveOutboundDeliveryState({
            deliveryKey,
            status: outcome.status,
            result: compactDeliveryResult(outcome.result),
            error: outcome.error,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            expiresAt: entry.createdAt + DELIVERY_PERSIST_TTL_MS
        })
        return true
    } catch (error) {
        logger?.warn?.(`${logPrefix} 写入持久化投递状态失败，当前进程仍保留幂等状态: key=${deliveryKey}, status=${outcome.status}, 原因=${error?.message || String(error)}`)
        return false
    }
}

export function getDeliveryState(deliveryKey) {
    const entry = deliveryCache.get(String(deliveryKey || ''))
    if (!entry) return null
    return {
        key: String(deliveryKey),
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        outcome: entry.outcome
    }
}

export function clearDeliveryState(deliveryKey = '') {
    if (deliveryKey) return deliveryCache.delete(String(deliveryKey))
    deliveryCache.clear()
    return true
}

export async function executeIdempotentDelivery({
    deliveryKey = '',
    send,
    logger = pluginLogger,
    logPrefix = '[AI-Plugin]',
    deliveryContext = {}
} = {}) {
    const key = String(deliveryKey || '').trim()
    if (!key) {
        try {
            const result = await send()
            const error = extractMessageSendError(result)
            const failure = classifyMessageSendFailure(error, result)
            return {
                result,
                error: failure.message,
                status: failure.kind ? failure.kind : 'sent',
                cached: false
            }
        } catch (error) {
            const failure = classifyMessageSendFailure(error?.message || String(error))
            return {
                result: undefined,
                error: failure.message,
                status: failure.kind || 'ambiguous',
                cached: false
            }
        }
    }

    pruneDeliveryCache()
    const existing = deliveryCache.get(key)
    if (existing) {
        if (existing.status === 'pending') {
            logDelivery(logger, 'debug', logPrefix, `投递幂等命中 pending，复用同一请求: key=${key}, ${formatDeliveryContext(deliveryContext)}`)
            return { ...(await existing.promise), cached: true }
        }
        logDelivery(logger, 'info', logPrefix, `投递幂等命中 ${existing.status}，跳过重复发送: key=${key}, ${formatDeliveryContext(deliveryContext)}`)
        return { ...(existing.outcome || {}), cached: true }
    }

    const entry = {
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        outcome: null,
        promise: null
    }
    deliveryCache.set(key, entry)
    entry.promise = (async () => {
        const persisted = await loadPersistedDeliveryState(key, logger, logPrefix)
        if (persisted) {
            const recoveredStatus = persisted.status === 'pending' ? 'ambiguous' : persisted.status
            const recoveredError = persisted.status === 'pending'
                ? '上一次进程在投递过程中退出，消息是否已送达无法确认；为避免重复发送，本次不自动重发'
                : persisted.error || ''
            const recovered = {
                result: persisted.result,
                error: recoveredError,
                status: recoveredStatus,
                cached: true,
                persisted: true
            }
            entry.status = recovered.status
            entry.updatedAt = Date.now()
            entry.outcome = recovered
            if (recoveredStatus !== persisted.status) {
                await persistDeliveryState(key, recovered, entry, logger, logPrefix)
            }
            logDelivery(
                logger,
                recovered.status === 'sent' ? 'info' : 'warn',
                logPrefix,
                `恢复持久化投递状态=${recovered.status}: key=${key}, ${formatDeliveryContext(deliveryContext)}${recovered.error ? `, 原因=${recovered.error}` : ''}`
            )
            pruneDeliveryCache()
            return recovered
        }

        const pendingOutcome = {
            result: undefined,
            error: '',
            status: 'pending',
            cached: false
        }
        entry.updatedAt = Date.now()
        entry.outcome = pendingOutcome
        await persistDeliveryState(key, pendingOutcome, entry, logger, logPrefix)

        let outcome
        try {
            const result = await send()
            const error = extractMessageSendError(result)
            const failure = classifyMessageSendFailure(error, result)
            outcome = {
                result,
                error: failure.message,
                status: failure.kind || 'sent',
                cached: false
            }
        } catch (error) {
            const failure = classifyMessageSendFailure(error?.message || String(error))
            outcome = {
                result: undefined,
                error: failure.message,
                status: failure.kind || 'ambiguous',
                cached: false
            }
        }
        entry.updatedAt = Date.now()
        entry.outcome = outcome
        await persistDeliveryState(key, outcome, entry, logger, logPrefix)
        entry.status = outcome.status
        logDelivery(
            logger,
            outcome.status === 'sent' ? 'debug' : 'warn',
            logPrefix,
            `投递状态=${outcome.status}: key=${key}, ${formatDeliveryContext(deliveryContext)}${outcome.error ? `, 原因=${outcome.error}` : ''}`
        )
        pruneDeliveryCache()
        return outcome
    })()
    return entry.promise
}

function textByteLength(text) {
    return Buffer.byteLength(String(text || ''), 'utf8')
}

function fitsSingleReply(text, {
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    const value = String(text ?? '')
    const safeMaxChars = Math.max(1, Number(maxChars) || DEFAULT_MAX_CHARS)
    const safeMaxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES)
    return Array.from(value).length <= safeMaxChars && textByteLength(value) <= safeMaxBytes
}

export function shouldUseForwardReply({
    responseText = '',
    responseReasoning = '',
    footerInfo = '',
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    if (String(responseReasoning || '').trim()) return true
    return !fitsSingleReply([String(responseText ?? ''), '', String(footerInfo ?? '')].join('\n'), { maxChars, maxBytes })
}

function splitTextToSafeChunks(text, {
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    const source = String(text || '')
    if (!source) return []

    const chars = Array.from(source)
    const safeMaxChars = Math.max(1, Number(maxChars) || DEFAULT_MAX_CHARS)
    const safeMaxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES)
    const chunks = []
    let offset = 0

    while (offset < chars.length) {
        const remaining = chars.length - offset
        let length = Math.min(remaining, safeMaxChars)
        while (length > 1 && textByteLength(chars.slice(offset, offset + length).join('')) > safeMaxBytes) {
            length--
        }
        if (length === 1 && textByteLength(chars[offset]) > safeMaxBytes) {
            length = 1
        }

        const candidate = chars.slice(offset, offset + length).join('')
        if (offset + length < chars.length) {
            const newlineIndex = candidate.lastIndexOf('\n')
            if (newlineIndex > Math.floor(candidate.length * 0.8)) {
                const newlineLength = Array.from(candidate.slice(0, newlineIndex + 1)).length
                if (newlineLength > 0) length = newlineLength
            }
        }

        chunks.push(chars.slice(offset, offset + length).join(''))
        offset += length
    }
    return chunks
}

function buildForwardNodes({
    responseText,
    responseReasoning = '',
    footerInfo = '',
    aiName = 'AI',
    botUin = '',
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    const nodes = []
    const appendSection = (title, text, footer = '') => {
        const content = footer ? `${text}\n\n${footer}` : text
        const chunks = splitTextToSafeChunks(content, { maxChars, maxBytes })
        chunks.forEach((chunk, index) => {
            nodes.push({
                user_id: botUin,
                nickname: `${aiName} ${title}${index > 0 ? ` ${index + 1}` : ''}`,
                message: chunk
            })
        })
    }

    if (responseReasoning) appendSection('思考过程', `思考过程\n\n${responseReasoning}`)
    appendSection('最终回复', `最终回复\n\n${responseText}`, footerInfo)
    return nodes
}

export function splitReplyText(text, options = {}) {
    return splitTextToSafeChunks(text, options)
}

export async function sendTextInChunks({
    text,
    sendReply,
    quoteFirst = true,
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES,
    deliveryKey = '',
    deliveryContext = {},
    logger = pluginLogger,
    logPrefix = '[AI-Plugin]'
} = {}) {
    const chunks = splitTextToSafeChunks(text, { maxChars, maxBytes })
    if (chunks.length === 0) return { result: undefined, error: '', chunks: 0 }

    let result
    for (let index = 0; index < chunks.length; index++) {
        const chunkKey = buildDeliveryKey({
            ...deliveryContext,
            scope: deliveryKey || deliveryContext.scope || 'plain',
            method: deliveryContext.method || 'plain',
            segmentIndex: index,
            message: chunks[index]
        })
        const delivery = await executeIdempotentDelivery({
            deliveryKey: chunkKey,
            logger,
            logPrefix,
            send: () => sendReply(chunks[index], quoteFirst && index === 0),
            deliveryContext
        })
        result = delivery.result
        if (delivery.error) {
            return {
                result,
                error: delivery.error,
                chunks: chunks.length,
                sentChunks: index,
                deliveryStatus: delivery.status,
                deliveryKey: chunkKey
            }
        }
    }
    return { result, error: '', chunks: chunks.length, sentChunks: chunks.length, deliveryStatus: 'sent' }
}

export async function sendReplyWithForwardFallback({
    responseText,
    responseReasoning = '',
    footerInfo = '',
    aiName = 'AI',
    botUin = '',
    makeForwardMsg,
    sendReply,
    logger = pluginLogger,
    logPrefix = '[AI-Plugin]',
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES,
    fallbackMaxChars = 1800,
    fallbackMaxBytes = DEFAULT_MAX_BYTES,
    deliveryKey = '',
    deliveryContext = {}
} = {}) {
    const nodes = buildForwardNodes({
        responseText,
        responseReasoning,
        footerInfo,
        aiName,
        botUin,
        maxChars,
        maxBytes
    })
    if (nodes.length === 0) return { result: undefined, error: '', method: 'empty', nodes: 0 }

    let forwardError = ''
    let forwardResult
    let forwardStatus = ''
    const forwardKey = deliveryKey || buildDeliveryKey({
        ...deliveryContext,
        method: deliveryContext.method || 'forward',
        segmentIndex: 0,
        message: JSON.stringify(nodes)
    })
    let forwardMsg
    try {
        forwardMsg = await makeForwardMsg(nodes)
    } catch (error) {
        forwardError = error?.message || String(error)
    }

    if (!forwardError) {
        const delivery = await executeIdempotentDelivery({
            deliveryKey: forwardKey,
            logger,
            logPrefix,
            send: () => sendReply(forwardMsg),
            deliveryContext
        })
        forwardResult = delivery.result
        forwardError = delivery.error
        forwardStatus = delivery.status
        if (!forwardError) return { result: forwardResult, error: '', method: 'forward', nodes: nodes.length, deliveryStatus: 'sent', deliveryKey: forwardKey }
    } else {
        forwardStatus = 'invalid_request'
    }

    if (['transport', 'ambiguous'].includes(forwardStatus)) {
        logger?.warn?.(`${logPrefix} 合并转发结果不明确，停止降级重发: 节点=${nodes.length}, 状态=${forwardStatus}, 原因=${forwardError}`)
        return {
            result: forwardResult,
            error: forwardError,
            method: 'failed',
            nodes: nodes.length,
            forwardError,
            deliveryStatus: forwardStatus,
            deliveryKey: forwardKey
        }
    }

    logger?.warn?.(`${logPrefix} 合并转发发送失败，准备降级为普通分段消息: 节点=${nodes.length}, 原因=${forwardError || '未知错误'}`)
    const fallbackText = nodes.map(node => node.message).join('\n\n')
    const fallback = await sendTextInChunks({
        text: fallbackText,
        sendReply,
        maxChars: fallbackMaxChars,
        maxBytes: fallbackMaxBytes,
        deliveryKey: buildDeliveryKey({
            ...deliveryContext,
            method: 'plain-fallback',
            segmentIndex: 0,
            message: fallbackText
        }),
        deliveryContext,
        logger,
        logPrefix
    })
    if (!fallback.error) {
        logger?.info?.(`${logPrefix} 合并转发失败，已降级为普通分段消息: ${fallback.chunks} 段`)
        return { result: fallback.result, error: '', method: 'plain-fallback', nodes: nodes.length, chunks: fallback.chunks, forwardError, deliveryStatus: 'sent' }
    }
    return {
        result: fallback.result,
        error: `${forwardError || '合并转发失败'}；普通分段消息也发送失败：${fallback.error}`,
        method: 'failed',
        nodes: nodes.length,
        chunks: fallback.chunks,
        sentChunks: fallback.sentChunks,
        forwardError,
        deliveryStatus: fallback.deliveryStatus || 'ambiguous'
    }
}
