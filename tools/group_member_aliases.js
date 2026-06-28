/**
 * 群成员称呼记忆工具
 * 查询畅聊/#c 从公开群消息中记录的“某人被怎么称呼过”。
 */

import { toolRegistry } from './registry.js'
import { formatGroupAliasRecords, rememberGroupAliasTarget } from '../utils/group_alias.js'

function normalizeLimit(limit) {
    const n = Number(limit)
    if (!Number.isFinite(n) || n <= 0) return 40
    return Math.min(Math.max(Math.floor(n), 1), 120)
}

export const groupMemberAliasesTool = {
    name: 'group_member_aliases',
    permission: 'everyone',
    description: '查询当前群里已记录的成员称呼/外号/调侃称呼。适合“这个人是谁”“@某某有什么外号”“杂鱼是谁”“谁被叫过xxx”等问题。只读取本群公开聊天里记录过的称呼，不代表真实身份。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_member_aliases',
            description: '查询当前群成员称呼/外号记忆。可按 QQ 精确查，也可按外号/称呼/来源昵称关键词模糊查。',
            parameters: {
                type: 'object',
                properties: {
                    target_user_id: {
                        type: 'string',
                        description: '可选，要查询的成员 QQ。用户 @ 了某人或明确给 QQ 时填写。'
                    },
                    query: {
                        type: 'string',
                        description: '可选，按外号、称呼、QQ、来源昵称或用户原话关键词模糊查询，例如“杂鱼”“幸福的”。'
                    },
                    limit: {
                        type: 'number',
                        description: '可选，最多返回多少条，默认 40，范围 1-120。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event?.group_id) {
            return { ok: false, error: '群成员称呼记忆只能在群聊中查询。' }
        }

        const manager = global.AIPluginConversationManager
        const db = manager?.db
        if (!db?.getGroupMemberAliases || !db?.findGroupMemberAliases) {
            return { ok: false, error: '会话数据库尚未初始化。' }
        }

        const limit = normalizeLimit(args.limit)
        const targetUserId = String(args.target_user_id || args.user_id || '').trim()
        const query = String(args.query || args.target || '').trim()
        const records = targetUserId
            ? await db.getGroupMemberAliases(event.group_id, [targetUserId], { limit })
            : await db.findGroupMemberAliases(event.group_id, query, { limit })

        if (targetUserId) {
            await rememberGroupAliasTarget(event, targetUserId, { sourceUserId: context.userId || event.user_id })
        }

        return {
            ok: true,
            groupId: String(event.group_id),
            targetUserId: targetUserId || null,
            query: query || null,
            count: records.length,
            records
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            return `\n\n【群成员称呼记忆查询失败】${data?.error || '未知错误'}`
        }
        if (!Array.isArray(data.records) || data.records.length === 0) {
            const target = data.targetUserId ? `QQ ${data.targetUserId}` : (data.query ? `关键词「${data.query}」` : '当前群')
            return `\n\n【群成员称呼记忆】没有找到 ${target} 相关的称呼记录。`
        }
        const scope = data.targetUserId ? `QQ ${data.targetUserId}` : (data.query ? `关键词「${data.query}」` : '当前群')
        return `\n\n【群成员称呼记忆】${scope} 命中 ${data.count} 条：\n${formatGroupAliasRecords(data.records).replace(/^【本群称呼记忆】\n/, '')}`
    }
}

toolRegistry.register(groupMemberAliasesTool)
