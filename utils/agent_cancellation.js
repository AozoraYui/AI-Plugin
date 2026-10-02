const ACTIVE_EXECUTIONS = new Map()
const EXECUTION_TTL_MS = 30 * 60 * 1000

export const AGENT_CANCELLED_CODE = 'AGENT_CANCELLED'

export class AgentExecutionCancelledError extends Error {
    constructor(reason = '触发任务的消息已撤回') {
        super(reason)
        this.name = 'AgentExecutionCancelledError'
        this.code = AGENT_CANCELLED_CODE
        this.reason = reason
    }
}

function normalizeId(value) {
    return String(value ?? '').trim()
}

function buildSourceKey({ messageId = '', groupId = '', userId = '' } = {}) {
    const normalizedMessageId = normalizeId(messageId)
    if (!normalizedMessageId) return ''
    return `${normalizeId(groupId) || 'private'}:${normalizeId(userId)}:${normalizedMessageId}`
}

function cleanupExecution(executionId) {
    const record = ACTIVE_EXECUTIONS.get(executionId)
    if (!record) return false
    if (record.timer) clearTimeout(record.timer)
    ACTIVE_EXECUTIONS.delete(executionId)
    return true
}

export function registerAgentExecution({ messageId = '', groupId = '', userId = '' } = {}) {
    const sourceKey = buildSourceKey({ messageId, groupId, userId })
    if (!sourceKey) return null

    const controller = new AbortController()
    const executionId = `execution_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const record = {
        executionId,
        taskId: '',
        messageId: normalizeId(messageId),
        groupId: normalizeId(groupId),
        userId: normalizeId(userId),
        sourceKey,
        controller,
        cancelled: false,
        reason: '',
        registeredAt: Date.now(),
        timer: null
    }
    record.timer = setTimeout(() => cleanupExecution(executionId), EXECUTION_TTL_MS)
    record.timer.unref?.()
    ACTIVE_EXECUTIONS.set(executionId, record)

    return {
        executionId,
        signal: controller.signal,
        bindTask(taskId) {
            const current = ACTIVE_EXECUTIONS.get(executionId)
            if (current) current.taskId = normalizeId(taskId)
            return current?.taskId || ''
        },
        isCancelled() {
            return controller.signal.aborted || Boolean(ACTIVE_EXECUTIONS.get(executionId)?.cancelled)
        },
        throwIfCancelled() {
            const current = ACTIVE_EXECUTIONS.get(executionId)
            if (controller.signal.aborted || current?.cancelled) {
                throw new AgentExecutionCancelledError(current?.reason || '触发任务的消息已撤回')
            }
        },
        dispose() {
            cleanupExecution(executionId)
        }
    }
}

export function cancelAgentExecutionsByRecalledMessage({ messageId = '', groupId = '', userId = '', operatorId = '', reason = '触发任务的消息已撤回' } = {}) {
    const recalledMessageId = normalizeId(messageId)
    const recalledGroupId = normalizeId(groupId)
    const recalledUserId = normalizeId(userId)
    const recalledOperatorId = normalizeId(operatorId)
    if (!recalledMessageId || !recalledUserId) return []

    // 只响应消息作者主动撤回。管理员/群主撤回他人的命令不应替他取消正在运行的任务。
    if (recalledOperatorId && recalledOperatorId !== recalledUserId) return []

    const cancelled = []
    for (const record of ACTIVE_EXECUTIONS.values()) {
        if (record.messageId !== recalledMessageId) continue
        if (record.userId !== recalledUserId) continue
        if (record.groupId !== recalledGroupId) continue
        record.cancelled = true
        record.reason = reason
        record.controller.abort(reason)
        cancelled.push({
            executionId: record.executionId,
            taskId: record.taskId,
            messageId: record.messageId,
            groupId: record.groupId,
            userId: record.userId,
            reason
        })
    }
    return cancelled
}

export function isAgentExecutionCancelled(error) {
    return Boolean(error?.code === AGENT_CANCELLED_CODE || error?.name === 'AbortError')
}

export function getActiveAgentExecutionCount() {
    return ACTIVE_EXECUTIONS.size
}
