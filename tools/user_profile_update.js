/**
 * 用户个人档案维护工具
 * 按用户明确指令，把稳定偏好/长期背景从当前补充或最近历史中提炼并写入 user_profiles。
 */

import { toolRegistry } from './registry.js'
import { updateUserProfileFromSummary } from '../utils/user_profile.js'
import { getTodayDateStr } from '../utils/common.js'
import { hasExplicitUserProfileHistoryExtractionIntent } from '../utils/tool_intent.js'

const DEFAULT_HISTORY_TURNS = 30
const MAX_HISTORY_TURNS = 120
const DEFAULT_GROUP_LOG_LIMIT = 120
const MAX_GROUP_LOG_LIMIT = 300
const SOURCE_TEXT_MAX_CHARS = 36000

function normalizeLimit(value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_HISTORY_TURNS
    return Math.min(Math.max(Math.floor(num), 1), MAX_HISTORY_TURNS)
}

function normalizeGroupLogLimit(value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_GROUP_LOG_LIMIT
    return Math.min(Math.max(Math.floor(num), 1), MAX_GROUP_LOG_LIMIT)
}

function truncateText(value, maxChars = SOURCE_TEXT_MAX_CHARS) {
    const text = String(value || '').trim()
    if (text.length <= maxChars) return text
    return text.slice(0, maxChars) + '\n[内容过长，后续已截断]'
}

function formatHistoryTurn(turn) {
    const role = turn?.role === 'model' ? 'AI' : '用户'
    const parts = Array.isArray(turn?.parts) ? turn.parts : []
    const text = parts
        .map(part => part?.text ? String(part.text).trim() : '')
        .filter(Boolean)
        .join('\n')
    if (!text) return ''
    return `${role}: ${truncateText(text, 1200)}`
}

function buildHistoryText(history = [], limit = DEFAULT_HISTORY_TURNS) {
    const turns = Array.isArray(history) ? history.slice(-limit) : []
    return turns.map(formatHistoryTurn).filter(Boolean).join('\n\n')
}

function hasHistoryExtractionIntent(text = '') {
    return hasExplicitUserProfileHistoryExtractionIntent(text)
}

function normalizeSources(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[,\s，、|/]+/)
    return [...new Set(raw.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))]
}

function includesAny(text = '', patterns = []) {
    return patterns.some(pattern => pattern.test(text))
}

function inferSourceOptions(args = {}, instruction = '', event = {}) {
    const value = String(instruction || '')
    const scope = String(args.source_scope || args.scope || '').trim().toLowerCase()
    const sources = normalizeSources(args.sources || args.data_sources || scope)
    const comprehensive = includesAny(value, [/全面|完整|通读|尽量|整个|全量|全部(?:对话|聊天|记录|历史)|所有(?:对话|聊天|记录|历史)/i])
    const wantsConversation = sources.includes('conversation')
        || sources.includes('chat_history')
        || sources.includes('history')
        || /(?:我们|咱们|我和你|你和我).{0,12}(?:对话|聊天|记录)|(?:对话|聊天).{0,12}(?:历史|记录)|普通对话|私聊|和你的对话/i.test(value)
    const wantsMemory = sources.includes('memory')
        || sources.includes('summary')
        || /(?:记忆|长期记忆|摘要|总结|锚点|旧档案|已有档案)/i.test(value)
    const wantsCurrentGroup = sources.includes('current_group')
        || sources.includes('group')
        || /(?:本群|当前群|这个群|群里|群聊).{0,24}(?:我|我的|档案|画像|发言|聊天|记录|大家)|(?:从|根据).{0,12}(?:本群|当前群|这个群|群聊)/i.test(value)
    const wantsAllMyGroups = sources.includes('all_my_groups')
        || sources.includes('my_group_messages')
        || sources.includes('cross_group')
        || /(?:所有群|全部群|各群|跨群|别的群|其他群|其它群|我在群里|我的群聊).{0,30}(?:我|我的|发言|说过|聊过|消息|记录|档案|画像)|(?:我|我的).{0,24}(?:所有群|全部群|各群|跨群|别的群|其他群|其它群).{0,24}(?:发言|消息|记录|聊天)/i.test(value)
    const wantsCurrentGroupContext = sources.includes('current_group_context')
        || /(?:当前群|本群|这个群|群里|群聊).{0,24}(?:大家|别人|其他人|上下文|前情|聊天记录).{0,24}(?:我|我的|档案|画像|印象)?/i.test(value)
    const wantsAllGroupContext = sources.includes('all_group_context')
        || /(?:所有群|全部群|跨群|各群).{0,24}(?:大家|别人|其他人|上下文|前情|聊天记录).{0,24}(?:我|我的|档案|画像|印象)?/i.test(value)

    const anyExplicitSource = wantsConversation || wantsMemory || wantsCurrentGroup || wantsAllMyGroups || wantsCurrentGroupContext || wantsAllGroupContext
    return {
        comprehensive,
        includeConversation: !anyExplicitSource || wantsConversation || comprehensive,
        includeMemory: !anyExplicitSource || wantsMemory || wantsConversation || comprehensive,
        includeCurrentGroupSelf: wantsCurrentGroup || (event?.group_id && !anyExplicitSource),
        includeAllGroupSelf: wantsAllMyGroups || comprehensive,
        includeCurrentGroupContext: wantsCurrentGroupContext,
        includeAllGroupContext: wantsAllGroupContext,
        reason: sources.length > 0 ? `sources=${sources.join(',')}` : 'natural_language'
    }
}

function formatGroupLog(log) {
    const name = log?.nickname || `用户${log?.userId || ''}`
    const imageHint = log?.imageMeta?.length ? `（含 ${log.imageMeta.length} 张图片，仅元信息）` : ''
    return `[${log?.createdAt || ''}] ${name}(${log?.userId || ''}): ${truncateText(log?.normalizedText || '', 900)}${imageHint}`
}

async function buildGroupSelfLogText(db, groupId, userId, limit) {
    if (!groupId || !userId || !db?.getGroupMessageLogs) return ''
    const logs = await db.getGroupMessageLogs({
        groupId,
        userId,
        limit
    })
    return Array.isArray(logs) ? logs.map(formatGroupLog).filter(Boolean).join('\n') : ''
}

async function buildAllGroupSelfLogText(db, userId, limit) {
    if (!userId || !db?.getGroupMessageLogs) return ''
    const logs = await db.getGroupMessageLogs({ userId, limit })
    return Array.isArray(logs) ? logs.map(formatGroupLog).filter(Boolean).join('\n') : ''
}

async function buildGroupContextLogText(db, options = {}) {
    if (!db?.getGroupMessageLogs) return ''
    const logs = await db.getGroupMessageLogs(options)
    return Array.isArray(logs) ? logs.map(formatGroupLog).filter(Boolean).join('\n') : ''
}

function buildSourceText({ sourceText, historyText, currentGroupSelfLogText, allGroupSelfLogText, currentGroupContextText, allGroupContextText, memorySummary, mode }) {
    const blocks = []
    if (sourceText) {
        blocks.push(`【用户本轮明确补充】\n${truncateText(sourceText)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && historyText) {
        blocks.push(`【普通对话历史】\n${truncateText(historyText, 36000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && currentGroupSelfLogText) {
        blocks.push(`【当前群中该用户自己的公开消息】\n${truncateText(currentGroupSelfLogText, 24000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && allGroupSelfLogText) {
        blocks.push(`【所有已捕获群中该用户自己的公开消息】\n${truncateText(allGroupSelfLogText, 36000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && currentGroupContextText) {
        blocks.push(`【当前群公开上下文】\n${truncateText(currentGroupContextText, 24000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && allGroupContextText) {
        blocks.push(`【所有已捕获群公开上下文】\n${truncateText(allGroupContextText, 36000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && memorySummary) {
        blocks.push(`【已有长期记忆摘要】\n${truncateText(memorySummary, 24000)}`)
    }
    return blocks.join('\n\n')
}

export const userProfileUpdateTool = {
    name: 'user_profile_update',
    permission: 'everyone',
    description: '在用户明确要求时，提炼当前补充或最近历史上下文中的长期稳定信息，并合并写入该用户的个人档案 user_profiles。默认只能更新触发者自己的档案；主人可指定 user_id。适合“记到我的个人档案”“从刚才聊天提炼我的档案”“更新我的用户画像”。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'user_profile_update',
            description: '按用户明确指令维护个人档案。只记录长期稳定信息，不记录一次性任务、临时命令、短期情绪或群内未经确认的玩笑。',
            parameters: {
                type: 'object',
                properties: {
                    source_text: {
                        type: 'string',
                        description: '可选，用户明确要求写入/提炼的文本内容。例如“我更喜欢被叫由依，不喜欢被叫主人”。'
                    },
                    mode: {
                        type: 'string',
                        enum: ['source_text', 'history', 'mixed'],
                        description: '可选，source_text 表示只根据 source_text 更新；history 表示从最近对话/记忆提炼；mixed 表示二者结合。提供 source_text 时默认 source_text；未提供 source_text 时必须明确使用 history。'
                    },
                    history_turns: {
                        type: 'number',
                        description: '可选，提炼最近多少轮普通对话历史，默认 30，最多 120。仅 mode=history/mixed 时生效。'
                    },
                    sources: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enum: ['conversation', 'memory', 'current_group', 'all_my_groups', 'current_group_context', 'all_group_context']
                        },
                        description: '可选，数据来源。conversation=普通对话历史，memory=已有记忆摘要，current_group=当前群中该用户自己的消息，all_my_groups=所有已捕获群中该用户自己的消息，current_group_context=当前群公开上下文，all_group_context=所有已捕获群公开上下文。未填时根据用户自然语言自动推断。'
                    },
                    source_scope: {
                        type: 'string',
                        description: '可选，自然语言数据来源说明，例如“全面读我们的对话”“从所有群我的发言”“结合当前群上下文”。工具会解析为 sources。'
                    },
                    group_log_limit: {
                        type: 'number',
                        description: '可选，读取群消息流水条数，默认 120，最多 300。'
                    },
                    user_id: {
                        type: 'string',
                        description: '可选，要更新的用户 QQ。非主人会被强制改为触发者自己；主人可指定。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const manager = global.AIPluginConversationManager
        const client = global.AIPluginClient
        const actorUserId = String(context.userId || context.event?.user_id || '').trim()
        const requestedUserId = String(args.user_id || '').trim()
        const targetUserId = context.isMaster === true && requestedUserId ? requestedUserId : actorUserId
        if (!targetUserId) return { ok: false, error: '无法识别要更新档案的用户。' }
        if (requestedUserId && requestedUserId !== actorUserId && context.isMaster !== true) {
            return { ok: false, error: '权限不足：只能更新自己的个人档案。' }
        }
        if (!manager?.getUserHistoryWithCheckpoint || !manager?.db || !client?.makeRequest) {
            return { ok: false, error: '会话数据库或 AI 客户端尚未初始化。' }
        }

        const sourceText = truncateText(args.source_text || args.text || '')
        const modeValue = String(args.mode || '').trim().toLowerCase()
        const rawInstruction = context.userMessage || context.originalUserMessage || ''
        const hasSourceSelector = normalizeSources(args.sources || args.data_sources || args.source_scope || args.scope).length > 0
        const hasHistoryIntent = hasHistoryExtractionIntent(rawInstruction)
        let mode = ['source_text', 'history', 'mixed'].includes(modeValue)
            ? modeValue
            : 'source_text'
        if (!sourceText && mode === 'source_text' && (hasHistoryIntent || hasSourceSelector)) {
            mode = 'history'
        }
        if (sourceText && mode === 'source_text' && hasSourceSelector) {
            mode = 'mixed'
        }
        if (!sourceText && mode !== 'history') {
            return { ok: false, error: '请明确要写入个人档案的内容，或明确说明“从最近聊天/历史上下文提炼”。' }
        }
        if (!sourceText && mode === 'history' && !hasHistoryIntent && !hasSourceSelector) {
            return { ok: false, error: '未检测到明确的历史提炼指令；请说“从刚才聊天/最近历史提炼我的档案”。' }
        }
        if (sourceText && mode === 'mixed' && !hasHistoryIntent && !hasSourceSelector) {
            mode = 'source_text'
        }
        const historyTurns = normalizeLimit(args.history_turns)
        const groupLogLimit = normalizeGroupLogLimit(args.group_log_limit || args.log_limit)
        const sourceOptions = inferSourceOptions(args, rawInstruction, context.event)
        const effectiveHistoryTurns = sourceOptions.comprehensive && !args.history_turns ? MAX_HISTORY_TURNS : historyTurns
        const effectiveGroupLogLimit = sourceOptions.comprehensive && !args.group_log_limit && !args.log_limit ? MAX_GROUP_LOG_LIMIT : groupLogLimit
        let historyText = ''
        let currentGroupSelfLogText = ''
        let allGroupSelfLogText = ''
        let currentGroupContextText = ''
        let allGroupContextText = ''
        let memorySummary = ''
        if (mode === 'history' || mode === 'mixed') {
            const memoryData = await manager.getUserHistoryWithCheckpoint(targetUserId)
            if (sourceOptions.includeConversation) {
                historyText = buildHistoryText(memoryData?.history || [], effectiveHistoryTurns)
            }
            if (sourceOptions.includeMemory) {
                memorySummary = truncateText(memoryData?.incrementalCheckpoint || '', 24000)
            }
            if (sourceOptions.includeCurrentGroupSelf) {
                currentGroupSelfLogText = await buildGroupSelfLogText(manager.db, context.groupId || context.event?.group_id, targetUserId, effectiveGroupLogLimit)
            }
            if (sourceOptions.includeAllGroupSelf) {
                allGroupSelfLogText = await buildAllGroupSelfLogText(manager.db, targetUserId, effectiveGroupLogLimit)
            }
            const currentGroupId = context.groupId || context.event?.group_id
            if (sourceOptions.includeCurrentGroupContext && currentGroupId) {
                currentGroupContextText = await buildGroupContextLogText(manager.db, {
                    groupId: currentGroupId,
                    limit: effectiveGroupLogLimit
                })
            }
            if (sourceOptions.includeAllGroupContext && context.isMaster === true) {
                allGroupContextText = await buildGroupContextLogText(manager.db, { limit: effectiveGroupLogLimit })
            }
        }

        const combinedSource = buildSourceText({
            sourceText,
            historyText,
            currentGroupSelfLogText,
            allGroupSelfLogText,
            currentGroupContextText,
            allGroupContextText,
            memorySummary,
            mode
        })
        if (!combinedSource) {
            return { ok: false, error: '没有可用于更新个人档案的文本；请明确说明要记住的内容，或要求从最近聊天历史提炼。' }
        }

        const result = await updateUserProfileFromSummary(manager.db, client, targetUserId, combinedSource, {
            summaryType: mode === 'source_text' ? 'manual' : 'history',
            dateStr: getTodayDateStr(),
            modelGroupKey: 'flash'
        })
        if (!result.ok) {
            return { ok: false, error: result.reason || '个人档案更新失败。' }
        }
        return {
            ok: true,
            userId: targetUserId,
            mode,
            historyTurns: (mode === 'history' || mode === 'mixed') ? effectiveHistoryTurns : 0,
            groupLogLimit: (mode === 'history' || mode === 'mixed') ? effectiveGroupLogLimit : 0,
            sourceReason: sourceOptions.reason,
            sources: {
                conversation: Boolean(historyText),
                memory: Boolean(memorySummary),
                currentGroupSelf: Boolean(currentGroupSelfLogText),
                allGroupSelf: Boolean(allGroupSelfLogText),
                currentGroupContext: Boolean(currentGroupContextText),
                allGroupContext: Boolean(allGroupContextText)
            },
            oldProfileExists: result.oldProfileExists,
            oldLength: result.oldLength || 0,
            newLength: result.length || 0
        }
    },

    formatResult(data) {
        if (!data || data.ok === false) {
            return `\n\n【个人档案更新失败】${data?.error || '未知错误'}`
        }
        const source = data.mode === 'source_text'
            ? '本轮明确补充'
            : (data.mode === 'history' ? `最近 ${data.historyTurns} 轮历史` : `本轮补充 + 最近 ${data.historyTurns} 轮历史`)
        const sourceNames = []
        if (data.sources?.conversation) sourceNames.push('普通对话')
        if (data.sources?.memory) sourceNames.push('长期记忆摘要')
        if (data.sources?.currentGroupSelf) sourceNames.push('当前群本人发言')
        if (data.sources?.allGroupSelf) sourceNames.push('跨群本人发言')
        if (data.sources?.currentGroupContext) sourceNames.push('当前群公开上下文')
        if (data.sources?.allGroupContext) sourceNames.push('全局公开群上下文')
        const sourceDetail = sourceNames.length ? `；实际来源：${sourceNames.join('、')}` : ''
        return `\n\n【个人档案更新完成】已根据${source}维护用户 ${data.userId} 的个人档案${sourceDetail}。旧档案${data.oldProfileExists ? `约 ${data.oldLength} 字` : '为空'}，更新后约 ${data.newLength} 字。请只简短告知用户已更新，不要在公开群里复述档案全文。`
    }
}

toolRegistry.register(userProfileUpdateTool)
