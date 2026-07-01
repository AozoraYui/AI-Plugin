/**
 * 群消息代发工具
 * 仅主人可用：把主人明确给出的纯文本消息发送到指定群。
 */

import { parseGroupSendRequest } from '../utils/tool_intent.js'
import { toolRegistry } from './registry.js'

const DEFAULT_PREFIX = '【主人转达】'
const MAX_MESSAGE_LENGTH = 1000

function normalizeGroup(group = {}) {
    const groupId = group.group_id ?? group.groupId ?? group.id
    if (!groupId) return null
    return {
        groupId: String(groupId),
        groupName: group.group_name || group.groupName || group.name || '',
        memberCount: group.member_count ?? group.memberCount ?? null,
        maxMemberCount: group.max_member_count ?? group.maxMemberCount ?? null,
        source: group.source || 'live'
    }
}

function cleanTargetText(text = '') {
    return String(text || '')
        .trim()
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        .replace(/^(?:在|去|到|往|给)\s*/i, '')
        .replace(/(?:群聊|群里|群内|这个群|那个群|那边|里面|里|群)$/i, '')
        .trim()
}

function normalizeForMatch(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/[【】\[\]（）()《》<>「」『』"'“”‘’~_\-\s]/g, '')
        .replace(/(?:群聊|群里|群内|这个群|那个群|那边|里面|里|群)$/g, '')
        .trim()
}

async function fetchLiveGroups(bot) {
    if (!bot?.sendApi) return { groups: [], error: '当前适配器不支持 get_group_list。' }
    try {
        const res = await bot.sendApi('get_group_list', {})
        const rawGroups = Array.isArray(res)
            ? res
            : (Array.isArray(res?.data) ? res.data : (Array.isArray(res?.groups) ? res.groups : []))
        return { groups: rawGroups.map(normalizeGroup).filter(Boolean), error: '' }
    } catch (err) {
        return { groups: [], error: err.message || String(err) }
    }
}

async function getCapturedGroups(query = '') {
    const manager = global.AIPluginConversationManager
    if (!manager?.db?.getGroupMessageLogGroups) return []
    const groups = await manager.db.getGroupMessageLogGroups({ limit: 200, query, excludeCommands: true })
    return groups.map(group => ({
        groupId: String(group.groupId),
        groupName: group.groupName || '',
        messageCount: group.messageCount || 0,
        lastMessageAt: group.lastMessageAt || '',
        source: 'captured'
    }))
}

function mergeGroups(liveGroups = [], capturedGroups = []) {
    const map = new Map()
    for (const group of capturedGroups) {
        if (group?.groupId) map.set(String(group.groupId), group)
    }
    for (const group of liveGroups) {
        if (!group?.groupId) continue
        map.set(String(group.groupId), { ...(map.get(String(group.groupId)) || {}), ...group, source: 'live' })
    }
    return [...map.values()]
}

function rankGroupMatch(group, target) {
    const rawTarget = cleanTargetText(target)
    const targetNorm = normalizeForMatch(rawTarget)
    const id = String(group.groupId || '')
    const name = String(group.groupName || '')
    const nameNorm = normalizeForMatch(name)

    if (!rawTarget) return 0
    if (id === rawTarget) return 100
    if (/^\d+$/.test(rawTarget) && id.includes(rawTarget)) return rawTarget.length >= 6 ? 90 : 20
    if (!nameNorm || !targetNorm) return 0
    if (nameNorm === targetNorm) return 85
    if (nameNorm.includes(targetNorm)) return targetNorm.length >= 2 ? 70 + Math.min(targetNorm.length, 10) : 0
    if (targetNorm.includes(nameNorm) && nameNorm.length >= 2) return 60

    const chars = [...new Set([...targetNorm].filter(ch => /[\u4e00-\u9fa5a-z0-9]/i.test(ch)))]
    if (chars.length >= 2) {
        const hit = chars.filter(ch => nameNorm.includes(ch)).length
        const ratio = hit / chars.length
        if (hit >= 2 && ratio >= 0.65) return Math.floor(45 + ratio * 20)
    }
    return 0
}

function formatGroupCandidate(group, index) {
    const name = group.groupName ? `「${group.groupName}」` : '群名未知'
    const member = group.memberCount !== null && group.memberCount !== undefined ? `，成员 ${group.memberCount}${group.maxMemberCount ? `/${group.maxMemberCount}` : ''}` : ''
    const captured = group.messageCount ? `，已捕获 ${group.messageCount} 条` : ''
    return `${index + 1}. ${name}（${group.groupId}，${group.source || 'unknown'}${member}${captured}）`
}

async function resolveTargetGroup(args = {}, event = {}) {
    const bot = event?.bot
    const directGroupId = String(args.group_id || '').trim()
    const target = cleanTargetText(args.target || args.group_name || args.group || '')

    const liveResult = await fetchLiveGroups(bot)
    const capturedGroups = await getCapturedGroups(/^\d+$/.test(directGroupId || target) ? (directGroupId || target) : '')
    const groups = mergeGroups(liveResult.groups, capturedGroups)

    if (directGroupId) {
        if (!/^\d{5,15}$/.test(directGroupId)) {
            return { ok: false, error: '群号格式不正确，请提供纯数字 QQ 群号。', candidates: groups.slice(0, 8), liveError: liveResult.error }
        }
        const exact = groups.find(group => group.groupId === directGroupId) || { groupId: directGroupId, groupName: '', source: 'direct' }
        return { ok: true, group: exact, candidates: [exact], liveError: liveResult.error }
    }

    if (target && /^(?:本群|当前群|这个群|這個群|这里|這裡|这边|這邊)$/i.test(target)) {
        if (!event?.group_id) {
            return { ok: false, error: '当前不是群聊，无法使用“本群/当前群”作为目标。', candidates: groups.slice(0, 8), liveError: liveResult.error }
        }
        const current = groups.find(group => group.groupId === String(event.group_id)) || { groupId: String(event.group_id), groupName: event.group_name || '', source: 'current' }
        return { ok: true, group: current, candidates: [current], liveError: liveResult.error }
    }

    if (!target) {
        return { ok: false, error: '缺少明确目标群：请提供群号、群名关键词，或在群聊中明确说“本群/当前群”。', candidates: groups.slice(0, 8), liveError: liveResult.error }
    }

    const ranked = groups
        .map(group => ({ group, score: rankGroupMatch(group, target) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || String(a.group.groupId).localeCompare(String(b.group.groupId)))

    if (ranked.length === 0) {
        return { ok: false, error: `没有找到匹配「${target}」的可见群。`, candidates: groups.slice(0, 8), liveError: liveResult.error }
    }

    const bestScore = ranked[0].score
    const best = ranked.filter(item => item.score === bestScore).map(item => item.group)
    if (best.length === 1 && (bestScore >= 70 || ranked.length === 1)) {
        return { ok: true, group: best[0], candidates: ranked.slice(0, 8).map(item => item.group), liveError: liveResult.error }
    }

    return {
        ok: false,
        error: `目标群「${target}」匹配到多个候选，请改用群号或更精确的群名。`,
        candidates: ranked.slice(0, 8).map(item => item.group),
        liveError: liveResult.error
    }
}

function normalizeMessage(raw) {
    const message = String(raw || '').trim()
    if (!message) return { ok: false, error: '缺少要发送的消息内容。' }
    if (message.length > MAX_MESSAGE_LENGTH) return { ok: false, error: `消息过长：最多 ${MAX_MESSAGE_LENGTH} 字。` }
    if (/\[CQ:/i.test(message) || /&#91;CQ:/i.test(message)) {
        return { ok: false, error: '为安全起见，代发消息只允许纯文本，不允许 CQ 码。' }
    }
    return { ok: true, message }
}

async function sendGroupText(bot, groupId, text) {
    const numericGroupId = Number(groupId)
    if (!Number.isSafeInteger(numericGroupId) || numericGroupId <= 0) {
        throw new Error('群号格式不正确，无法发送群消息。')
    }
    const group = bot?.pickGroup ? bot.pickGroup(numericGroupId) : null
    if (group?.sendMsg) {
        await group.sendMsg(text)
        return 'pickGroup.sendMsg'
    }
    if (bot?.sendApi) {
        await bot.sendApi('send_group_msg', {
            group_id: numericGroupId,
            message: text
        })
        return 'sendApi(send_group_msg)'
    }
    throw new Error('当前适配器不支持发送群消息。')
}

export const groupSendMessageTool = {
    name: 'group_send_message',
    permission: 'master',
    description: '代主人向指定 QQ 群发送一条纯文本消息。仅限主人。适合“帮我在xx群说一下xxx”“去某群发一句xxx”。目标群必须唯一，默认会加转达前缀，防止伪装主人本人。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_send_message',
            description: '给主人代发纯文本群消息。目标群可用 group_id 精确指定，也可用 target/group_name 模糊匹配机器人可见群名。',
            parameters: {
                type: 'object',
                properties: {
                    group_id: {
                        type: 'string',
                        description: '可选，目标群号。能确定群号时优先填写。'
                    },
                    target: {
                        type: 'string',
                        description: '可选，目标群名、群名关键词或用户原话中的群称呼。没有 group_id 时用于模糊匹配可见群。'
                    },
                    message: {
                        type: 'string',
                        description: '必填，要代发的纯文本内容。必须来自用户明确要求发送的内容，不要自行补全或改写。'
                    },
                    as_is: {
                        type: 'boolean',
                        description: '可选。只有用户明确要求“原样发送/不要前缀/直接发原文”时设为 true；默认 false 会加“【主人转达】”前缀。'
                    }
                },
                required: ['message']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!context.isMaster && !event?.isMaster) {
            return { ok: false, error: '权限不足：代发群消息仅限主人使用。' }
        }
        if (global.AIPluginClient?.enableGroupSend !== true) {
            return { ok: false, error: '群消息代发工具未启用。请先在 models_config.yaml 设置 enable_group_send: true，或使用 #ai开启代发。' }
        }
        if (!event?.bot) {
            return { ok: false, error: '缺少 bot 上下文，无法发送群消息。' }
        }

        const explicitRequest = parseGroupSendRequest(context.originalUserMessage || context.userMessage || '')
        if (!explicitRequest) {
            logger.warn('[AI-Plugin] group_send_message 已拦截：原始当前指令缺少明确代发意图')
            return { ok: false, error: '为避免误发，代发群消息必须由主人在当前这条消息里明确写出目标群和要发送的纯文本内容。' }
        }

        const safeArgs = {
            message: explicitRequest.message,
            as_is: explicitRequest.as_is === true
        }
        if (explicitRequest.group_id) safeArgs.group_id = explicitRequest.group_id
        else safeArgs.target = explicitRequest.target

        const messageResult = normalizeMessage(safeArgs.message)
        if (!messageResult.ok) return messageResult

        const targetResult = await resolveTargetGroup(safeArgs, event)
        if (!targetResult.ok) {
            logger.warn(`[AI-Plugin] group_send_message 目标群解析失败: ${targetResult.error}`)
            return {
                ok: false,
                error: targetResult.error,
                candidates: targetResult.candidates || [],
                liveError: targetResult.liveError || ''
            }
        }

        const group = targetResult.group
        const finalMessage = safeArgs.as_is === true
            ? messageResult.message
            : `${DEFAULT_PREFIX}${messageResult.message}`

        const method = await sendGroupText(event.bot, group.groupId, finalMessage)
        logger.info(`[AI-Plugin] group_send_message 已代发: 群=${group.groupId}(${group.groupName || '未知'}), 字数=${finalMessage.length}, method=${method}`)
        return {
            ok: true,
            groupId: group.groupId,
            groupName: group.groupName || '',
            message: finalMessage,
            originalMessage: messageResult.message,
            asIs: safeArgs.as_is === true,
            method
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            const candidateText = Array.isArray(data?.candidates) && data.candidates.length > 0
                ? `\n候选群：\n${data.candidates.map(formatGroupCandidate).join('\n')}`
                : ''
            const liveError = data?.liveError ? `\n实时群列表提示：${data.liveError}` : ''
            return `\n\n【群消息代发失败】${data?.error || '未知错误'}${candidateText}${liveError}`
        }
        const name = data.groupName ? `「${data.groupName}」` : '群名未知'
        return `\n\n【群消息代发成功】已发送到 ${name}（${data.groupId}）。\n发送内容：${data.message}`
    }
}

toolRegistry.register(groupSendMessageTool)
