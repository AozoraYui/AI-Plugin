const ALIAS_MAX_LENGTH = 24

const JOKE_ALIAS_RE = /(杂鱼|笨蛋|傻|蠢|菜|屑|废物|坏东西|小东西|憨|呆|笨|逊|菜鸡|弱鸡)/i
const BAD_ALIAS_RE = /(禁言|解禁|踢|移出|拉黑|通过|拒绝|申请|入群|加群|群管|群管理|精华|名片|头衔|谁|什么|为什么|怎么|吗|呢|是否|有没有|能不能|可不可以|帮我|你觉得|看看|查一下|查询|搜索)/i

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeAliasText(value) {
    let alias = String(value || '').trim()
    alias = alias
        .replace(/\[@\d+\]/g, '')
        .replace(/^[：:，,。.\s"'“”‘’【】()\[\]]+/g, '')
        .replace(/[：:，,。.!！?？、；;~～\s"'“”‘’【】()\[\]]+$/g, '')
        .replace(/^(?:一个|一位|一只|一枚|这个|那个|这位|那位|个|只|位|名)\s*/g, '')
        .replace(/(?:吧|啦|喵|哦|呀|啊|哈|嘛|呐|噢|欸|诶|了)+$/g, '')
        .trim()

    const stopMatch = alias.match(/^(.{1,24}?)(?:，|。|！|？|,|\.|!|\?|、|；|;|\s+(?:吧|啦|喵|哦|呀|啊|哈|嘛|呢|了)\b)/)
    if (stopMatch) alias = stopMatch[1].trim()
    return alias
}

function isAliasSafe(alias) {
    if (!alias) return false
    if (alias.length > ALIAS_MAX_LENGTH) return false
    if (/\s{2,}|\n|\r/.test(alias)) return false
    if (/https?:\/\//i.test(alias)) return false
    if (/^\d+$/.test(alias)) return false
    if (BAD_ALIAS_RE.test(alias)) return false
    return true
}

export function extractMentionedUserIds(message = [], options = {}) {
    const botUserId = options.botUserId ? String(options.botUserId) : ''
    const ids = []
    for (const seg of message || []) {
        if (seg?.type !== 'at') continue
        const qq = seg.qq || seg.user_id || seg.data?.qq || seg.data?.user_id
        if (!qq || String(qq) === 'all') continue
        if (botUserId && String(qq) === botUserId) continue
        ids.push(String(qq))
    }
    return [...new Set(ids)]
}

export function normalizeTextWithMentions(message = [], fallbackText = '') {
    const parts = []
    for (const seg of message || []) {
        if (seg?.type === 'text') {
            const text = seg.data?.text || seg.text || ''
            if (text) parts.push(text)
        } else if (seg?.type === 'at') {
            const qq = seg.qq || seg.user_id || seg.data?.qq || seg.data?.user_id
            if (qq && String(qq) !== 'all') parts.push(`[@${qq}]`)
        }
    }
    const normalized = parts.join('').trim()
    return normalized || String(fallbackText || '').trim()
}

function buildAliasPatterns(targetUserId) {
    const mention = `\\[@${escapeRegex(targetUserId)}\\]`
    return [
        {
            type: 'explicit',
            confidence: 0.85,
            regex: new RegExp(`${mention}\\s*(?:的)?(?:外号|绰号|昵称|称呼|别称)\\s*(?:是|叫|叫做|为|改成)?\\s*([^，。！？!?、；;\\n]{1,${ALIAS_MAX_LENGTH + 6}})`, 'i')
        },
        {
            type: 'explicit',
            confidence: 0.82,
            regex: new RegExp(`(?:外号|绰号|昵称|称呼|别称)\\s*(?:是|叫|叫做|为)?\\s*([^，。！？!?、；;\\n]{1,${ALIAS_MAX_LENGTH + 6}})\\s*(?:的)?\\s*${mention}`, 'i')
        },
        {
            type: 'explicit',
            confidence: 0.78,
            regex: new RegExp(`(?:以后|之后)?\\s*(?:就|都)?\\s*(?:叫|喊|称呼)\\s*${mention}\\s*(?:为|作|做|成)?\\s*([^，。！？!?、；;\\n]{1,${ALIAS_MAX_LENGTH + 6}})`, 'i')
        },
        {
            type: 'explicit',
            confidence: 0.78,
            regex: new RegExp(`${mention}\\s*(?:以后|之后)?\\s*(?:就|都|可以)?\\s*(?:叫|叫做|称作|称为|喊作)\\s*([^，。！？!?、；;\\n]{1,${ALIAS_MAX_LENGTH + 6}})`, 'i')
        },
        {
            type: 'direct_is',
            confidence: 0.58,
            regex: new RegExp(`(?:这位|这个|那个|这|那|他|她|ta)?\\s*${mention}\\s*(?:是|就是)\\s*([^，。！？!?、；;\\n]{1,${ALIAS_MAX_LENGTH + 6}})`, 'i')
        }
    ]
}

export function extractGroupMemberAliasRecords(input = {}) {
    const text = normalizeTextWithMentions(input.message || [], input.text || '')
    if (!text) return []

    const targetIds = extractMentionedUserIds(input.message || [], { botUserId: input.botUserId })
    if (targetIds.length !== 1) return []

    const records = []
    for (const targetUserId of targetIds) {
        for (const pattern of buildAliasPatterns(targetUserId)) {
            const match = text.match(pattern.regex)
            const alias = normalizeAliasText(match?.[1])
            if (!isAliasSafe(alias)) continue

            const isJoke = pattern.type === 'direct_is' || JOKE_ALIAS_RE.test(alias)
            records.push({
                groupId: String(input.groupId || ''),
                targetUserId,
                alias,
                sourceUserId: input.sourceUserId ? String(input.sourceUserId) : '',
                sourceNickname: input.sourceNickname || '',
                note: isJoke ? '群内调侃称呼，不能当作事实断言' : '群内称呼/外号记录',
                isJoke,
                confidence: isJoke ? Math.min(pattern.confidence, 0.6) : pattern.confidence
            })
            break
        }
    }
    return records
}

export async function captureGroupMemberAliases(db, event, text = '', options = {}) {
    if (!db?.saveGroupMemberAlias || !event?.group_id || !event?.message) return []

    const botUserId = String(event.self_id || event.bot?.uin || event.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : '') || '')
    const records = extractGroupMemberAliasRecords({
        text,
        message: event.message,
        groupId: event.group_id,
        sourceUserId: event.user_id,
        sourceNickname: options.sourceNickname || event.sender?.card || event.sender?.nickname || event.member?.card || event.member?.nickname || '',
        botUserId
    })

    const saved = []
    for (const record of records) {
        await db.saveGroupMemberAlias(record)
        saved.push(record)
        logger.info(`[AI-Plugin] [称呼记忆] 已记录群 ${record.groupId}: ${record.sourceNickname || record.sourceUserId || '未知用户'} 称 ${record.targetUserId} 为「${record.alias}」${record.isJoke ? '（调侃）' : ''}`)
    }
    return saved
}

export function formatGroupAliasRecords(records = [], options = {}) {
    if (!Array.isArray(records) || records.length === 0) return ''
    const limit = Math.max(1, Number(options.limit) || 20)
    const lines = records.slice(0, limit).map((record, index) => {
        const source = record.sourceNickname || record.sourceUserId
            ? `，来源：${record.sourceNickname || '用户'}${record.sourceUserId ? `(${record.sourceUserId})` : ''}`
            : ''
        const tag = record.isJoke ? '调侃称呼' : '称呼/外号'
        return `${index + 1}. QQ ${record.targetUserId} 曾被称为「${record.alias}」（${tag}${source}，更新时间：${record.updatedAt || record.createdAt || '未知'}）`
    })
    return `【本群称呼记忆】\n以下记录来自本群公开聊天，只表示群内有人这样称呼过对方；带“调侃称呼”的记录不要当作真实身份或事实断言。\n${lines.join('\n')}`
}

export async function buildGroupAliasMemoryText(db, groupId, targetUserIds = [], options = {}) {
    if (!db?.getGroupMemberAliases || !groupId) return ''
    const records = await db.getGroupMemberAliases(groupId, targetUserIds, { limit: options.limit || 20 })
    return formatGroupAliasRecords(records, options)
}
