import { Config } from './config.js'
import { loadUserProfileText } from './user_profile.js'
import { buildSemanticMemoryContext } from './vector_memory.js'

function stripLoneSurrogates(text) {
    const value = String(text || '')
    let out = ''
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = value.charCodeAt(i + 1)
            if (next >= 0xDC00 && next <= 0xDFFF) {
                out += value[i] + value[i + 1]
                i++
            }
            continue
        }
        if (code >= 0xDC00 && code <= 0xDFFF) continue
        out += value[i]
    }
    return out
}

function sanitizeMemoryText(text) {
    return stripLoneSurrogates(text)
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
}

export function stripMediaPartsFromHistory(history = []) {
    if (!Array.isArray(history) || history.length === 0) return { history: [], removed: 0 }
    let removed = 0
    const cleaned = []
    for (const turn of history) {
        const parts = Array.isArray(turn?.parts) ? turn.parts : []
        const textParts = []
        for (const part of parts) {
            if (part?.text !== undefined) {
                textParts.push({ text: sanitizeMemoryText(part.text) })
            } else if (part?.inline_data || part?.inlineData || part?.file_data || part?.fileData) {
                removed++
            }
        }
        if (textParts.length > 0) {
            cleaned.push({ ...turn, parts: textParts })
        } else if (parts.length > 0) {
            cleaned.push({ ...turn, parts: [{ text: '[历史媒体内容已省略]' }] })
        }
    }
    return { history: cleaned, removed }
}

function truncateHeadText(text, maxChars = Infinity) {
    const value = sanitizeMemoryText(text).trim()
    if (maxChars === Infinity || value.length <= maxChars) return value
    return value.slice(0, maxChars) + '...'
}

function truncateMiddleText(text, maxChars = Infinity) {
    const value = sanitizeMemoryText(text).trim()
    if (maxChars === Infinity || value.length <= maxChars) return value
    const head = Math.max(1, Math.floor(maxChars * 0.65))
    const tail = Math.max(1, maxChars - head)
    return `${value.slice(0, head)}\n\n...【内容过长，已截断 ${value.length - maxChars} 字符】...\n\n${value.slice(-tail)}`
}

function truncateMemoryText(text, maxChars = Infinity, mode = 'head') {
    return mode === 'middle'
        ? truncateMiddleText(text, maxChars)
        : truncateHeadText(text, maxChars)
}

function normalizeHistoryLimit(limit) {
    if (limit === Infinity) return Infinity
    const value = Number(limit)
    if (!Number.isFinite(value) || value <= 0) return Infinity
    return Math.floor(value)
}

function logWithLevel(level, text) {
    const fn = typeof logger?.[level] === 'function' ? logger[level] : logger.debug
    fn.call(logger, text)
}

export async function buildAutoSemanticMemoryContext(db, query, options = {}) {
    const {
        vectorEnabled = Config.enable_vector_memory !== false,
        logPrefix = '[AI-Plugin]',
        maxChars = Config.VECTOR_AUTO_CONTEXT_MAX_CHARS,
        ...semanticOptions
    } = options

    if (!vectorEnabled) return ''
    try {
        return await buildSemanticMemoryContext(db, query, {
            ...semanticOptions,
            maxChars
        })
    } catch (err) {
        logger.warn(`${logPrefix} 向量记忆自动检索失败: ${err.message}`)
        return ''
    }
}

export async function loadUserMemoryContext(conversationManager, userId, options = {}) {
    const {
        includeHistory = true,
        includeCheckpoint = true,
        includeProfile = true,
        stripHistoryMedia = true,
        maxHistoryTurns = Infinity,
        checkpointMaxChars = Infinity,
        checkpointTruncateMode = 'head',
        profileMaxChars = Infinity,
        profileTruncateMode = 'middle',
        includeSemantic = false,
        semanticQuery = '',
        semanticOptions = {},
        vectorEnabled = false,
        logPrefix = '[AI-Plugin]',
        logLabel = `用户 ${userId}`,
        logLevel = 'debug'
    } = options

    const result = {
        history: [],
        incrementalCheckpoint: '',
        personalMemory: '',
        userProfileText: '',
        semanticMemoryContext: '',
        strippedMediaCount: 0
    }

    if (!conversationManager || !userId) return result

    let memoryData = { history: [], incrementalCheckpoint: '' }
    try {
        memoryData = await conversationManager.getUserHistoryWithCheckpoint(userId)
    } catch (err) {
        logger.warn(`${logPrefix} ${logLabel} 加载个人历史/记忆摘要失败: ${err.message}`)
    }

    if (includeHistory) {
        let history = Array.isArray(memoryData?.history) ? memoryData.history : []
        if (stripHistoryMedia) {
            const stripped = stripMediaPartsFromHistory(history)
            history = stripped.history
            result.strippedMediaCount = stripped.removed
            if (stripped.removed > 0) {
                logger.info(`${logPrefix} ${logLabel} 已从历史上下文移除 ${stripped.removed} 个历史图片/媒体输入，避免重复消耗多模态 token`)
            }
        }

        const historyLimit = normalizeHistoryLimit(maxHistoryTurns)
        if (historyLimit !== Infinity && history.length > historyLimit) {
            history = history.slice(-historyLimit)
            logger.debug(`${logPrefix} ${logLabel} 的历史过长，已截断至最近 ${historyLimit} 条`)
        }
        result.history = history
    }

    if (includeCheckpoint) {
        result.incrementalCheckpoint = truncateMemoryText(memoryData?.incrementalCheckpoint || '', checkpointMaxChars, checkpointTruncateMode)
        result.personalMemory = result.incrementalCheckpoint
        if (result.incrementalCheckpoint) {
            logWithLevel(logLevel, `${logPrefix} ${logLabel} 加载个人记忆摘要，字符数=${result.incrementalCheckpoint.length}`)
        }
    }

    if (includeProfile) {
        try {
            const profile = await loadUserProfileText(conversationManager.db, userId, Infinity)
            result.userProfileText = truncateMemoryText(profile, profileMaxChars, profileTruncateMode)
            if (result.userProfileText) {
                logWithLevel(logLevel, `${logPrefix} ${logLabel} 加载个人档案，字符数=${result.userProfileText.length}`)
            }
        } catch (err) {
            logger.warn(`${logPrefix} ${logLabel} 加载个人档案失败: ${err.message}`)
        }
    }

    if (includeSemantic) {
        result.semanticMemoryContext = await buildAutoSemanticMemoryContext(conversationManager.db, semanticQuery, {
            ...semanticOptions,
            vectorEnabled,
            logPrefix
        })
    }

    return result
}
