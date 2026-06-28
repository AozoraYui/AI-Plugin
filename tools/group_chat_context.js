/**
 * 群聊上下文工具
 * 读取畅聊模式捕获的群消息流水，供普通 #c 和畅聊工具链查询最近群聊前情。
 */

import { toolRegistry } from './registry.js'

function normalizeLimit(limit) {
    const n = Number(limit)
    if (!Number.isFinite(n) || n <= 0) return 40
    return Math.min(Math.max(Math.floor(n), 5), 120)
}

function normalizeScope(scope) {
    const value = String(scope || '').trim().toLowerCase()
    if (['my', 'mine', 'my_messages', 'my_recent', 'my_recent_messages', 'self'].includes(value)) return 'my_recent_messages'
    if (['other', 'other_groups', 'other_group_messages', 'cross_group_mine'].includes(value)) return 'other_group_messages'
    if (['all', 'all_groups', 'accessible', 'accessible_groups', 'cross_group', 'global'].includes(value)) return 'all_groups'
    if (['group', 'specific_group'].includes(value)) return 'specific_group'
    return 'current_group'
}

function normalizeBool(value) {
    if (value === true || value === false) return value
    if (typeof value === 'string') return /^(true|yes|1|on)$/i.test(value)
    return false
}

function truncateText(text, maxLength = 900) {
    const value = String(text || '').trim()
    if (value.length <= maxLength) return value
    return value.slice(0, maxLength) + '...'
}

function formatLogLine(log, options = {}) {
    const name = log.isBot ? 'AI' : (log.nickname || `用户${log.userId}`)
    const imageHint = log.imageMeta?.length ? `（含 ${log.imageMeta.length} 张图片）` : ''
    const groupHint = options.showGroupId ? `群${log.groupId} ` : ''
    return `[${log.createdAt}] ${groupHint}${name}(${log.userId}): ${truncateText(log.normalizedText, 700)}${imageHint}`
}

function getActorUserId(context = {}, event = {}) {
    return String(context.userId || event.user_id || '').trim()
}

function isMasterContext(context = {}, event = {}) {
    return context.isMaster === true || event.isMaster === true
}

export const groupChatContextTool = {
    name: 'group_chat_context',
    permission: 'everyone',
    description: '读取畅聊模式捕获的群消息流水。默认只读取当前群；用户问“我在别的群刚说了什么/你看到我其他群的消息吗”时可用 scope=my_recent_messages 或 other_group_messages 只查该用户自己的跨群消息；只有主人可用 scope=all_groups 或指定其他 group_id 查询所有已捕获群。只读取文本和图片元信息，不读取图片本体。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_chat_context',
            description: '读取畅聊模式捕获的群聊流水。默认当前群；可安全查询当前用户自己的跨群消息；主人可跨群查询全部已捕获公开流水。',
            parameters: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'string',
                        enum: ['current_group', 'my_recent_messages', 'other_group_messages', 'all_groups', 'specific_group'],
                        description: '查询范围。默认 current_group；用户问自己在别的群发过什么用 my_recent_messages，明确“别的群/其他群”可用 other_group_messages；all_groups 和 specific_group 仅主人可跨群使用。'
                    },
                    limit: {
                        type: 'number',
                        description: '可选，读取最近多少条群消息，默认 40，范围 5-120。'
                    },
                    query: {
                        type: 'string',
                        description: '可选，按关键词过滤消息内容、昵称、QQ 或群号。用户询问某个话题/某个人时填写。'
                    },
                    group_id: {
                        type: 'string',
                        description: '可选，指定群号。只能指定当前群；主人可指定其他已捕获群。'
                    },
                    user_id: {
                        type: 'string',
                        description: '可选，指定用户 QQ。非主人会被强制改为当前触发用户；主人可用于跨群查询某个用户。'
                    },
                    exclude_current_group: {
                        type: 'boolean',
                        description: '可选，查询自己的跨群消息时是否排除当前群；用户说“别的群/其他群”时设为 true。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event?.group_id) {
            return { ok: false, error: '群聊上下文工具仅能在群聊中使用。' }
        }
        const manager = global.AIPluginConversationManager
        if (!manager?.db?.getRecentGroupMessageLogs) {
            return { ok: false, error: '会话数据库尚未初始化。' }
        }

        const limit = normalizeLimit(args.limit)
        const query = String(args.query || '').trim()
        const currentGroupId = String(event.group_id)
        const actorUserId = getActorUserId(context, event)
        const isMaster = isMasterContext(context, event)
        const requestedGroupId = args.group_id ? String(args.group_id).trim() : ''
        const requestedUserId = args.user_id ? String(args.user_id).trim() : ''
        let scope = normalizeScope(args.scope)
        const db = manager.db

        if (requestedGroupId) scope = requestedGroupId === currentGroupId ? 'current_group' : 'specific_group'
        if (scope === 'specific_group' && !requestedGroupId) scope = 'current_group'

        let logs = []
        let effectiveGroupId = ''
        let effectiveUserId = ''
        let excludeCurrentGroup = false
        let privacyNote = ''

        if (scope === 'current_group') {
            effectiveGroupId = requestedGroupId || currentGroupId
            if (effectiveGroupId !== currentGroupId && !isMaster) {
                logger.warn(`[AI-Plugin] group_chat_context 拦截非主人跨群指定群: 当前群=${currentGroupId}, 请求群=${effectiveGroupId}, 用户=${actorUserId}`)
                return { ok: false, error: '权限不足：非主人只能读取当前群流水，或查询自己在其他群的消息。' }
            }
            logs = db.getGroupMessageLogs
                ? await db.getGroupMessageLogs({ groupId: effectiveGroupId, limit, query, excludeCommands: true })
                : await db.getRecentGroupMessageLogs(effectiveGroupId, limit, { excludeCommands: true })
        } else if (scope === 'my_recent_messages' || scope === 'other_group_messages') {
            effectiveUserId = isMaster && requestedUserId ? requestedUserId : actorUserId
            excludeCurrentGroup = scope === 'other_group_messages' || normalizeBool(args.exclude_current_group)
            if (!effectiveUserId) return { ok: false, error: '无法识别当前用户，不能执行跨群个人消息查询。' }
            if (!isMaster && requestedUserId && requestedUserId !== actorUserId) {
                logger.warn(`[AI-Plugin] group_chat_context 已忽略非主人指定的 user_id=${requestedUserId}，改查触发者 ${actorUserId}`)
                privacyNote = '非主人跨群查询只能查看自己的消息，已忽略模型传入的其他 user_id。'
            }
            if (!db.getGroupMessageLogs) {
                logs = await db.getRecentGroupMessageLogs(currentGroupId, limit, { excludeCommands: true })
                logs = logs.filter(log => log.userId === effectiveUserId)
            } else {
                logs = await db.getGroupMessageLogs({
                    userId: effectiveUserId,
                    excludeGroupId: excludeCurrentGroup ? currentGroupId : '',
                    limit,
                    query,
                    excludeCommands: true
                })
            }
        } else if (scope === 'all_groups') {
            if (!isMaster) {
                logger.warn(`[AI-Plugin] group_chat_context 拦截非主人 all_groups 查询: 用户=${actorUserId}, 当前群=${currentGroupId}`)
                return { ok: false, error: '权限不足：只有主人可以跨群读取所有已捕获群流水。普通用户只能查询自己在其他群的消息。' }
            }
            effectiveUserId = requestedUserId
            logs = await db.getGroupMessageLogs({
                userId: effectiveUserId || '',
                limit,
                query,
                excludeCommands: true
            })
        } else if (scope === 'specific_group') {
            if (!isMaster) {
                logger.warn(`[AI-Plugin] group_chat_context 拦截非主人 specific_group 查询: 请求群=${requestedGroupId}, 用户=${actorUserId}`)
                return { ok: false, error: '权限不足：只有主人可以指定其他群读取流水。' }
            }
            effectiveGroupId = requestedGroupId
            effectiveUserId = requestedUserId
            logs = await db.getGroupMessageLogs({
                groupId: effectiveGroupId,
                userId: effectiveUserId || '',
                limit,
                query,
                excludeCommands: true
            })
        }

        const groupCount = new Set(logs.map(log => log.groupId)).size
        const showGroupId = scope !== 'current_group' || groupCount > 1
        logger.info(`[AI-Plugin] group_chat_context 完成: scope=${scope}, 当前群=${currentGroupId}, 群数=${groupCount}, 条数=${logs.length}, 查询用户=${effectiveUserId || '不限'}, query=${query || '无'}`)

        return {
            ok: true,
            scope,
            currentGroupId,
            groupId: effectiveGroupId || null,
            userId: effectiveUserId || null,
            excludeCurrentGroup,
            query: query || null,
            limit,
            count: logs.length,
            groupCount,
            showGroupId,
            privacyNote,
            logs
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            return `\n\n【群聊上下文读取失败】${data?.error || '未知错误'}`
        }

        const scopeNames = {
            current_group: '当前群',
            my_recent_messages: data.excludeCurrentGroup ? '触发者其他群消息' : '触发者跨群消息',
            other_group_messages: '触发者其他群消息',
            all_groups: data.userId ? `跨群用户 ${data.userId}` : '全部已捕获群',
            specific_group: `指定群 ${data.groupId}`
        }
        const scopeName = scopeNames[data.scope] || data.scope || '群聊上下文'
        const queryNote = data.query ? `，关键词「${data.query}」` : ''
        const privacyNote = data.privacyNote ? `\n提示：${data.privacyNote}` : ''

        if (!Array.isArray(data.logs) || data.logs.length === 0) {
            return `\n\n【群聊上下文】${scopeName}最近没有可用记录${queryNote}。${privacyNote}`
        }

        const lines = data.logs.map(log => formatLogLine(log, { showGroupId: data.showGroupId }))
        const groupNote = data.groupCount > 1 ? `，覆盖 ${data.groupCount} 个群` : ''
        return `\n\n【群聊上下文】${scopeName}最近命中 ${data.count} 条${groupNote}${queryNote}：${privacyNote}\n${lines.join('\n')}`
    }
}

toolRegistry.register(groupChatContextTool)
