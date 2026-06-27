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

function truncateText(text, maxLength = 900) {
    const value = String(text || '').trim()
    if (value.length <= maxLength) return value
    return value.slice(0, maxLength) + '...'
}

function formatLogLine(log) {
    const name = log.isBot ? 'AI' : (log.nickname || `用户${log.userId}`)
    const imageHint = log.imageMeta?.length ? `（含 ${log.imageMeta.length} 张图片）` : ''
    return `[${log.createdAt}] ${name}(${log.userId}): ${truncateText(log.normalizedText, 700)}${imageHint}`
}

export const groupChatContextTool = {
    name: 'group_chat_context',
    permission: 'everyone',
    description: '读取畅聊模式捕获的当前群最近聊天流水。适合用户问“刚才/之前/他们/群里聊了什么”“前情提要”“总结最近群聊”等。只读取本群已捕获的公开群聊文本和图片元信息，不读取图片本体。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_chat_context',
            description: '读取当前群最近聊天流水，用于回答前情提要、最近聊了什么、群里发生了什么等问题。',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: '可选，读取最近多少条群消息，默认 40，范围 5-120。'
                    },
                    query: {
                        type: 'string',
                        description: '可选，按关键词过滤消息内容、昵称或 QQ。用户询问某个话题/某个人时填写。'
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
        const query = String(args.query || '').trim().toLowerCase()
        const logs = await manager.db.getRecentGroupMessageLogs(event.group_id, limit, { excludeCommands: true })
        const filtered = query
            ? logs.filter(log => {
                const haystack = [
                    log.normalizedText,
                    log.nickname,
                    log.userId
                ].filter(Boolean).join('\n').toLowerCase()
                return haystack.includes(query)
            })
            : logs

        return {
            ok: true,
            groupId: String(event.group_id),
            limit,
            query: query || null,
            total: logs.length,
            count: filtered.length,
            logs: filtered
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            return `\n\n【群聊上下文读取失败】${data?.error || '未知错误'}`
        }
        if (!Array.isArray(data.logs) || data.logs.length === 0) {
            const queryNote = data.query ? `，关键词「${data.query}」` : ''
            return `\n\n【群聊上下文】当前群最近 ${data.total || 0} 条记录中没有可用内容${queryNote}。`
        }
        const queryNote = data.query ? `，关键词「${data.query}」` : ''
        const lines = data.logs.map(formatLogLine)
        return `\n\n【群聊上下文】当前群最近 ${data.total} 条记录中命中 ${data.count} 条${queryNote}：\n${lines.join('\n')}`
    }
}

toolRegistry.register(groupChatContextTool)
