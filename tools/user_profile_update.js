/**
 * 用户个人档案维护工具
 * 按用户明确指令，把稳定偏好/长期背景从当前补充或最近历史中提炼并写入 user_profiles。
 */

import { toolRegistry } from './registry.js'
import { updateUserProfileFromSummary } from '../utils/user_profile.js'
import { getTodayDateStr } from '../utils/common.js'

const DEFAULT_HISTORY_TURNS = 12
const MAX_HISTORY_TURNS = 30
const SOURCE_TEXT_MAX_CHARS = 12000

function normalizeLimit(value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_HISTORY_TURNS
    return Math.min(Math.max(Math.floor(num), 1), MAX_HISTORY_TURNS)
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
    const value = String(text || '')
    return /(?:从|根据).{0,20}(?:刚才|上面|前面|最近|历史|聊天|对话|上下文).{0,30}(?:提炼|抽取|整理|总结|更新|维护|记住|记一下|记下来)/i.test(value)
        || /(?:提炼|抽取|整理|总结|更新|维护|记住|记一下|记下来).{0,20}(?:刚才|上面|前面|最近|历史|聊天|对话|上下文).{0,20}(?:档案|画像|长期记忆|稳定信息|长期信息)/i.test(value)
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

function buildSourceText({ sourceText, historyText, groupSelfLogText, memorySummary, mode }) {
    const blocks = []
    if (sourceText) {
        blocks.push(`【用户本轮明确补充】\n${truncateText(sourceText)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && historyText) {
        blocks.push(`【最近对话历史】\n${truncateText(historyText, 18000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && groupSelfLogText) {
        blocks.push(`【当前群中该用户自己的最近公开消息】\n${truncateText(groupSelfLogText, 12000)}`)
    }
    if ((mode === 'history' || mode === 'mixed') && memorySummary) {
        blocks.push(`【已有长期记忆摘要】\n${truncateText(memorySummary, 12000)}`)
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
                        description: '可选，提炼最近多少轮普通对话历史，默认 12，最多 30。仅 mode=history/mixed 时生效。'
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
        let mode = ['source_text', 'history', 'mixed'].includes(modeValue)
            ? modeValue
            : 'source_text'
        if (!sourceText && mode !== 'history') {
            return { ok: false, error: '请明确要写入个人档案的内容，或明确说明“从最近聊天/历史上下文提炼”。' }
        }
        if (!sourceText && mode === 'history' && !hasHistoryExtractionIntent(context.userMessage || context.originalUserMessage || '')) {
            return { ok: false, error: '未检测到明确的历史提炼指令；请说“从刚才聊天/最近历史提炼我的档案”。' }
        }
        if (sourceText && mode === 'mixed' && !hasHistoryExtractionIntent(context.userMessage || context.originalUserMessage || '')) {
            mode = 'source_text'
        }
        const historyTurns = normalizeLimit(args.history_turns)
        let historyText = ''
        let groupSelfLogText = ''
        let memorySummary = ''
        if (mode === 'history' || mode === 'mixed') {
            const memoryData = await manager.getUserHistoryWithCheckpoint(targetUserId)
            historyText = buildHistoryText(memoryData?.history || [], historyTurns)
            memorySummary = truncateText(memoryData?.incrementalCheckpoint || '', 12000)
            groupSelfLogText = await buildGroupSelfLogText(manager.db, context.groupId || context.event?.group_id, targetUserId, historyTurns)
        }

        const combinedSource = buildSourceText({ sourceText, historyText, groupSelfLogText, memorySummary, mode })
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
            historyTurns: (mode === 'history' || mode === 'mixed') ? historyTurns : 0,
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
        return `\n\n【个人档案更新完成】已根据${source}维护用户 ${data.userId} 的个人档案。旧档案${data.oldProfileExists ? `约 ${data.oldLength} 字` : '为空'}，更新后约 ${data.newLength} 字。请只简短告知用户已更新，不要在公开群里复述档案全文。`
    }
}

toolRegistry.register(userProfileUpdateTool)
