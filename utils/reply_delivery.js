import { extractMessageSendError } from './message_delivery.js'

const DEFAULT_MAX_CHARS = 3500
const DEFAULT_MAX_BYTES = 3500

function textByteLength(text) {
    return Buffer.byteLength(String(text || ''), 'utf8')
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
    maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    const chunks = splitTextToSafeChunks(text, { maxChars, maxBytes })
    if (chunks.length === 0) return { result: undefined, error: '', chunks: 0 }

    let result
    for (let index = 0; index < chunks.length; index++) {
        try {
            result = await sendReply(chunks[index], quoteFirst && index === 0)
        } catch (error) {
            return {
                result,
                error: error?.message || String(error),
                chunks: chunks.length,
                sentChunks: index
            }
        }
        const sendError = extractMessageSendError(result)
        if (sendError) {
            return {
                result,
                error: sendError,
                chunks: chunks.length,
                sentChunks: index
            }
        }
    }
    return { result, error: '', chunks: chunks.length, sentChunks: chunks.length }
}

export async function sendReplyWithForwardFallback({
    responseText,
    responseReasoning = '',
    footerInfo = '',
    aiName = 'AI',
    botUin = '',
    makeForwardMsg,
    sendReply,
    logger = global.logger,
    logPrefix = '[AI-Plugin]',
    maxChars = DEFAULT_MAX_CHARS,
    maxBytes = DEFAULT_MAX_BYTES,
    fallbackMaxChars = 1800,
    fallbackMaxBytes = DEFAULT_MAX_BYTES
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
    try {
        const forwardMsg = await makeForwardMsg(nodes)
        const result = await sendReply(forwardMsg)
        forwardError = extractMessageSendError(result)
        if (!forwardError) return { result, error: '', method: 'forward', nodes: nodes.length }
    } catch (error) {
        forwardError = error?.message || String(error)
    }

    logger?.warn?.(`${logPrefix} 合并转发发送失败，准备降级为普通分段消息: 节点=${nodes.length}, 原因=${forwardError || '未知错误'}`)
    const fallbackText = nodes.map(node => node.message).join('\n\n')
    const fallback = await sendTextInChunks({
        text: fallbackText,
        sendReply,
        maxChars: fallbackMaxChars,
        maxBytes: fallbackMaxBytes
    })
    if (!fallback.error) {
        logger?.info?.(`${logPrefix} 合并转发失败，已降级为普通分段消息: ${fallback.chunks} 段`)
        return { result: fallback.result, error: '', method: 'plain-fallback', nodes: nodes.length, chunks: fallback.chunks, forwardError }
    }
    return {
        result: fallback.result,
        error: `${forwardError || '合并转发失败'}；普通分段消息也发送失败：${fallback.error}`,
        method: 'failed',
        nodes: nodes.length,
        chunks: fallback.chunks,
        sentChunks: fallback.sentChunks,
        forwardError
    }
}
