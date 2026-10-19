const LEGACY_GROUP_CONTEXT_START = '当时最近群聊上下文：'
const LEGACY_GROUP_CONTEXT_END = '注意：这是一段群聊公开上下文记录'

export const SPEAKER_ATTRIBUTION_RULE = '【说话人归属规则】输入中的每条事实必须保留原始说话人；说话人由“昵称(QQ)”或明确标注的 user_id 确定。禁止把 A 的发言、行为或偏好归到 B；无法确定说话人时必须标注“不确定”，不得猜测。'

function asText(value = '') {
    return String(value ?? '').trim()
}

export function buildSpeakerMeta({
    userId = '',
    nickname = '',
    isBot = false,
    scope = '',
    source = '',
    groupId = ''
} = {}) {
    const normalizedUserId = asText(userId)
    const normalizedNickname = asText(nickname)
    return {
        speaker_user_id: normalizedUserId,
        speaker_name: normalizedNickname || (isBot ? 'AI' : (normalizedUserId ? `用户${normalizedUserId}` : '未知用户')),
        speaker_is_bot: isBot === true,
        scope: asText(scope),
        source: asText(source),
        group_id: asText(groupId)
    }
}

export function buildEventSpeakerMeta(event = {}, options = {}) {
    const nickname = event?.sender?.card
        || event?.sender?.nickname
        || event?.member?.card
        || event?.member?.nickname
        || options.nickname
        || ''
    return buildSpeakerMeta({
        userId: event?.user_id || options.userId || '',
        nickname,
        isBot: options.isBot === true,
        scope: options.scope || (event?.group_id ? 'group' : 'private'),
        source: options.source || 'direct',
        groupId: event?.group_id || options.groupId || ''
    })
}

export function normalizeTurnMeta(turn = {}) {
    const raw = turn?.meta && typeof turn.meta === 'object' ? turn.meta : {}
    if (!raw.speaker_user_id && !raw.speaker_name && !raw.speaker_is_bot) return null
    return buildSpeakerMeta({
        userId: raw.speaker_user_id,
        nickname: raw.speaker_name,
        isBot: raw.speaker_is_bot === true,
        scope: raw.scope,
        source: raw.source,
        groupId: raw.group_id
    })
}

export function stripLegacyGroupContextMemory(text = '') {
    let value = String(text || '')
    value = value.replace(/\n=== 引用[^\n]*的消息 ===\n[\s\S]*?\n={10,}\n?/g, '\n').trim()
    if (!value.includes('【畅聊模式记录】')) return value
    const start = value.indexOf(LEGACY_GROUP_CONTEXT_START)
    if (start < 0) return value
    const tail = value.slice(start)
    const endOffset = tail.indexOf(LEGACY_GROUP_CONTEXT_END)
    const end = endOffset >= 0 ? start + endOffset : value.length
    return `${value.slice(0, start)}${value.slice(end)}`.trim()
}

export function getTurnText(turn = {}, options = {}) {
    const text = (Array.isArray(turn?.parts) ? turn.parts : [])
        .filter(part => part?.text !== undefined)
        .map(part => String(part.text || ''))
        .join(' ')
        .trim()
    return options.stripLegacyGroupContext === false ? text : stripLegacyGroupContextMemory(text)
}

export function getTurnSpeakerLabel(turn = {}, options = {}) {
    const meta = normalizeTurnMeta(turn)
    if (meta) {
        return meta.speaker_is_bot
            ? (options.aiName || meta.speaker_name || 'AI')
            : `${meta.speaker_name}${meta.speaker_user_id ? `(QQ ${meta.speaker_user_id})` : ''}`
    }
    if (turn?.role === 'model') return options.aiName || 'AI'
    const fallbackUserId = asText(options.defaultUserId)
    return fallbackUserId ? `用户(QQ ${fallbackUserId})` : '用户(说话人未知)'
}

export function formatSpeakerAwareHistoryTurn(turn = {}, options = {}) {
    const text = getTurnText(turn)
    if (!text) return ''
    return `${getTurnSpeakerLabel(turn, options)}: ${text}`
}

export function toModelHistoryTurn(turn = {}) {
    return {
        role: turn?.role === 'model' ? 'model' : 'user',
        parts: Array.isArray(turn?.parts) ? turn.parts : []
    }
}

export function toModelHistory(history = []) {
    return (Array.isArray(history) ? history : []).map(toModelHistoryTurn)
}
