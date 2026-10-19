const BOT_MUTE_CACHE_TTL_MS = 3000
const botMuteCache = new Map()

function getBotUin(event = {}) {
    return String(event.self_id || event.bot?.uin || event.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : '') || '').trim()
}

function toNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

export function getBotMuteState(memberInfo = {}, now = Date.now()) {
    if (!memberInfo || typeof memberInfo !== 'object') return { known: false, muted: false, muteLeft: 0, shutUpTimestamp: 0 }
    const muteLeft = Math.max(0, toNumber(memberInfo.mute_left ?? memberInfo.muteLeft))
    const rawTimestamp = Math.max(0, toNumber(memberInfo.shut_up_timestamp ?? memberInfo.shutUpTimestamp))
    const shutUpTimestamp = rawTimestamp > 100000000000 ? rawTimestamp : rawTimestamp * 1000
    return {
        known: true,
        muted: muteLeft > 0 || shutUpTimestamp > now,
        muteLeft,
        shutUpTimestamp
    }
}

function getCachedState(key, now = Date.now()) {
    const cached = botMuteCache.get(key)
    if (!cached) return null
    if (now - cached.checkedAt > BOT_MUTE_CACHE_TTL_MS) {
        botMuteCache.delete(key)
        return null
    }
    return cached.state
}

function cacheState(key, state, now = Date.now()) {
    botMuteCache.set(key, { checkedAt: now, state })
    if (botMuteCache.size > 512) {
        const oldestKey = botMuteCache.keys().next().value
        if (oldestKey !== undefined) botMuteCache.delete(oldestKey)
    }
    return state
}

async function resolveMemberInfo(event, botUin) {
    const group = event?.group
    try {
        const member = group?.pickMember?.(Number(botUin))
        if (member) {
            const info = member.info || (member.getInfo ? await member.getInfo() : null)
            if (info) return info
        }
    } catch {
        // 继续尝试 OneBot API。
    }

    if (!event?.bot?.sendApi || !event.group_id) return null
    try {
        const response = await event.bot.sendApi('get_group_member_info', {
            group_id: Number(event.group_id),
            user_id: Number(botUin),
            no_cache: false
        })
        return response?.data || response || null
    } catch {
        return null
    }
}

export async function isBotMuted(event = {}) {
    if (!event?.group_id) return false
    const botUin = getBotUin(event)
    if (!botUin) return false

    const key = `${String(event.group_id)}:${botUin}`
    const now = Date.now()
    const cached = getCachedState(key, now)
    if (cached) return cached.muted === true

    const info = await resolveMemberInfo(event, botUin)
    if (!info) return false
    const state = getBotMuteState(info, now)
    cacheState(key, state, now)
    return state.muted
}

export function clearBotMuteCache() {
    botMuteCache.clear()
}

export function getBotMuteCacheSize() {
    return botMuteCache.size
}
