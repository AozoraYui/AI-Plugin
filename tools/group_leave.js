/**
 * 群退出工具
 * 主人专用：让机器人退出指定 QQ 群。
 */

import { parseGroupLeaveRequest } from '../utils/tool_intent.js'
import { formatPendingActionHint, formatPendingTtl, savePendingAction } from '../utils/pending_actions.js'
import { toolRegistry } from './registry.js'
import { formatGroupCandidate, resolveTargetGroups } from './group_send.js'

const MAX_BATCH_TARGETS = 5

async function leaveGroup(bot, groupId) {
    const numericGroupId = Number(groupId)
    if (!Number.isSafeInteger(numericGroupId) || numericGroupId <= 0) {
        throw new Error('群号格式不正确，无法退出群聊。')
    }

    const errors = []
    if (bot?.sendApi) {
        try {
            await bot.sendApi('set_group_leave', {
                group_id: numericGroupId,
                is_dismiss: false
            })
            return 'sendApi(set_group_leave)'
        } catch (err) {
            errors.push(`set_group_leave: ${err.message || String(err)}`)
        }
    }

    const group = bot?.pickGroup ? bot.pickGroup(numericGroupId) : null
    for (const method of ['quit', 'leave']) {
        if (typeof group?.[method] !== 'function') continue
        try {
            await group[method]()
            return `pickGroup.${method}`
        } catch (err) {
            errors.push(`pickGroup.${method}: ${err.message || String(err)}`)
        }
    }

    throw new Error(errors.join('；') || '当前适配器不支持退出群聊。')
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

export async function executePendingGroupLeave(record = {}, event = {}) {
    if (record.type !== 'group_leave') {
        return { ok: false, error: '待确认操作类型不是退群。' }
    }
    if (global.AIPluginClient?.enableGroupLeave !== true) {
        return { ok: false, error: '退群工具未启用。' }
    }
    if (!event?.bot) {
        return { ok: false, error: '缺少 bot 上下文，无法退出群聊。' }
    }

    const currentGroupId = event.group_id ? String(event.group_id) : ''
    const groups = (Array.isArray(record.groups) ? record.groups : [])
        .map(compactGroup)
        .filter(group => group.groupId)
        .sort((a, b) => {
            if (!currentGroupId) return 0
            if (a.groupId === currentGroupId && b.groupId !== currentGroupId) return 1
            if (b.groupId === currentGroupId && a.groupId !== currentGroupId) return -1
            return 0
        })
    if (groups.length === 0) {
        return { ok: false, error: '待确认操作里没有有效目标群。' }
    }

    const results = []
    for (const group of groups) {
        try {
            const method = await leaveGroup(event.bot, group.groupId)
            logger.warn(`[AI-Plugin] group_leave 确认后已退出群: 群=${group.groupId}(${group.groupName || '未知'}), method=${method}`)
            results.push({ ok: true, groupId: group.groupId, groupName: group.groupName || '', method })
        } catch (err) {
            logger.warn(`[AI-Plugin] group_leave 确认后退出失败: 群=${group.groupId}, ${err.message || String(err)}`)
            results.push({ ok: false, groupId: group.groupId, groupName: group.groupName || '', error: err.message || String(err) })
        }
    }

    const failed = results.filter(item => !item.ok)
    return {
        ok: failed.length === 0,
        partial: failed.length > 0 && failed.length < results.length,
        results
    }
}

export const groupLeaveTool = {
    name: 'group_leave',
    permission: 'master',
    description: '让机器人退出指定 QQ 群。仅主人可用，且必须在当前消息里明确说要退出哪个群；支持群号、唯一群名关键词或群聊中的“本群/当前群”，也支持最多 5 个明确目标。所有退群都会先创建待确认操作，主人确认后才执行。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_leave',
            description: '让机器人退出指定 QQ 群。高风险操作，只能在主人明确要求“退出/离开/退了某群”时使用。工具只创建待确认操作，确认后才会真正退出。',
            parameters: {
                type: 'object',
                properties: {
                    group_id: {
                        type: 'string',
                        description: '可选，要退出的群号。能确定群号时优先填写。'
                    },
                    group_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '可选，多个明确要退出的群号。只有用户当前消息显式列出多个群号时填写。'
                    },
                    target: {
                        type: 'string',
                        description: '可选，目标群名、群名关键词、本群/当前群，或用户原话中的群称呼。没有 group_id 时用于唯一匹配。'
                    },
                    targets: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '可选，多个明确目标群名或关键词。只有用户当前消息显式列出多个群名时填写。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!context.isMaster && !event?.isMaster) {
            return { ok: false, error: '权限不足：退群工具仅限主人使用。' }
        }
        if (global.AIPluginClient?.enableGroupLeave !== true) {
            return { ok: false, error: '退群工具未启用。请先在 models_config.yaml 设置 enable_group_leave: true，或使用 #ai开启退群。' }
        }
        if (!event?.bot) {
            return { ok: false, error: '缺少 bot 上下文，无法退出群聊。' }
        }

        const rawInstruction = context.originalUserMessage || context.userMessage || ''
        const explicitRequest = parseGroupLeaveRequest(rawInstruction)
        if (!explicitRequest) {
            logger.warn('[AI-Plugin] group_leave 已拦截：原始当前指令缺少明确退群意图或目标')
            return { ok: false, error: '为避免误退群，必须由主人在当前这条消息里明确写出“退出/离开/退了”以及目标群。开放式“全部群/所有群/不友好那些群”不会直接执行，请先明确列出群号或唯一群名。' }
        }

        const safeArgs = {}
        if (explicitRequest.group_ids) safeArgs.group_ids = explicitRequest.group_ids
        if (explicitRequest.group_id) safeArgs.group_id = explicitRequest.group_id
        if (explicitRequest.targets) safeArgs.targets = explicitRequest.targets
        if (explicitRequest.target) safeArgs.target = explicitRequest.target
        if (!safeArgs.group_id && !safeArgs.group_ids && args.group_id) safeArgs.group_id = String(args.group_id).trim()
        if (!safeArgs.target && !safeArgs.targets && (args.target || args.group_name || args.group)) safeArgs.target = args.target || args.group_name || args.group
        if (explicitRequest.forbidden_set) safeArgs.forbidden_set = true

        const targetResult = await resolveTargetGroups(safeArgs, event, { maxTargets: MAX_BATCH_TARGETS })
        if (!targetResult.ok) {
            logger.warn(`[AI-Plugin] group_leave 目标群解析失败: ${targetResult.error}`)
            return {
                ok: false,
                error: targetResult.error,
                candidates: targetResult.candidates || [],
                liveError: targetResult.liveError || ''
            }
        }

        const saveResult = await savePendingAction(event.user_id || context.userId, {
            type: 'group_leave',
            groups: targetResult.groups
        })
        if (!saveResult.ok) return { ok: false, error: saveResult.error }

        logger.warn(`[AI-Plugin] group_leave 已创建待确认操作: 群=${targetResult.groups.map(group => group.groupId).join(',')}, pending=${saveResult.record.id}`)
        return {
            ok: true,
            pending: true,
            pendingId: saveResult.record.id,
            expiresAt: saveResult.record.expiresAt,
            groups: targetResult.groups,
            confirmationHint: formatPendingActionHint()
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            const candidateText = Array.isArray(data?.candidates) && data.candidates.length > 0
                ? `\n候选群：\n${data.candidates.map(formatGroupCandidate).join('\n')}`
                : ''
            const liveError = data?.liveError ? `\n实时群列表提示：${data.liveError}` : ''
            return `\n\n【退群失败】${data?.error || '未知错误'}${candidateText}${liveError}`
        }
        if (data.pending) {
            const groupText = (data.groups || []).map(formatGroupLine).join('\n')
            return `\n\n【退群待确认】尚未退出任何群。目标群：\n${groupText}\n请在 ${formatPendingTtl(data)} 内继续回复。\n${data.confirmationHint || formatPendingActionHint()}`
        }
        if (Array.isArray(data.results)) {
            const success = data.results.filter(item => item.ok)
            const failed = data.results.filter(item => !item.ok)
            const successText = success.length ? `成功退出：\n${success.map(formatGroupLine).join('\n')}` : '成功退出：无'
            const failedText = failed.length ? `\n退出失败：\n${failed.map((item, index) => `${index + 1}. ${item.groupName ? `「${item.groupName}」` : '群名未知'}（${item.groupId}）：${item.error || '未知错误'}`).join('\n')}` : ''
            return `\n\n【退群执行完成】${data.ok ? '全部退出成功。' : (data.partial ? '部分退出成功。' : '全部退出失败。')}\n${successText}${failedText}`
        }
        const name = data.groupName ? `「${data.groupName}」` : '群名未知'
        return `\n\n【退群成功】机器人已退出 ${name}（${data.groupId}）。`
    }
}

toolRegistry.register(groupLeaveTool)
