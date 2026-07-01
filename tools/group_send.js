/**
 * 群消息代发工具
 * 仅主人可用：把主人明确给出的纯文本消息发送到指定群。
 */

import { parseGroupSendRequest } from '../utils/tool_intent.js'
import { formatPendingActionHint, formatPendingTtl, savePendingAction } from '../utils/pending_actions.js'
import { toolRegistry } from './registry.js'

const DEFAULT_PREFIX = '【主人转达】'
const MAX_MESSAGE_LENGTH = 1000
const MAX_BATCH_TARGETS = 5

export function normalizeGroup(group = {}) {
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

export function cleanTargetText(text = '') {
    return String(text || '')
        .trim()
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        .replace(/^(?:在|去|到|往|给)\s*/i, '')
        .replace(/(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)$/i, '')
        .replace(/(?:群聊|群里|群内|这个群|那个群|那边|里面|里|群)$/i, '')
        .trim()
}

export function normalizeForMatch(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/[【】\[\]（）()《》<>「」『』"'“”‘’~_\-\s]/g, '')
        .replace(/(?:群聊|群里|群内|这个群|那个群|那边|里面|里|群)$/g, '')
        .trim()
}

export async function fetchLiveGroups(bot) {
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

export async function getCapturedGroups(query = '') {
    const manager = global.AIPluginConversationManager
    if (!manager?.db?.getGroupMessageLogGroups) return []
    const groups = await manager.db.getGroupMessageLogGroups({ limit: 200, query })
    return groups.map(group => ({
        groupId: String(group.groupId),
        groupName: group.groupName || '',
        messageCount: group.messageCount || 0,
        lastMessageAt: group.lastMessageAt || '',
        source: 'captured'
    }))
}

export function mergeGroups(liveGroups = [], capturedGroups = []) {
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

export function rankGroupMatch(group, target) {
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

export function formatGroupCandidate(group, index) {
    const name = group.groupName ? `「${group.groupName}」` : '群名未知'
    const member = group.memberCount !== null && group.memberCount !== undefined ? `，成员 ${group.memberCount}${group.maxMemberCount ? `/${group.maxMemberCount}` : ''}` : ''
    const captured = group.messageCount ? `，已捕获 ${group.messageCount} 条` : ''
    return `${index + 1}. ${name}（${group.groupId}，${group.source || 'unknown'}${member}${captured}）`
}

export async function resolveTargetGroup(args = {}, event = {}) {
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

function toArray(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
    const text = String(value || '').trim()
    return text ? [text] : []
}

function buildGroupTargetSpecs(args = {}) {
    const specs = []
    for (const groupId of toArray(args.group_ids)) specs.push({ group_id: groupId, label: groupId })
    for (const groupId of toArray(args.group_id)) specs.push({ group_id: groupId, label: groupId })
    for (const target of toArray(args.targets)) specs.push({ target, label: target })
    for (const target of toArray(args.target || args.group_name || args.group)) specs.push({ target, label: target })

    const seen = new Set()
    return specs.filter(spec => {
        const key = `${spec.group_id ? 'id' : 'target'}:${spec.group_id || spec.target}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function compactGroup(group = {}) {
    return {
        groupId: String(group.groupId || group.group_id || ''),
        groupName: group.groupName || group.group_name || '',
        source: group.source || ''
    }
}

function formatGroupLine(group, index) {
    const name = group.groupName ? `「${group.groupName}」` : '群名未知'
    return `${index + 1}. ${name}（${group.groupId}）`
}

export async function resolveTargetGroups(args = {}, event = {}, options = {}) {
    if (args.forbidden_set) {
        return { ok: false, error: '目标群是开放式集合。为避免误操作，请明确列出每个目标群号或唯一群名。', candidates: [] }
    }
    const maxTargets = Number.isFinite(Number(options.maxTargets)) ? Math.max(1, Number(options.maxTargets)) : MAX_BATCH_TARGETS
    const specs = buildGroupTargetSpecs(args)
    if (specs.length === 0) {
        return { ok: false, error: '缺少明确目标群：请提供群号、群名关键词，或在群聊中明确说“本群/当前群”。', candidates: [] }
    }
    if (specs.length > maxTargets) {
        return { ok: false, error: `一次最多处理 ${maxTargets} 个明确目标群；请减少数量后重试。`, candidates: [] }
    }

    const groups = []
    const seenGroupIds = new Set()
    for (const spec of specs) {
        const result = await resolveTargetGroup(spec, event)
        if (!result.ok) {
            return {
                ok: false,
                error: `目标「${spec.label || spec.group_id || spec.target || '未知'}」解析失败：${result.error}`,
                candidates: result.candidates || [],
                liveError: result.liveError || ''
            }
        }
        const group = compactGroup(result.group)
        if (!group.groupId || seenGroupIds.has(group.groupId)) continue
        seenGroupIds.add(group.groupId)
        groups.push(group)
    }
    if (groups.length === 0) {
        return { ok: false, error: '没有解析出可执行的目标群。', candidates: [] }
    }
    return { ok: true, groups, isBatch: groups.length > 1 }
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

export async function executePendingGroupSend(record = {}, event = {}) {
    if (record.type !== 'group_send_message') {
        return { ok: false, error: '待确认操作类型不是群消息代发。' }
    }
    if (global.AIPluginClient?.enableGroupSend !== true) {
        return { ok: false, error: '群消息代发工具未启用。' }
    }
    if (!event?.bot) {
        return { ok: false, error: '缺少 bot 上下文，无法发送群消息。' }
    }
    const groups = Array.isArray(record.groups) ? record.groups.map(compactGroup).filter(group => group.groupId) : []
    if (groups.length === 0) {
        return { ok: false, error: '待确认操作里没有有效目标群。' }
    }
    const messageResult = normalizeMessage(record.message)
    if (!messageResult.ok) return messageResult

    const results = []
    for (const group of groups) {
        try {
            const method = await sendGroupText(event.bot, group.groupId, messageResult.message)
            logger.info(`[AI-Plugin] group_send_message 确认后已代发: 群=${group.groupId}(${group.groupName || '未知'}), 字数=${messageResult.message.length}, method=${method}`)
            results.push({ ok: true, groupId: group.groupId, groupName: group.groupName || '', method })
        } catch (err) {
            logger.warn(`[AI-Plugin] group_send_message 确认后发送失败: 群=${group.groupId}, ${err.message || String(err)}`)
            results.push({ ok: false, groupId: group.groupId, groupName: group.groupName || '', error: err.message || String(err) })
        }
    }

    const failed = results.filter(item => !item.ok)
    return {
        ok: failed.length === 0,
        partial: failed.length > 0 && failed.length < results.length,
        results,
        message: messageResult.message,
        originalMessage: record.originalMessage || '',
        asIs: record.asIs === true
    }
}

export const groupSendMessageTool = {
    name: 'group_send_message',
    permission: 'master',
    description: '代主人向指定 QQ 群发送纯文本消息。仅限主人。适合“帮我在xx群说一下xxx”“去A群和B群发xxx”。支持最多 5 个明确目标；执行前会创建待确认操作，主人确认后才发送。',

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
                    group_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '可选，多个明确目标群号。只有用户当前消息显式列出多个群号时填写。'
                    },
                    target: {
                        type: 'string',
                        description: '可选，目标群名、群名关键词或用户原话中的群称呼。没有 group_id 时用于模糊匹配可见群。'
                    },
                    targets: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '可选，多个明确目标群名或关键词。只有用户当前消息显式列出多个群名时填写。'
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
        if (explicitRequest.group_ids) safeArgs.group_ids = explicitRequest.group_ids
        if (explicitRequest.group_id) safeArgs.group_id = explicitRequest.group_id
        if (explicitRequest.targets) safeArgs.targets = explicitRequest.targets
        if (explicitRequest.target) safeArgs.target = explicitRequest.target

        const messageResult = normalizeMessage(safeArgs.message)
        if (!messageResult.ok) return messageResult

        const targetResult = await resolveTargetGroups(safeArgs, event, { maxTargets: MAX_BATCH_TARGETS })
        if (!targetResult.ok) {
            logger.warn(`[AI-Plugin] group_send_message 目标群解析失败: ${targetResult.error}`)
            return {
                ok: false,
                error: targetResult.error,
                candidates: targetResult.candidates || [],
                liveError: targetResult.liveError || ''
            }
        }

        const finalMessage = safeArgs.as_is === true
            ? messageResult.message
            : `${DEFAULT_PREFIX}${messageResult.message}`

        const saveResult = await savePendingAction(event.user_id || context.userId, {
            type: 'group_send_message',
            groups: targetResult.groups,
            message: finalMessage,
            originalMessage: messageResult.message,
            asIs: safeArgs.as_is === true
        })
        if (!saveResult.ok) return { ok: false, error: saveResult.error }

        logger.warn(`[AI-Plugin] group_send_message 已创建待确认操作: 群=${targetResult.groups.map(group => group.groupId).join(',')}, 字数=${finalMessage.length}, pending=${saveResult.record.id}`)
        return {
            ok: true,
            pending: true,
            pendingId: saveResult.record.id,
            expiresAt: saveResult.record.expiresAt,
            groups: targetResult.groups,
            message: finalMessage,
            originalMessage: messageResult.message,
            asIs: safeArgs.as_is === true,
            confirmationHint: formatPendingActionHint()
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
        if (data.pending) {
            const groupText = (data.groups || []).map(formatGroupLine).join('\n')
            return `\n\n【群消息代发待确认】尚未发送。目标群：\n${groupText}\n发送内容：${data.message}\n请在 ${formatPendingTtl(data)} 内继续回复。\n${data.confirmationHint || formatPendingActionHint()}`
        }
        if (Array.isArray(data.results)) {
            const success = data.results.filter(item => item.ok)
            const failed = data.results.filter(item => !item.ok)
            const successText = success.length ? `成功：\n${success.map(formatGroupLine).join('\n')}` : '成功：无'
            const failedText = failed.length ? `\n失败：\n${failed.map((item, index) => `${index + 1}. ${item.groupName ? `「${item.groupName}」` : '群名未知'}（${item.groupId}）：${item.error || '未知错误'}`).join('\n')}` : ''
            return `\n\n【群消息代发执行完成】${data.ok ? '全部发送成功。' : (data.partial ? '部分发送成功。' : '全部发送失败。')}\n${successText}${failedText}\n发送内容：${data.message}`
        }
        const name = data.groupName ? `「${data.groupName}」` : '群名未知'
        return `\n\n【群消息代发成功】已发送到 ${name}（${data.groupId}）。\n发送内容：${data.message}`
    }
}

toolRegistry.register(groupSendMessageTool)
