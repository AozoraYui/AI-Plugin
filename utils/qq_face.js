import fs from 'node:fs'

// 本地兜底表由 koishijs/QFace 的 QQNT 索引生成，运行时不访问外部站点。
const QQ_FACE_TYPES = new Set(['face', 'marketface', 'mface'])
const GENERIC_FACE_LABELS = new Set([
    '表情',
    'qq表情',
    '动画表情',
    '动态表情',
    '商城表情',
    '贴纸',
    'emoji'
])

let qqFaceMap = {}
try {
    qqFaceMap = JSON.parse(fs.readFileSync(new URL('../data/qq_face_map.json', import.meta.url), 'utf8'))
} catch (err) {
    globalThis.logger?.warn?.(`[AI-Plugin] QQ 表情映射加载失败，将只使用消息段自带描述: ${err.message}`)
}

function decodeHtmlEntities(text = '') {
    return String(text)
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
}

function normalizeFaceLabel(value = '') {
    let label = decodeHtmlEntities(value).trim()
    if (!label) return ''
    label = label.replace(/^\/+/, '').trim()
    const wrapped = label.match(/^\[([^\[\]]+)]$/) || label.match(/^【([^【】]+)】$/)
    if (wrapped) label = wrapped[1].trim()
    if (!label || GENERIC_FACE_LABELS.has(label.toLowerCase())) return ''
    return label.slice(0, 80)
}

function firstFaceLabel(values = []) {
    for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') continue
        const label = normalizeFaceLabel(value)
        if (label) return label
    }
    return ''
}

function firstFaceId(values = []) {
    for (const value of values) {
        if (value === undefined || value === null) continue
        const id = String(value).trim()
        if (id) return id
    }
    return ''
}

function collectUrl(value, urls) {
    if (typeof value !== 'string') return
    const url = decodeHtmlEntities(value).trim()
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url)
}

export function isQQFaceSegment(segment = {}) {
    return QQ_FACE_TYPES.has(String(segment?.type || '').toLowerCase())
}

export function describeQQFaceSegment(segment = {}) {
    if (!isQQFaceSegment(segment)) return null

    const data = segment.data || {}
    const raw = data.raw || segment.raw || {}
    const id = firstFaceId([
        data.id,
        segment.id,
        data.faceIndex,
        raw.faceIndex,
        data.emojiId,
        raw.emojiId,
        data.emoji_id,
        raw.emoji_id
    ])
    const label = firstFaceLabel([
        raw.faceText,
        data.faceText,
        segment.faceText,
        data.summary,
        segment.summary,
        raw.spokeSummary,
        raw.summary,
        data.name,
        data.faceName,
        raw.faceName,
        data.text,
        raw.text,
        id ? qqFaceMap[id] : ''
    ])
    const type = String(segment.type || '').toLowerCase()
    const kind = type === 'face' ? 'QQ表情' : 'QQ贴纸'
    const text = label
        ? `[${kind}：${label}]`
        : id
            ? `[${kind} id=${id}]`
            : `[${kind}]`

    const imageUrls = []
    for (const value of [
        data.url,
        segment.url,
        raw.url,
        data.imageUrl,
        raw.imageUrl,
        data.staticFaceUrl,
        raw.staticFaceUrl,
        data.bigUrl,
        raw.bigUrl
    ]) {
        collectUrl(value, imageUrls)
    }

    return { id, label, kind, text, imageUrls }
}

export function formatQQFaceSegment(segment = {}) {
    return describeQQFaceSegment(segment)?.text || ''
}

export function formatQQFaceSegments(segments = []) {
    return (Array.isArray(segments) ? segments : [])
        .map(formatQQFaceSegment)
        .filter(Boolean)
        .join(' ')
}

export function collectQQFaceImageUrls(segments = []) {
    const urls = []
    for (const segment of Array.isArray(segments) ? segments : []) {
        for (const url of describeQQFaceSegment(segment)?.imageUrls || []) {
            if (!urls.includes(url)) urls.push(url)
        }
    }
    return urls
}
