/**
 * 群管理工具
 * 让 AI 在对话中按意图执行群管理操作：禁言/解禁、全员禁言、踢人、改名片、设头衔、精华消息、入群审核。
 * 触发者必须是「主人」或「当前群的管理员/群主」，且机器人本身需具备相应管理权限。
 * 入群审核依赖 apps/group_request.js 监听并缓存的待审申请。
 */

import { toolRegistry } from './registry.js'

// 入群申请缓存 redis key（与 apps/group_request.js 保持一致）
export const GROUP_REQUEST_KEY = (groupId, userId) => `AI-Plugin:groupAdd:${groupId}:${userId}`
export const GROUP_REQUEST_SCAN = (groupId) => `AI-Plugin:groupAdd:${groupId}:*`

// 时间单位 → 秒
const TIME_UNIT = { '秒': 1, '分': 60, '分钟': 60, '小时': 3600, '时': 3600, '天': 86400, '日': 86400 }

// 取群对象（兼容 e.group 与 bot.pickGroup）
function pickGroup(event) {
    if (event.group) return event.group
    if (event.bot?.pickGroup && event.group_id) return event.bot.pickGroup(Number(event.group_id))
    return null
}

// 取群成员对象
function pickMember(group, event, userId) {
    if (group?.pickMember) return group.pickMember(Number(userId))
    if (event.bot?.pickMember && event.group_id) return event.bot.pickMember(Number(event.group_id), Number(userId))
    return null
}

function normalizeRole(role) {
    if (role === 'owner' || role === 'admin') return role
    return 'member'
}

function getBotUin(event) {
    return Number(event?.self_id || event?.bot?.uin || event?.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : 0)) || 0
}

// 获取成员信息（兼容 .info 缓存与 getInfo()）
async function getMemberInfo(member) {
    if (!member) return null
    try {
        return member.info || (member.getInfo ? await member.getInfo() : null)
    } catch {
        return null
    }
}

async function fetchMemberInfoByApi(event, userId) {
    if (!event?.bot?.sendApi || !event.group_id || !userId) return null
    try {
        const res = await event.bot.sendApi('get_group_member_info', {
            group_id: Number(event.group_id),
            user_id: Number(userId),
            no_cache: false
        })
        return res?.data || res
    } catch {
        return null
    }
}

async function resolveMemberInfo(group, event, userId) {
    const member = pickMember(group, event, userId)
    const info = await getMemberInfo(member)
    if (info) return info
    return fetchMemberInfoByApi(event, userId)
}

// 判断触发者是否有管理权限：主人 或 当前群管理员/群主
export async function resolveGroupOperatorRole(event) {
    if (event.isMaster) return 'master'
    const role = event.sender?.role || event.member?.role
    if (role === 'owner' || event.member?.is_owner) return 'owner'
    if (role === 'admin' || event.member?.is_admin) return 'admin'
    const group = pickGroup(event)
    const info = group && event.user_id ? await resolveMemberInfo(group, event, event.user_id) : null
    const resolvedRole = normalizeRole(info?.role)
    if (resolvedRole === 'owner' || resolvedRole === 'admin') return resolvedRole
    return 'member'
}

// 判断机器人在群里是否为管理员/群主
async function resolveBotRole(event, group) {
    if (group?.is_owner === true) return 'owner'
    if (group?.is_admin === true) return 'admin'
    const botUin = getBotUin(event)
    if (!botUin) return 'member'
    const info = await resolveMemberInfo(group, event, botUin)
    return normalizeRole(info?.role)
}

async function botIsAdmin(event, group) {
    const role = await resolveBotRole(event, group)
    return role === 'owner' || role === 'admin'
}

// 解析时长字符串/数字 + 单位 → 秒
function parseDuration(time, unit) {
    const n = Number(time)
    if (!Number.isFinite(n) || n < 0) return null
    const u = TIME_UNIT[String(unit || '分钟').trim()] ?? 60
    return Math.floor(n * u)
}

// 校验：是否允许对目标成员执行管理操作（不能操作主人/群主，管理只有主人能动）
async function checkTargetAllowed(event, group, targetId) {
    // 不能对主人下手
    const masters = (typeof cfg !== 'undefined' && cfg.masterQQ) ? cfg.masterQQ.map(Number) : []
    if (masters.includes(Number(targetId)) && !event.isMaster) {
        return { ok: false, reason: '该操作对主人无效' }
    }
    if (Number(targetId) === getBotUin(event)) {
        return { ok: false, reason: '不能对机器人自己执行该操作' }
    }
    const info = await resolveMemberInfo(group, event, targetId)
    if (!info) return { ok: false, reason: `群里没有找到 QQ ${targetId} 这个人` }
    if (info.role === 'owner') return { ok: false, reason: '不能对群主执行该操作' }
    if (info.role === 'admin') {
        if (!event.isMaster) return { ok: false, reason: '只有主人才能对管理员执行该操作' }
        const botRole = await resolveBotRole(event, group)
        if (botRole !== 'owner') return { ok: false, reason: '机器人需要群主权限才能操作管理员' }
    }
    return { ok: true, info }
}

// 工具执行前的统一前置校验：群聊 + 操作者权限 + bot 管理权限
async function preCheck(event, options = {}) {
    const requireBotAdmin = options.requireBotAdmin !== false
    const requireBotOwner = options.requireBotOwner === true
    if (!event) return { error: '缺少会话上下文。' }
    if (!event.group_id) return { error: '群管理功能仅在群聊中可用。' }
    const opRole = await resolveGroupOperatorRole(event)
    if (opRole === 'member') return { error: '权限不足：只有主人或群管理员才能使用群管理功能。' }
    const group = pickGroup(event)
    if (!group) return { error: '无法获取群对象。' }
    const botRole = await resolveBotRole(event, group)
    if (requireBotOwner && botRole !== 'owner') return { error: '机器人不是该群的群主，无法执行此操作。' }
    if (requireBotAdmin && botRole !== 'owner' && botRole !== 'admin') return { error: '机器人不是该群的管理员，无法执行管理操作。请先把机器人设为管理员。' }
    return { group, opRole, botRole }
}

function normalizeMemberInfo(info = {}) {
    const userId = String(info.user_id || info.userId || info.uin || info.uid || '').trim()
    return {
        userId,
        nickname: info.nickname || info.nick || '',
        card: info.card || info.card_name || '',
        role: normalizeRole(info.role),
        title: info.title || info.special_title || ''
    }
}

async function getGroupMembers(event, group) {
    if (group?.getMemberMap) {
        try {
            const map = await group.getMemberMap()
            if (map?.values) return [...map.values()].map(normalizeMemberInfo).filter(m => m.userId)
        } catch { /* fallback */ }
    }
    if (group?.memberMap?.values) {
        const list = [...group.memberMap.values()].map(normalizeMemberInfo).filter(m => m.userId)
        if (list.length > 0) return list
    }
    if (event?.bot?.sendApi) {
        try {
            const res = await event.bot.sendApi('get_group_member_list', { group_id: Number(event.group_id) })
            const data = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
            return data.map(normalizeMemberInfo).filter(m => m.userId)
        } catch { /* ignore */ }
    }
    return []
}

function extractMentionedUserIds(event) {
    const ids = []
    for (const seg of event?.message || []) {
        const qq = seg?.qq || seg?.data?.qq || seg?.user_id || seg?.data?.user_id
        if (seg?.type === 'at' && qq && String(qq) !== 'all') ids.push(String(qq))
    }
    return [...new Set(ids)]
}

function memberDisplayName(member) {
    return member.card || member.nickname || member.userId
}

function matchMembers(members, query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const exact = members.filter(m =>
        m.userId === q ||
        String(m.card || '').toLowerCase() === q ||
        String(m.nickname || '').toLowerCase() === q
    )
    if (exact.length > 0) return exact
    return members.filter(m =>
        String(m.card || '').toLowerCase().includes(q) ||
        String(m.nickname || '').toLowerCase().includes(q) ||
        m.userId.includes(q)
    )
}

async function resolveTargetUserId(args, event, group) {
    const direct = String(args.user_id || '').trim()
    if (/^\d{5,}$/.test(direct)) return { ok: true, userId: direct }

    const mentions = extractMentionedUserIds(event)
    if (!direct && mentions.length === 1) return { ok: true, userId: mentions[0] }
    if (!direct && mentions.length > 1) return { ok: false, reason: `消息里 @ 了 ${mentions.length} 个人，请明确要操作哪一位。` }

    const target = String(args.target || args.user_name || args.nickname || args.name || direct || '').trim()
    if (/^\d{5,}$/.test(target)) return { ok: true, userId: target }
    if (!target) return { ok: false, reason: '请提供正确的 QQ 号，或 @ 要操作的群成员。' }

    const members = await getGroupMembers(event, group)
    if (members.length === 0) return { ok: false, reason: '无法读取群成员列表，不能按昵称定位目标。请改用 QQ 号或 @ 成员。' }
    const matches = matchMembers(members, target)
    if (matches.length === 0) return { ok: false, reason: `没有找到昵称/群名片匹配「${target}」的群成员。` }
    if (matches.length > 1) {
        const names = matches.slice(0, 8).map(m => `${memberDisplayName(m)}(${m.userId})`).join('、')
        return { ok: false, reason: `匹配到多个成员，请用 QQ 号或 @ 明确目标：${names}` }
    }
    return { ok: true, userId: matches[0].userId, member: matches[0] }
}

export const groupMuteTool = {
    name: 'group_mute',
    permission: 'everyone', // 实际权限在 chat.js 接入处与工具内 preCheck 双重把关
    description: '禁言或解除禁言指定群成员。仅主人或群管理员可用，且机器人需为管理员。适合"禁言xxx 10分钟""把那个人禁言""解除xxx的禁言"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_mute',
            description: '禁言/解禁群成员。time 为 0 表示解除禁言。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: '被操作成员的 QQ 号。可从 @ 或消息中获取。' },
                    target: { type: 'string', description: '可选。目标成员的昵称、群名片、QQ号或用户原话；没有 user_id 但用户 @ 了某人时可留空。' },
                    time: { type: 'number', description: '禁言时长数值；填 0 表示解除禁言。' },
                    unit: { type: 'string', description: '时长单位：秒/分钟/小时/天。默认分钟。', enum: ['秒', '分钟', '小时', '天'] }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event)
        if (pc.error) return `【禁言失败】${pc.error}`
        const { group } = pc

        const target = await resolveTargetUserId(args, event, group)
        if (!target.ok) return `【禁言失败】${target.reason}`
        const userId = target.userId

        const isUnmute = Number(args.time) === 0
        const seconds = isUnmute ? 0 : parseDuration(args.time ?? 10, args.unit)
        if (seconds === null) return '【禁言失败】禁言时长不合法。'

        const chk = await checkTargetAllowed(event, group, userId)
        if (!chk.ok) return `【禁言失败】${chk.reason}`

        try {
            await group.muteMember(Number(userId), seconds)
            const name = chk.info.card || chk.info.nickname || userId
            return {
                ok: true, action: isUnmute ? 'unmute' : 'mute',
                name, userId, seconds, unit: args.unit || '分钟', time: args.time
            }
        } catch (err) {
            return `【禁言失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        if (data.action === 'unmute') return `\n\n【操作成功】已解除「${data.name}」(${data.userId}) 的禁言。请如实告知操作者。`
        const dur = data.seconds >= 86400 ? `${(data.seconds / 86400).toFixed(0)}天`
            : data.seconds >= 3600 ? `${(data.seconds / 3600).toFixed(0)}小时`
            : data.seconds >= 60 ? `${(data.seconds / 60).toFixed(0)}分钟` : `${data.seconds}秒`
        return `\n\n【操作成功】已禁言「${data.name}」(${data.userId}) ${dur}。请如实告知操作者。`
    }
}

export const groupWholeMuteTool = {
    name: 'group_whole_mute',
    permission: 'everyone',
    description: '开启或解除全员禁言。仅主人或群管理员可用，且机器人需为管理员。适合"开启全员禁言""全体禁言""解除全员禁言"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_whole_mute',
            description: '开启/解除全员禁言。',
            parameters: {
                type: 'object',
                properties: {
                    enable: { type: 'boolean', description: 'true 开启全员禁言，false 解除。' }
                },
                required: ['enable']
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        if (typeof args.enable !== 'boolean') return '【全员禁言失败】请明确说明是开启还是解除全员禁言。'
        const pc = await preCheck(event)
        if (pc.error) return `【全员禁言失败】${pc.error}`
        const enable = args.enable
        try {
            await pc.group.muteAll(enable)
            return { ok: true, enable }
        } catch (err) {
            return `【全员禁言失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        return `\n\n【操作成功】已${data.enable ? '开启' : '解除'}全员禁言。请如实告知操作者。`
    }
}

export const groupKickTool = {
    name: 'group_kick',
    permission: 'everyone',
    description: '把指定成员踢出群聊，可选拉黑（不再接受其加群申请）。仅主人或群管理员可用，且机器人需为管理员。适合"把xxx踢了""踢出那个人并拉黑"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_kick',
            description: '踢出群成员。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: '被踢成员的 QQ 号。' },
                    target: { type: 'string', description: '可选。目标成员的昵称、群名片、QQ号或用户原话；没有 user_id 但用户 @ 了某人时可留空。' },
                    block: { type: 'boolean', description: '是否拉黑，true 表示不再接受其加群申请。默认 false。' }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event)
        if (pc.error) return `【踢人失败】${pc.error}`
        const { group } = pc

        const target = await resolveTargetUserId(args, event, group)
        if (!target.ok) return `【踢人失败】${target.reason}`
        const userId = target.userId

        const chk = await checkTargetAllowed(event, group, userId)
        if (!chk.ok) return `【踢人失败】${chk.reason}`

        const block = args.block === true
        try {
            const res = await group.kickMember(Number(userId), block)
            if (res === false) return `【踢人失败】踢出 ${userId} 未成功，可能权限不足。`
            const name = chk.info.card || chk.info.nickname || userId
            return { ok: true, name, userId, block }
        } catch (err) {
            return `【踢人失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        return `\n\n【操作成功】已将「${data.name}」(${data.userId}) 踢出群聊${data.block ? '并拉黑' : ''}。请如实告知操作者。`
    }
}

export const groupSetCardTool = {
    name: 'group_set_card',
    permission: 'everyone',
    description: '修改指定群成员的群名片（群昵称）。仅主人或群管理员可用，且机器人需为管理员。适合"把xxx的名片改成yyy""给那个人改群昵称"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_set_card',
            description: '设置群成员名片。card 留空表示清除名片。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: '成员 QQ 号。' },
                    target: { type: 'string', description: '可选。目标成员的昵称、群名片、QQ号或用户原话；没有 user_id 但用户 @ 了某人时可留空。' },
                    card: { type: 'string', description: '新群名片；留空字符串表示清除名片。' }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event)
        if (pc.error) return `【改名片失败】${pc.error}`
        const { group } = pc
        const target = await resolveTargetUserId(args, event, group)
        if (!target.ok) return `【改名片失败】${target.reason}`
        const userId = target.userId
        const chk = await checkTargetAllowed(event, group, userId)
        if (!chk.ok) return `【改名片失败】${chk.reason}`
        const card = String(args.card ?? '')
        try {
            await group.setCard(Number(userId), card)
            return { ok: true, userId, card }
        } catch (err) {
            return `【改名片失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        return `\n\n【操作成功】已将 ${data.userId} 的群名片${data.card ? `改为「${data.card}」` : '清除'}。请如实告知操作者。`
    }
}

export const groupSetTitleTool = {
    name: 'group_set_title',
    permission: 'everyone',
    description: '给指定群成员设置或清除专属头衔（仅群主有此权限，机器人需为群主）。适合"给xxx一个专属头衔yyy""取消那个人的头衔"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_set_title',
            description: '设置群成员专属头衔。title 留空表示清除头衔。需机器人为群主。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: '成员 QQ 号。' },
                    target: { type: 'string', description: '可选。目标成员的昵称、群名片、QQ号或用户原话；没有 user_id 但用户 @ 了某人时可留空。' },
                    title: { type: 'string', description: '专属头衔文本；留空表示清除。' }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event, { requireBotOwner: true })
        if (pc.error) return `【设头衔失败】${pc.error}`
        const { group } = pc
        const target = await resolveTargetUserId(args, event, group)
        if (!target.ok) return `【设头衔失败】${target.reason}`
        const userId = target.userId
        const chk = await checkTargetAllowed(event, group, userId)
        if (!chk.ok) return `【设头衔失败】${chk.reason}`
        const title = String(args.title ?? '')
        try {
            await group.setTitle(Number(userId), title)
            return { ok: true, userId, title }
        } catch (err) {
            return `【设头衔失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        return `\n\n【操作成功】已将 ${data.userId} 的专属头衔${data.title ? `设为「${data.title}」` : '清除'}。请如实告知操作者。`
    }
}

export const groupEssenceTool = {
    name: 'group_essence',
    permission: 'everyone',
    description: '将引用的某条消息设为精华或取消精华。仅主人或群管理员可用，且机器人需为管理员。适合引用一条消息说"设为精华""加精""取消精华"。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_essence',
            description: '设置/取消精华消息。需操作者引用目标消息。',
            parameters: {
                type: 'object',
                properties: {
                    enable: { type: 'boolean', description: 'true 设为精华，false 取消精华。必须明确填写。' }
                },
                required: ['enable']
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        if (typeof args.enable !== 'boolean') return '【精华消息失败】请明确说明是设为精华还是取消精华。'
        const pc = await preCheck(event)
        if (pc.error) return `【精华消息失败】${pc.error}`
        // 取被引用消息的 message_id
        const messageId = event.source?.message_id || event.source?.seq || event.reply_id
        if (!messageId) return '【精华消息失败】请「引用」要操作的那条消息后再下达指令。'
        const enable = args.enable
        try {
            const bot = event.bot || (typeof Bot !== 'undefined' ? Bot : null)
            if (enable) {
                if (event.group.addEssenceMessage) await event.group.addEssenceMessage(messageId)
                else await bot.sendApi('set_essence_msg', { message_id: messageId })
            } else {
                if (event.group.removeEssenceMessage) await event.group.removeEssenceMessage(messageId)
                else await bot.sendApi('delete_essence_msg', { message_id: messageId })
            }
            return { ok: true, enable }
        } catch (err) {
            return `【精华消息失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        return `\n\n【操作成功】已${data.enable ? '将该消息设为精华' : '取消该消息的精华'}。请如实告知操作者。`
    }
}

export const groupMemberListTool = {
    name: 'group_member_list',
    permission: 'everyone',
    description: '查看当前 QQ 群成员列表或按昵称/群名片搜索成员。仅主人或群管理员可用。适合"群里有哪些成员""查一下群成员""找一下昵称叫xxx的人"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_member_list',
            description: '列出或搜索当前群成员。仅主人或群管理员可用。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '可选，按昵称、群名片或 QQ 号搜索成员；不填则列出成员列表。' },
                    limit: { type: 'number', description: '可选，最多返回多少名成员，默认 80，最大 200。' }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event, { requireBotAdmin: false })
        if (pc.error) return `【群成员查询失败】${pc.error}`
        const members = await getGroupMembers(event, pc.group)
        if (members.length === 0) return '【群成员查询失败】无法读取群成员列表，当前协议端可能不支持。'

        const query = String(args.query || '').trim()
        const limit = Math.min(Math.max(Number(args.limit) || 80, 1), 200)
        const matched = query ? matchMembers(members, query) : members
        return {
            ok: true,
            query,
            total: members.length,
            matched: matched.length,
            limit,
            members: matched.slice(0, limit)
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        if (data.matched === 0) return `\n\n【群成员查询结果】没有找到匹配「${data.query}」的成员。请如实告知操作者。`
        const title = data.query
            ? `【群成员查询结果】全群 ${data.total} 人，匹配「${data.query}」共 ${data.matched} 人`
            : `【群成员列表】全群 ${data.total} 人`
        const lines = data.members.map((m, i) => {
            const names = [m.card ? `群名片：${m.card}` : '', m.nickname ? `昵称：${m.nickname}` : ''].filter(Boolean).join('，') || '无名称'
            const role = m.role === 'owner' ? '群主' : (m.role === 'admin' ? '管理员' : '成员')
            return `${i + 1}. ${names}，QQ：${m.userId}，身份：${role}${m.title ? `，头衔：${m.title}` : ''}`
        })
        const omitted = data.matched > data.members.length ? `\n（仅显示前 ${data.members.length} 人，仍有 ${data.matched - data.members.length} 人未列出。）` : ''
        return `\n\n${title}：\n${lines.join('\n')}${omitted}\n【转述要求】请按上面实际结果回复，不要编造成员。`
    }
}

export const groupMemberResolveTool = {
    name: 'group_member_resolve',
    permission: 'everyone',
    description: '把用户说的成员昵称、群名片、QQ号或 @ 对象解析为明确群成员。仅主人或群管理员可用。适合执行群管理前确认目标。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_member_resolve',
            description: '解析群成员目标，返回匹配到的成员 QQ、昵称、群名片和身份。',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: '用户提到的目标成员昵称、群名片、QQ号或原话。用户已 @ 成员时可留空。' }
                },
                required: []
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        const pc = await preCheck(event, { requireBotAdmin: false })
        if (pc.error) return `【群成员解析失败】${pc.error}`

        const target = await resolveTargetUserId(args, event, pc.group)
        if (!target.ok) return `【群成员解析失败】${target.reason}`
        const info = await resolveMemberInfo(pc.group, event, target.userId)
        const member = normalizeMemberInfo(info || { user_id: target.userId })
        return { ok: true, member }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        const m = data.member
        const role = m.role === 'owner' ? '群主' : (m.role === 'admin' ? '管理员' : '成员')
        return `\n\n【群成员解析结果】目标成员：${memberDisplayName(m)}，QQ：${m.userId}，身份：${role}${m.title ? `，头衔：${m.title}` : ''}。请基于这个明确目标继续回答或执行后续操作。`
    }
}

// 扫描某群下所有待审入群申请
async function scanPendingRequests(groupId) {
    if (typeof redis === 'undefined' || !redis.keys) return []
    const keys = await redis.keys(GROUP_REQUEST_SCAN(groupId))
    const list = []
    for (const k of keys) {
        try {
            const raw = await redis.get(k)
            if (raw) list.push(JSON.parse(raw))
        } catch { /* 忽略损坏记录 */ }
    }
    // 按申请时间排序
    list.sort((a, b) => (a.time || 0) - (b.time || 0))
    return list
}

export const groupRequestListTool = {
    name: 'group_request_list',
    permission: 'everyone',
    description: '查看当前群「待审核」的加群申请列表（谁在申请进群、附加留言）。仅主人或群管理员可用。适合"有没有人申请进群""看看入群申请"等。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_request_list',
            description: '列出当前群待处理的加群申请。',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event?.group_id) return '【查看申请失败】仅在群聊中可用。'
        if (await resolveGroupOperatorRole(event) === 'member') return '【查看申请失败】权限不足：仅主人或群管理员可用。'
        const list = await scanPendingRequests(event.group_id)
        return { ok: true, list }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        if (!data.list.length) return '\n\n【查询结果】当前没有待审核的加群申请。请如实告知操作者。'
        const lines = data.list.map((r, i) =>
            `${i + 1}. QQ：${r.user_id}　昵称：${r.nickname || '未知'}${r.comment ? `　留言：${r.comment}` : ''}`)
        return `\n\n【查询结果】当前共有 ${data.list.length} 条待审核加群申请，请如实列给操作者，不要编造：\n${lines.join('\n')}`
    }
}

export const groupRequestHandleTool = {
    name: 'group_request_handle',
    permission: 'everyone',
    description: '通过或拒绝某个加群申请。仅主人或群管理员可用，机器人需为管理员。适合"通过xxx的申请""同意那个人进群""拒绝xxx的入群申请"等。需先有待审申请；若当前群只有一条待审申请，可省略 user_id。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'group_request_handle',
            description: '处理加群申请（通过/拒绝）。通过 user_id 定位申请。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: { type: 'string', description: '申请人的 QQ 号。只有一条待审申请且用户说"刚才那个/他/那个人"时可省略。' },
                    approve: { type: 'boolean', description: 'true 通过，false 拒绝。必须明确填写。' },
                    reason: { type: 'string', description: '拒绝理由（仅 approve=false 时有意义），可选。' }
                },
                required: ['approve']
            }
        }
    },
    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event?.group_id) return '【处理申请失败】仅在群聊中可用。'
        if (await resolveGroupOperatorRole(event) === 'member') return '【处理申请失败】权限不足：仅主人或群管理员可用。'
        const group = pickGroup(event)
        if (!await botIsAdmin(event, group)) return '【处理申请失败】机器人不是该群管理员，无法处理加群申请。'

        let userId = String(args.user_id || '').trim()
        if (typeof args.approve !== 'boolean') return '【处理申请失败】请明确说明是通过还是拒绝该申请。'

        if (typeof redis === 'undefined' || !redis.get) return '【处理申请失败】redis 不可用，无法读取申请记录。'
        if (!/^\d{5,}$/.test(userId)) {
            const pending = await scanPendingRequests(event.group_id)
            if (pending.length === 0) return '【处理申请失败】当前没有待审核的加群申请。'
            if (pending.length > 1) {
                const lines = pending.map((r, i) => `${i + 1}. ${r.nickname || '未知'}(${r.user_id})`).join('、')
                return `【处理申请失败】当前有多条待审核申请，请指定 QQ 号：${lines}`
            }
            userId = String(pending[0].user_id)
        }
        const key = GROUP_REQUEST_KEY(event.group_id, userId)
        const raw = await redis.get(key)
        if (!raw) return `【处理申请失败】没有找到 ${userId} 的待审核加群申请，可能已过期或已被处理。`

        let record
        try { record = JSON.parse(raw) } catch { return '【处理申请失败】申请记录已损坏。' }

        const approve = args.approve
        const reason = approve ? '' : String(args.reason || '')
        try {
            const bot = event.bot || (typeof Bot !== 'undefined' ? Bot : null)
            if (bot?.setGroupAddRequest) {
                await bot.setGroupAddRequest(record.flag, record.sub_type || 'add', approve, reason)
            } else if (bot?.sendApi) {
                await bot.sendApi('set_group_add_request', {
                    flag: record.flag, sub_type: record.sub_type || 'add', approve, reason
                })
            } else {
                return '【处理申请失败】当前协议端不支持处理加群申请。'
            }
            await redis.del(key)
            return { ok: true, approve, userId, nickname: record.nickname }
        } catch (err) {
            return `【处理申请失败】操作出错: ${err.message}`
        }
    },
    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data?.ok) return String(data || '')
        const who = data.nickname ? `「${data.nickname}」(${data.userId})` : data.userId
        return `\n\n【操作成功】已${data.approve ? '通过' : '拒绝'} ${who} 的加群申请。请如实告知操作者。`
    }
}

toolRegistry.register(groupMuteTool)
toolRegistry.register(groupWholeMuteTool)
toolRegistry.register(groupKickTool)
toolRegistry.register(groupSetCardTool)
toolRegistry.register(groupSetTitleTool)
toolRegistry.register(groupEssenceTool)
toolRegistry.register(groupMemberListTool)
toolRegistry.register(groupMemberResolveTool)
toolRegistry.register(groupRequestListTool)
toolRegistry.register(groupRequestHandleTool)
