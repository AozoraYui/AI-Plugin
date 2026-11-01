/**
 * QQ 用户来源与关系检索工具。
 * 只允许主人使用：实时枚举机器人所在群，查询目标 QQ 是否为群成员，
 * 并结合本地群聊、好友私聊和群临时会话流水给出覆盖范围明确的结果。
 */

import { toolRegistry } from './registry.js'
import { formatDBTimestampToBeijing } from '../utils/common.js'

const DEFAULT_LIMIT = 60
const MAX_LIMIT = 300
const DEFAULT_MAX_GROUPS = 500
const MAX_GROUPS = 1000
const MEMBER_QUERY_CONCURRENCY = 4
const MEMBER_QUERY_MAX_ATTEMPTS = 2
const MEMBER_QUERY_RETRY_DELAY_MS = 180

function normalizeUserId(value) {
    const userId = String(value || '').trim()
    return /^\d{5,15}$/.test(userId) ? userId : ''
}

function normalizeLimit(value) {
    const limit = Number(value)
    if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
    return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT)
}

function normalizeOffset(value) {
    const offset = Number(value)
    if (!Number.isFinite(offset) || offset < 0) return 0
    return Math.floor(offset)
}

function normalizeMaxGroups(value) {
    const maxGroups = Number(value)
    if (!Number.isFinite(maxGroups) || maxGroups <= 0) return DEFAULT_MAX_GROUPS
    return Math.min(Math.max(Math.floor(maxGroups), 1), MAX_GROUPS)
}

function unwrapApiData(response) {
    if (response && Object.prototype.hasOwnProperty.call(response, 'data')) return response.data
    return response
}

function normalizeGroup(group = {}) {
    const groupId = group.group_id ?? group.groupId ?? group.id
    if (!groupId) return null
    return {
        groupId: String(groupId),
        groupName: String(group.group_name || group.groupName || group.name || '').trim(),
        memberCount: group.member_count ?? group.memberCount ?? null
    }
}

class BotApiError extends Error {
    constructor(message, details = {}) {
        super(message)
        this.name = 'BotApiError'
        this.action = details.action || ''
        this.retcode = details.retcode
        this.cause = details.cause
    }
}

function errorText(error) {
    return String(error?.message || error?.wording || error || '').trim()
}

async function callBotApi(bot, action, params = {}) {
    if (!bot?.sendApi) throw new BotApiError('当前适配器没有 sendApi 接口', { action })
    let response
    try {
        response = await bot.sendApi(action, params)
    } catch (error) {
        if (error instanceof BotApiError) throw error
        throw new BotApiError(errorText(error) || '调用 OneBot API 失败', { action, cause: error })
    }
    if (response?.retcode !== undefined && Number(response.retcode) !== 0) {
        throw new BotApiError(String(response.message || response.wording || `retcode=${response.retcode}`), {
            action,
            retcode: Number(response.retcode)
        })
    }
    const data = unwrapApiData(response)
    if (data?.retcode !== undefined && Number(data.retcode) !== 0) {
        throw new BotApiError(String(data.message || data.wording || `retcode=${data.retcode}`), {
            action,
            retcode: Number(data.retcode)
        })
    }
    return data
}

function extractGroupList(data) {
    if (Array.isArray(data)) return data
    for (const key of ['groups', 'group_list', 'groupList']) {
        if (Array.isArray(data?.[key])) return data[key]
    }
    return []
}

async function callBotApiWithRetry(bot, action, params = {}) {
    let lastError = null
    for (let attempt = 1; attempt <= MEMBER_QUERY_MAX_ATTEMPTS; attempt++) {
        try {
            return await callBotApi(bot, action, params)
        } catch (error) {
            lastError = error
            if (!isTransientBotApiError(error) || attempt >= MEMBER_QUERY_MAX_ATTEMPTS) break
            await wait(MEMBER_QUERY_RETRY_DELAY_MS * attempt)
        }
    }
    throw lastError || new BotApiError(`${action} 调用失败`, { action })
}

async function fetchLiveGroups(event) {
    try {
        const data = await callBotApiWithRetry(event?.bot, 'get_group_list')
        const groups = extractGroupList(data)
            .map(normalizeGroup)
            .filter(Boolean)
        return { groups, error: '' }
    } catch (error) {
        return { groups: [], error: error.message || String(error) }
    }
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = []
    let nextIndex = 0
    const runWorker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++
            try {
                results[index] = await worker(items[index], index)
            } catch (error) {
                results[index] = { kind: 'api_error', error: errorText(error) || '未知错误' }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()))
    return results
}

function isMemberNotFoundError(error) {
    const text = errorText(error)
    return /(?:not\s+(?:a\s+)?member|not\s+in\s+(?:the\s+)?group|member\s+(?:not\s+found|does\s+not\s+exist)|user\s+(?:not\s+found|does\s+not\s+exist)|(?:群成员|成员|用户).{0,8}(?:不存在|未找到|不在群)|不在(?:该|本|这个)?群)/i.test(text)
}

function isTransientBotApiError(error) {
    const text = errorText(error)
    return /(?:timeout|timed\s+out|超时|socket|econn|eai_again|network|网络|连接|websocket|未连接|断开|temporar(?:y|ily)|busy|rate\s*limit|too\s+many|429|服务不可用|请稍后|重试)/i.test(text)
}

function extractMemberList(data) {
    if (Array.isArray(data)) return data
    for (const key of ['members', 'member_list', 'memberList']) {
        if (Array.isArray(data?.[key])) return data[key]
    }
    return []
}

function normalizeMatchedMember(member, userId) {
    const memberData = member && typeof member === 'object' ? member : {}
    const memberId = String(memberData.user_id ?? memberData.userId ?? '')
    if (memberId !== userId) return null
    return memberData
}

function buildMatchedGroup(group, memberData) {
    return {
        ...group,
        nickname: memberData.nickname || '',
        card: memberData.card || '',
        role: memberData.role || '',
        joinTime: memberData.join_time || memberData.joinTime || null
    }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function findMemberFromList(event, group, userId) {
    const data = await callBotApi(event?.bot, 'get_group_member_list', {
        group_id: Number(group.groupId),
        no_cache: false
    })
    const member = extractMemberList(data)
        .map(item => normalizeMatchedMember(item, userId))
        .find(Boolean)
    return member || null
}

async function queryGroupMember(event, group, userId) {
    let lastError = null
    for (let attempt = 1; attempt <= MEMBER_QUERY_MAX_ATTEMPTS; attempt++) {
        try {
            const member = await callBotApi(event?.bot, 'get_group_member_info', {
                group_id: Number(group.groupId),
                user_id: Number(userId),
                no_cache: false
            })
            const memberData = normalizeMatchedMember(member, userId)
            if (!memberData) {
                lastError = new BotApiError('成员信息接口返回了无法识别的成员数据', { action: 'get_group_member_info' })
                break
            }
            return { kind: 'matched', group: buildMatchedGroup(group, memberData) }
        } catch (error) {
            lastError = error
            if (isMemberNotFoundError(error)) return { kind: 'not_member' }
            if (isTransientBotApiError(error) && attempt < MEMBER_QUERY_MAX_ATTEMPTS) {
                await wait(MEMBER_QUERY_RETRY_DELAY_MS * attempt)
                continue
            }
            break
        }
    }

    if (lastError && !isTransientBotApiError(lastError)) {
        try {
            const member = await findMemberFromList(event, group, userId)
            if (member) return { kind: 'matched', group: buildMatchedGroup(group, member), fallback: true }
            return { kind: 'not_member', fallback: true }
        } catch (fallbackError) {
            return {
                kind: 'api_error',
                error: `${errorText(lastError) || '成员信息接口失败'}；成员列表降级查询失败：${errorText(fallbackError) || '未知错误'}`
            }
        }
    }

    return {
        kind: 'transient_error',
        error: errorText(lastError) || '成员接口暂时不可用'
    }
}

async function findCommonGroups(event, userId, maxGroups, offset = 0) {
    const live = await fetchLiveGroups(event)
    if (live.groups.length === 0) {
        return {
            ...live,
            checkedGroups: 0,
            failedGroups: 0,
            notMemberGroups: 0,
            transientFailures: 0,
            apiFailures: 0,
            truncated: false,
            commonGroups: []
        }
    }

    const groups = live.groups.slice(offset, offset + maxGroups)
    const results = await mapWithConcurrency(groups, MEMBER_QUERY_CONCURRENCY, group => queryGroupMember(event, group, userId))
    const commonGroups = results.filter(result => result?.kind === 'matched').map(result => result.group)
    const notMemberGroups = results.filter(result => result?.kind === 'not_member').length
    const transientFailures = results.filter(result => result?.kind === 'transient_error').length
    const apiFailures = results.filter(result => result?.kind === 'api_error').length
    return {
        groups: live.groups,
        error: live.error,
        checkedGroups: groups.length,
        groupOffset: offset,
        failedGroups: transientFailures + apiFailures,
        notMemberGroups,
        transientFailures,
        apiFailures,
        truncated: offset + groups.length < live.groups.length,
        nextGroupOffset: offset + groups.length < live.groups.length ? offset + groups.length : null,
        commonGroups
    }
}

function formatGroupMessageRecord(record, groupNames) {
    const groupId = String(record.groupId || '')
    const groupName = groupNames.get(groupId) || ''
    return {
        groupId,
        groupName,
        nickname: record.nickname || '',
        createdAt: record.createdAt,
        time: formatDBTimestampToBeijing(record.createdAt),
        text: String(record.normalizedText || '').slice(0, 500),
        isCommand: record.isCommand === true
    }
}

function formatDirectMessageRecord(record) {
    return {
        scopeType: record.scopeType === 'temp' ? 'temp' : 'friend',
        groupId: record.groupId || '',
        nickname: record.nickname || '',
        createdAt: record.createdAt,
        time: formatDBTimestampToBeijing(record.createdAt),
        text: String(record.normalizedText || '').slice(0, 500)
    }
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase()
    if (['common_groups', 'groups', 'shared_groups'].includes(mode)) return 'common_groups'
    if (['group_messages', 'group_records', 'messages'].includes(mode)) return 'group_messages'
    if (['private_messages', 'direct_messages', 'private', 'temp'].includes(mode)) return 'private_messages'
    return 'all'
}

export function parseQQUserId(value) {
    return normalizeUserId(value)
}

export const qqUserLookupTool = {
    name: 'qq_user_lookup',
    permission: 'master',
    description: '主人专用：根据 QQ 号反查机器人与该用户的共同群，并检索本地已记录的群聊、好友私聊和群临时会话来源。实时共同群来自 OneBot 群列表与成员查询；没有记录不等于用户不存在。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'qq_user_lookup',
            description: '根据 QQ 号确认共同群和本地交互来源。只读，不会联系、加好友、拉群或发送消息。仅主人可用。',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '目标 QQ 号，5-15 位数字。'
                    },
                    mode: {
                        type: 'string',
                        enum: ['all', 'common_groups', 'group_messages', 'private_messages'],
                        description: '查询范围。默认 all；common_groups=实时共同群；group_messages=本地群聊记录；private_messages=好友私聊/群临时会话记录。'
                    },
                    limit: {
                        type: 'number',
                        description: '每类本地记录最多返回多少条，默认 60，最多 300；结果可用 offset 分页。'
                    },
                    max_groups: {
                        type: 'number',
                        description: '实时检查的群数量上限，默认 500，最多 1000；结果可用 group_offset 分页。'
                    },
                    group_offset: {
                        type: 'number',
                        description: '实时群查询起始偏移，默认 0；结果提示 nextGroupOffset 时可继续查询。'
                    },
                    offset: {
                        type: 'number',
                        description: '本地群聊/私聊流水分页偏移，默认 0；结果提示 nextOffset 时可继续查询。'
                    }
                },
                required: ['user_id']
            }
        }
    },

    async execute(args = {}, context = {}) {
        if (context.isMaster !== true && context.event?.isMaster !== true) {
            return { ok: false, error: '权限不足：QQ 用户来源反查仅限机器人主人使用。' }
        }

        const userId = normalizeUserId(args.user_id)
        if (!userId) return { ok: false, error: '请提供 5-15 位数字组成的 QQ 号。' }

        const mode = normalizeMode(args.mode)
        const limit = normalizeLimit(args.limit)
        const maxGroups = normalizeMaxGroups(args.max_groups)
        const groupOffset = normalizeOffset(args.group_offset)
        const offset = normalizeOffset(args.offset)
        const manager = global.AIPluginConversationManager
        const db = manager?.db
        const result = {
            ok: true,
            userId,
            mode,
            commonGroups: [],
            groupMessages: [],
            directMessages: [],
            aiConversation: { available: false, turnCount: 0, dates: [] },
            coverage: [],
            warnings: [],
            offset,
            nextOffset: null,
            nextGroupMessageOffset: null,
            nextDirectMessageOffset: null,
            nextGroupOffset: null,
            notMemberGroups: 0,
            failedGroups: 0,
            transientFailures: 0,
            apiFailures: 0,
            truncated: false
        }

        let liveGroupResult = { groups: [], error: '未执行实时群查询' }
        if (mode === 'all' || mode === 'common_groups') {
            liveGroupResult = await findCommonGroups(context.event, userId, maxGroups, groupOffset)
            result.commonGroups = liveGroupResult.commonGroups
            result.nextGroupOffset = liveGroupResult.nextGroupOffset
            result.notMemberGroups = liveGroupResult.notMemberGroups || 0
            result.failedGroups = liveGroupResult.failedGroups || 0
            result.transientFailures = liveGroupResult.transientFailures || 0
            result.apiFailures = liveGroupResult.apiFailures || 0
            result.truncated = result.truncated || liveGroupResult.truncated
            result.coverage.push(`已实时检查 ${liveGroupResult.checkedGroups} 个机器人所在群，明确不在群 ${liveGroupResult.notMemberGroups || 0} 个`)
            if (liveGroupResult.truncated) result.warnings.push(`机器人可见群共 ${liveGroupResult.groups.length} 个，本次检查偏移 ${liveGroupResult.groupOffset} 起的 ${liveGroupResult.checkedGroups} 个。`)
            if (liveGroupResult.error) result.warnings.push(`实时共同群查询失败：${liveGroupResult.error}`)
            if (liveGroupResult.failedGroups > 0) {
                const details = []
                if (liveGroupResult.transientFailures > 0) details.push(`临时连接/超时 ${liveGroupResult.transientFailures} 个`)
                if (liveGroupResult.apiFailures > 0) details.push(`接口异常 ${liveGroupResult.apiFailures} 个`)
                result.warnings.push(`${liveGroupResult.failedGroups} 个群未能确认成员状态（${details.join('，') || '未知原因'}），结果可能不完整。`)
            }
        }

        const groupNames = new Map((liveGroupResult.groups || []).map(group => [String(group.groupId), group.groupName]))
        if (mode === 'all' || mode === 'group_messages') {
            if (!db?.getGroupMessageLogs) {
                result.warnings.push('本地群聊流水数据库不可用。')
            } else {
                try {
                    const logs = await db.getGroupMessageLogs({ userId, limit, offset })
                    result.groupMessages = logs.map(record => formatGroupMessageRecord(record, groupNames))
                    result.nextGroupMessageOffset = logs.length >= limit ? offset + logs.length : null
                    result.nextOffset = result.nextGroupMessageOffset
                    result.truncated = result.truncated || result.nextGroupMessageOffset !== null
                    result.coverage.push(`本地群聊流水命中 ${logs.length} 条`)
                    for (const log of logs) {
                        const groupId = String(log.groupId || '')
                        if (groupId && !groupNames.has(groupId)) groupNames.set(groupId, '')
                    }
                } catch (error) {
                    result.warnings.push(`本地群聊流水查询失败：${error.message || String(error)}`)
                }
            }
        }

        if (mode === 'all' || mode === 'private_messages') {
            if (!db?.getDirectMessageLogs) {
                result.warnings.push('私聊/临时会话流水表不可用；只能依赖已有 AI 对话记忆。')
            } else {
                try {
                    const logs = await db.getDirectMessageLogs({ userId, limit, offset })
                    result.directMessages = logs.map(formatDirectMessageRecord)
                    result.nextDirectMessageOffset = logs.length >= limit ? offset + logs.length : null
                    result.nextOffset = result.nextDirectMessageOffset
                    result.truncated = result.truncated || result.nextDirectMessageOffset !== null
                    result.coverage.push(`本地好友私聊/临时会话流水命中 ${logs.length} 条`)
                } catch (error) {
                    result.warnings.push(`私聊/临时会话流水查询失败：${error.message || String(error)}`)
                }
            }
        }

        if (mode === 'all' || mode === 'private_messages') {
            if (!db?.getConversationHistory) {
                result.warnings.push('AI 对话历史数据库不可用。')
            } else {
                try {
                    const history = await db.getConversationHistory(userId)
                    const dates = [...new Set(history.map(turn => turn.date_str).filter(Boolean))]
                    result.aiConversation = { available: history.length > 0, turnCount: history.length, dates }
                    result.coverage.push(`已有 AI 对话历史 ${history.length} 轮`)
                } catch (error) {
                    result.warnings.push(`AI 对话历史查询失败：${error.message || String(error)}`)
                }
            }
        }

        result.commonGroupCount = result.commonGroups.length
        result.groupMessageCount = result.groupMessages.length
        result.directMessageCount = result.directMessages.length
        result.hasAnyEvidence = result.commonGroups.length > 0
            || result.groupMessages.length > 0
            || result.directMessages.length > 0
            || result.aiConversation.available
        return result
    },

    formatResult(data) {
        if (!data || data.ok === false) return `\n\n【QQ 用户来源查询失败】${data?.error || '未知错误'}`
        const lines = [`\n\n【QQ 用户来源查询】QQ：${data.userId}`]
        if (data.mode === 'all' || data.mode === 'common_groups') {
            if (data.commonGroups?.length > 0) {
                lines.push(`共同群（实时确认 ${data.commonGroups.length} 个）：`)
                data.commonGroups.slice(0, 30).forEach((group, index) => {
                    const label = group.groupName ? `「${group.groupName}」` : '未命名群'
                    const identity = group.card || group.nickname ? `，群内身份：${group.card || group.nickname}` : ''
                    lines.push(`${index + 1}. ${label}（群号：${group.groupId}）${identity}`)
                })
            } else {
                lines.push('实时共同群：本次没有确认到共同群。注意：这不等于目标 QQ 不存在，可能是成员接口失败、检查范围受限或机器人不在该群。')
            }
        } else {
            lines.push('实时共同群：本次未查询（可将 mode 改为 common_groups 或 all）。')
        }
        if (data.groupMessages?.length > 0) {
            lines.push(`本地群聊记录：命中 ${data.groupMessageCount} 条。`)
            data.groupMessages.slice(-8).forEach(record => {
                const group = record.groupName ? `「${record.groupName}」(${record.groupId})` : `群${record.groupId}`
                lines.push(`- ${record.time} ${group}：${record.text || '（非文本消息）'}`)
            })
        } else if (data.mode === 'all' || data.mode === 'group_messages') {
            lines.push('本地群聊记录：没有命中已保存的目标 QQ 发言。')
        }
        if (data.directMessages?.length > 0) {
            lines.push(`好友私聊/群临时会话：命中 ${data.directMessageCount} 条。`)
            data.directMessages.slice(-8).forEach(record => {
                const scope = record.scopeType === 'temp'
                    ? `群临时会话${record.groupId ? `（群${record.groupId}）` : ''}`
                    : '好友私聊'
                lines.push(`- ${record.time} ${scope}：${record.text || '（非文本消息）'}`)
            })
        } else if (data.mode === 'all' || data.mode === 'private_messages') {
            lines.push('好友私聊/群临时会话：没有命中已采集的原始流水。')
        }
        if (data.aiConversation?.available) lines.push(`AI 对话历史：有 ${data.aiConversation.turnCount} 条历史记录，日期覆盖 ${data.aiConversation.dates.join('、') || '未知'}。`)
        if (data.coverage?.length > 0) lines.push(`查询覆盖：${data.coverage.join('；')}`)
        if (data.truncated) lines.push(`结果已分页截断；群聊流水下一页 offset=${data.nextGroupMessageOffset ?? '无'}，私聊/临时会话下一页 offset=${data.nextDirectMessageOffset ?? '无'}，共同群下一页 group_offset=${data.nextGroupOffset ?? '无'}。不要把本页当作完整结果。`)
        if (data.warnings?.length > 0) lines.push(`查询提示：${data.warnings.join('；')}`)
        lines.push('以上只代表当前接口和本地记录能确认的范围，不代表目标 QQ 的完整社交关系。')
        return lines.join('\n')
    }
}

toolRegistry.register(qqUserLookupTool)
