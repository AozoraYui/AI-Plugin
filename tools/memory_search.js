/**
 * 本地语义记忆检索工具
 * 从向量库中召回与当前问题相关的历史、总结、个人档案和畅聊流水。
 */

import { toolRegistry } from './registry.js'
import { vectorDB } from '../utils/vector_db.js'
import { formatSemanticMemoryContext, searchSemanticMemory } from '../utils/vector_memory.js'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

function normalizeLimit(value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_LIMIT
    return Math.min(Math.max(Math.floor(num), 1), MAX_LIMIT)
}

function normalizeScope(value) {
    const scope = String(value || '').trim().toLowerCase()
    if (['current_group', 'group', 'this_group'].includes(scope)) return 'current_group'
    if (['my', 'mine', 'my_memory', 'self', 'self_memory'].includes(scope)) return 'my_memory'
    if (['user', 'target_user', 'user_memory'].includes(scope)) return 'user_memory'
    if (['specific_group', 'target_group'].includes(scope)) return 'specific_group'
    if (['all', 'global', 'all_groups', 'cross_group'].includes(scope)) return 'all'
    return 'auto'
}

function getActorUserId(context = {}) {
    return String(context.userId || context.event?.user_id || '').trim()
}

function getCurrentGroupId(context = {}) {
    return context.groupId || context.event?.group_id ? String(context.groupId || context.event?.group_id).trim() : ''
}

function buildSearchOptions(args = {}, context = {}) {
    const actorUserId = getActorUserId(context)
    const currentGroupId = getCurrentGroupId(context)
    const isMaster = context.isMaster === true || context.event?.isMaster === true
    const scope = normalizeScope(args.scope)
    const options = {
        actorUserId,
        currentGroupId,
        isMaster,
        allowCrossGroup: false
    }

    const requestedUserId = String(args.user_id || '').trim()
    const requestedGroupId = String(args.group_id || '').trim()

    if (scope === 'current_group') {
        if (currentGroupId) options.groupId = currentGroupId
    } else if (scope === 'specific_group') {
        if (requestedGroupId && (isMaster || requestedGroupId === currentGroupId)) {
            options.groupId = requestedGroupId
            options.allowCrossGroup = isMaster && requestedGroupId !== currentGroupId
        } else if (currentGroupId) {
            options.groupId = currentGroupId
        }
    } else if (scope === 'my_memory') {
        if (actorUserId) options.userId = actorUserId
    } else if (scope === 'user_memory') {
        options.userId = isMaster && requestedUserId ? requestedUserId : actorUserId
        options.allowCrossGroup = isMaster && Boolean(requestedUserId)
    } else if (scope === 'all') {
        options.allowCrossGroup = isMaster
    } else {
        if (requestedUserId && isMaster) {
            options.userId = requestedUserId
            options.allowCrossGroup = true
        }
        if (requestedGroupId && (isMaster || requestedGroupId === currentGroupId)) {
            options.groupId = requestedGroupId
            options.allowCrossGroup = isMaster && requestedGroupId !== currentGroupId
        }
    }

    return { scope, options, actorUserId, currentGroupId, isMaster }
}

export const memorySearchTool = {
    name: 'memory_search',
    permission: 'everyone',
    description: '从本地向量记忆中语义检索相关历史片段、总结、个人档案和畅聊流水。普通用户只能检索自己的记忆和当前群/自己发过的公开群消息；主人可按明确要求跨群、指定群或指定用户检索。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'memory_search',
            description: '本地语义记忆检索。用于“以前说过吗/历史里找一下/相关记忆/跨群语义检索”等只读查询；不会写入档案。',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '检索问题或关键词，尽量保留用户关心的实体、主题、地点、项目名。'
                    },
                    limit: {
                        type: 'number',
                        description: '可选，返回条数，默认 8，最多 20。'
                    },
                    scope: {
                        type: 'string',
                        enum: ['auto', 'current_group', 'my_memory', 'user_memory', 'specific_group', 'all'],
                        description: '可选，检索范围。默认 auto；current_group=当前群；my_memory=触发者个人记忆；user_memory=指定用户/自己；specific_group=指定群；all=主人跨群全局。'
                    },
                    user_id: {
                        type: 'string',
                        description: '可选，指定用户 QQ。非主人会被忽略并强制为触发者自己。'
                    },
                    group_id: {
                        type: 'string',
                        description: '可选，指定群号。非主人只能指定当前群。'
                    }
                },
                required: ['query']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const query = String(args.query || '').trim()
        if (!query) return { ok: false, error: '缺少检索 query。' }
        if (!vectorDB.enabled) return { ok: false, error: '本地向量记忆未启用。' }

        const ready = await vectorDB.waitForReady(3000)
        if (!ready) {
            return {
                ok: false,
                error: vectorDB.lastError
                    ? `本地向量记忆尚未就绪：${vectorDB.lastError}`
                    : '本地向量记忆尚未就绪，请稍后再试。'
            }
        }

        const { scope, options, isMaster } = buildSearchOptions(args, context)
        if (scope === 'all' && !isMaster) {
            return { ok: false, error: '权限不足：跨群全局语义检索仅限主人使用。' }
        }

        const hits = await searchSemanticMemory(query, {
            ...options,
            limit: normalizeLimit(args.limit)
        })

        return {
            ok: true,
            query,
            scope,
            hits,
            count: hits.length
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            return `\n\n【语义记忆检索失败】${data?.error || '未知错误'}`
        }
        if (!data.hits?.length) {
            return `\n\n【语义记忆检索结果】未找到与「${data.query || ''}」明显相关的本地记忆片段。`
        }
        return `\n\n【语义记忆检索结果】query=${data.query || ''}，scope=${data.scope || 'auto'}，命中 ${data.count || data.hits.length} 条。${formatSemanticMemoryContext(data.hits, { maxChars: 12000 })}`
    }
}

toolRegistry.register(memorySearchTool)
