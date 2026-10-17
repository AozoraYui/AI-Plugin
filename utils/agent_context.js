const CONTEXT_ID_PREFIXES = {
    requestId: 'request',
    taskId: 'task',
    conversationId: 'conversation'
}

function normalizeContextValue(value) {
    return String(value ?? '').trim()
}

function createContextId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function firstContextValue(...values) {
    for (const value of values) {
        const normalized = normalizeContextValue(value)
        if (normalized) return normalized
    }
    return ''
}

export function createAgentExecutionContext(baseContext = {}, overrides = {}) {
    const merged = { ...(baseContext || {}), ...(overrides || {}) }
    const taskId = firstContextValue(merged.taskId, merged.agentTaskId, merged.agent_task_id)
    const messageId = firstContextValue(merged.messageId, merged.message_id, merged.event?.message_id)
    const requestId = firstContextValue(merged.requestId, merged.request_id)
        || (messageId ? `message:${messageId}` : '')
        || createContextId(CONTEXT_ID_PREFIXES.requestId)
    const conversationId = firstContextValue(
        merged.conversationId,
        merged.conversation_id,
        merged.sessionId,
        merged.session_id,
        merged.groupId ? `group:${merged.groupId}` : '',
        merged.userId ? `private:${merged.userId}` : ''
    ) || createContextId(CONTEXT_ID_PREFIXES.conversationId)

    return {
        ...merged,
        requestId,
        conversationId,
        taskId: taskId || createContextId(CONTEXT_ID_PREFIXES.taskId),
        agentTaskId: taskId || normalizeContextValue(merged.agentTaskId),
        userId: normalizeContextValue(merged.userId || merged.user_id),
        groupId: normalizeContextValue(merged.groupId || merged.group_id),
        signal: merged.signal || null
    }
}

export function createAgentCancellationError(reason = '请求已取消') {
    const error = new Error(normalizeContextValue(reason) || '请求已取消')
    error.name = 'AgentExecutionCancelledError'
    error.code = 'AGENT_CANCELLED'
    error.reason = error.message
    return error
}

export function isAgentCancellationError(error, signal) {
    if (signal?.aborted && signal.reason?.name !== 'TimeoutError') return true
    return error?.code === 'AGENT_CANCELLED'
        || error?.name === 'AgentExecutionCancelledError'
        || (error?.name === 'AbortError' && signal?.aborted && signal.reason?.name !== 'TimeoutError')
}

export function throwIfAgentExecutionCancelled(signal) {
    if (!signal?.aborted) return
    throw createAgentCancellationError(signal.reason?.message || '请求已取消')
}

export function isCancelledToolResult(result = {}) {
    return Boolean(result?.cancelled === true
        || result?.code === 'AGENT_CANCELLED'
        || result?.status === 'cancelled'
        || result?.protocol?.cancelled === true
        || result?.protocol?.status === 'cancelled')
}
