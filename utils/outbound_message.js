import crypto from 'node:crypto'

const MAX_FORWARD_NODES = 200
const MAX_OUTBOUND_TEXT = 120000

function getSegmentType(segment) {
    return String(segment?.type || '').trim().toLowerCase()
}

function getSegmentText(segment) {
    if (typeof segment === 'string' || typeof segment === 'number') return String(segment)
    return String(segment?.data?.text ?? segment?.text ?? '')
}

function getImageUrl(segment) {
    const value = String(segment?.data?.url || segment?.data?.file || segment?.url || segment?.file || '').trim()
    if (/^(?:base64|data):/i.test(value)) return ''
    return value
}

function imageMeta(url) {
    return {
        url,
        hash: crypto.createHash('sha1').update(url).digest('hex'),
        source: 'outbound'
    }
}

function normalizeSegment(segment) {
    if (typeof segment === 'string' || typeof segment === 'number') {
        return { type: 'text', text: String(segment) }
    }
    if (!segment || typeof segment !== 'object') return null

    const type = getSegmentType(segment)
    if (type === 'text') {
        const text = getSegmentText(segment)
        return text.trim() ? { type: 'text', text } : null
    }
    if (type === 'image') {
        const url = getImageUrl(segment)
        return url ? { type: 'image', url } : { type: 'image' }
    }
    if (type === 'at') {
        const qq = String(segment?.data?.qq || segment?.qq || '').trim()
        return qq ? { type: 'at', qq } : null
    }
    if (type === 'file') {
        const name = String(segment?.data?.name || segment?.data?.file_name || segment?.name || segment?.file_name || segment?.file || '').trim()
        return name ? { type: 'file', name } : { type: 'file' }
    }
    if (type === 'reply') {
        const id = String(segment?.data?.id || segment?.data?.message_id || segment?.id || '').trim()
        return id ? { type: 'reply', id } : { type: 'reply' }
    }
    if (type === 'node') {
        const nodes = normalizeForwardNodes(segment?.data)
        return nodes.length > 0 ? { type: 'forward', nodes } : null
    }
    if (type === 'forward') {
        const nodes = normalizeForwardNodes(segment?.data?.content || segment?.content || segment?.data)
        return nodes.length > 0 ? { type: 'forward', nodes } : null
    }
    return null
}

function normalizeNodeMessage(message) {
    if (Array.isArray(message)) return message.map(normalizeSegment).filter(Boolean)
    if (message === undefined || message === null) return []
    const normalized = normalizeSegment(message)
    return normalized ? [normalized] : []
}

function normalizeForwardNodes(value) {
    if (!Array.isArray(value)) return []
    return value.slice(0, MAX_FORWARD_NODES).map(node => {
        const message = normalizeNodeMessage(node?.message ?? node?.content)
        return {
            user_id: String(node?.user_id ?? node?.uin ?? node?.data?.uin ?? '').trim(),
            nickname: String(node?.nickname ?? node?.name ?? node?.data?.name ?? '匿名消息').trim() || '匿名消息',
            message
        }
    }).filter(node => node.message.length > 0)
}

function segmentText(segment, images) {
    const type = getSegmentType(segment)
    if (type === 'text') return getSegmentText(segment)
    if (type === 'at') {
        const qq = String(segment?.data?.qq || segment?.qq || '').trim()
        return qq ? `[@${qq}]` : ''
    }
    if (type === 'image') {
        const url = getImageUrl(segment)
        if (url) images.push(imageMeta(url))
        return '[图片]'
    }
    if (type === 'file') return '[文件]'
    if (type === 'reply') return '[回复消息]'
    if (type === 'forward' || type === 'node') {
        const nodes = normalizeForwardNodes(segment?.data?.content || segment?.content || segment?.data)
        return nodes.map(node => `[${node.nickname}]：${segmentsToText(node.message, images)}`).join('\n')
    }
    return ''
}

function segmentsToText(segments, images) {
    return (Array.isArray(segments) ? segments : [segments])
        .map(segment => segmentText(segment, images))
        .filter(Boolean)
        .join('')
}

export function normalizeOutboundMessage(message) {
    const parts = Array.isArray(message) ? message : [message]
    const imageMetaList = []
    const forwardNodes = []
    const textParts = []

    for (const part of parts) {
        const type = getSegmentType(part)
        if (type === 'node' || type === 'forward') {
            const nodes = normalizeForwardNodes(part?.data?.content || part?.content || part?.data)
            if (nodes.length > 0) {
                forwardNodes.push(...nodes)
                textParts.push(nodes.map(node => `[${node.nickname}]：${segmentsToText(node.message, imageMetaList)}`).join('\n'))
            }
            continue
        }
        const text = segmentText(part, imageMetaList)
        if (text) textParts.push(text)
    }

    const seenImages = new Set()
    const images = imageMetaList.filter(item => {
        if (seenImages.has(item.hash)) return false
        seenImages.add(item.hash)
        return true
    })
    const normalizedText = textParts.join('').replace(/\n{3,}/g, '\n\n').trim()
    return {
        normalizedText: normalizedText.slice(0, MAX_OUTBOUND_TEXT),
        imageMeta: images,
        forwardNodes: forwardNodes.slice(0, MAX_FORWARD_NODES)
    }
}

export function extractMessageIds(response) {
    const ids = []
    const visit = value => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) {
            value.forEach(visit)
            return
        }
        for (const key of ['message_id', 'messageId']) {
            const raw = value[key]
            if (Array.isArray(raw)) {
                for (const item of raw) {
                    if (item !== undefined && item !== null && item !== '') ids.push(String(item))
                }
            } else if (raw !== undefined && raw !== null && raw !== '') {
                ids.push(String(raw))
            }
        }
        if (value.data && value.data !== value) visit(value.data)
    }
    visit(response)
    return [...new Set(ids)]
}

export function getOutboundForwardNodes(cached) {
    if (!cached) return []
    try {
        const raw = cached.nodesJson ?? cached.nodes_json
        const nodes = typeof raw === 'string' ? JSON.parse(raw) : raw
        return Array.isArray(nodes) ? nodes : []
    } catch {
        return []
    }
}

export async function loadCachedOutboundForward(messageId, groupId = '') {
    const db = global.AIPluginConversationManager?.db
    if (!db?.getOutboundForwardMessage || !messageId) return null
    try {
        return await db.getOutboundForwardMessage({ messageId, groupId })
    } catch (err) {
        logger.warn(`[AI-Plugin] 读取本地合并消息缓存失败: ${err.message}`)
        return null
    }
}

export async function hydrateCachedForwardMessage(source, groupId = '', fallbackMessageId = '') {
    if (!source || !Array.isArray(source.message)) return source
    const messageId = source.message_id || source.messageId || fallbackMessageId || source.id
    if (!messageId) return source
    const cached = await loadCachedOutboundForward(String(messageId), groupId)
    const nodes = getOutboundForwardNodes(cached)
    if (nodes.length === 0) return source

    let injected = false
    const message = source.message.map(segment => {
        const type = getSegmentType(segment)
        if (type !== 'forward' && type !== 'node') return segment
        const existing = segment?.data?.content || segment?.content
        if (Array.isArray(existing) && existing.length > 0) return segment
        injected = true
        return {
            ...segment,
            content: nodes,
            data: { ...(segment.data || {}), content: nodes }
        }
    })
    if (!injected) return source
    logger.info(`[AI-Plugin] 已从本地缓存恢复合并转发内容: message_id=${messageId}, 节点=${nodes.length}`)
    return { ...source, message }
}
