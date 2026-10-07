function firstText(...values) {
    for (const value of values) {
        const text = String(value || '').trim()
        if (text) return text
    }
    return ''
}

const TOOL_RESULT_STATUSES = new Set([
    'success',
    'success_unverified',
    'success_verified',
    'partial',
    'failed',
    'failed_retryable',
    'waiting',
    'blocked'
])

function normalizeStatus(value) {
    const status = String(value || '').trim().toLowerCase()
    return TOOL_RESULT_STATUSES.has(status) ? status : ''
}

function normalizeRollbackInfo(value) {
    if (!value) return null
    if (typeof value === 'string') return value.slice(0, 1200)
    if (typeof value !== 'object' || Array.isArray(value)) return null
    return value
}

export function normalizeToolResult(toolName, rawResult, options = {}) {
    const raw = rawResult
    const objectResult = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    const stringResult = typeof raw === 'string' ? raw : ''
    const stringFailed = /^【[^】]+失败】/.test(stringResult.trim())
    const explicitStatus = normalizeStatus(objectResult?.status)
    const explicitOk = objectResult && typeof objectResult.ok === 'boolean'
        ? objectResult.ok
        : (objectResult && typeof objectResult.success === 'boolean' ? objectResult.success : undefined)
    const statusIndicatesFailure = ['failed', 'failed_retryable', 'blocked'].includes(explicitStatus)
    const protocolConflict = statusIndicatesFailure && explicitOk === true
    const ok = statusIndicatesFailure
        ? false
        : (explicitOk !== undefined ? explicitOk : !stringFailed)
    const pending = objectResult?.pending === true || objectResult?.needs_confirmation === true || objectResult?.needsConfirmation === true || explicitStatus === 'waiting'
    const verified = objectResult?.verified === true
    const changed = typeof objectResult?.changed === 'boolean' ? objectResult.changed : undefined
    const recoverable = objectResult?.recoverable === true
    const retryable = objectResult?.retryable === true || recoverable
    const needsUserAction = objectResult?.needs_user_action === true || objectResult?.needsUserAction === true
    const requiresConfirmation = pending || objectResult?.requires_confirmation === true || objectResult?.requiresConfirmation === true
    const operationOk = objectResult?.operationOk === true || objectResult?.operation_ok === true
    const partial = objectResult?.partial === true || objectResult?.status === 'partial'
    const connectionState = String(objectResult?.connectionState || objectResult?.connection_state || '').trim().toLowerCase()
    const commandOutcome = String(objectResult?.commandOutcome || objectResult?.command_outcome || '').trim().toLowerCase()
    const facts = objectResult?.facts && typeof objectResult.facts === 'object' && !Array.isArray(objectResult.facts)
        ? objectResult.facts
        : {}
    const artifacts = Array.isArray(objectResult?.artifacts) ? objectResult.artifacts.slice(0, 50) : []
    const nextHints = (Array.isArray(objectResult?.next_hints) ? objectResult.next_hints : (Array.isArray(objectResult?.nextHints) ? objectResult.nextHints : []))
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 10)
    const error = ok ? '' : firstText(objectResult?.error, objectResult?.reason, stringResult)
    const summary = firstText(
        objectResult?.summary,
        objectResult?.message,
        pending ? `${toolName} 等待用户确认` : '',
        ok ? `${toolName} 执行完成` : `${toolName} 执行失败`
    )
    const requestedStatus = explicitStatus
    const status = requestedStatus || (requiresConfirmation || needsUserAction || connectionState === 'disconnected'
        ? 'waiting'
        : !ok
            ? (retryable ? 'failed_retryable' : 'failed')
            : partial
                ? 'partial'
                : verified ? 'success_verified' : 'success_unverified')

    return {
        protocolVersion: 2,
        tool: String(toolName || ''),
        status,
        ok,
        partial,
        pending,
        needsConfirmation: requiresConfirmation,
        requiresConfirmation,
        needsUserAction,
        operationOk,
        verified,
        changed,
        recoverable,
        retryable,
        connectionState,
        commandOutcome,
        protocolConflict,
        summary,
        error,
        facts,
        artifacts,
        rollbackInfo: normalizeRollbackInfo(objectResult?.rollbackInfo || objectResult?.rollback_info),
        nextHints,
        data: raw,
        metrics: {
            elapsedMs: Math.max(0, Number(options.elapsedMs) || 0),
            attempt: Math.max(0, Number(options.attempt) || 0)
        }
    }
}

export function formatToolProtocol(protocol = {}) {
    const status = String(protocol.status || (protocol.ok ? 'success_unverified' : 'failed'))
    const fields = [
        `status=${status}`,
        `ok=${protocol.ok === true}`,
        `verified=${protocol.verified === true}`,
        `retryable=${protocol.retryable === true}`,
        `requiresConfirmation=${protocol.requiresConfirmation === true}`,
        `partial=${protocol.partial === true}`
    ]
    let facts = '{}'
    try {
        facts = protocol.facts && typeof protocol.facts === 'object' ? JSON.stringify(protocol.facts).slice(0, 1200) : '{}'
    } catch {
        facts = '{\"unserializable\":true}'
    }
    const error = String(protocol.error || '').slice(0, 600)
    return `【工具协议】工具=${protocol.tool || 'unknown'}；${fields.join('；')}；facts=${facts}${error ? `；error=${error}` : ''}`
}
export function deterministicToolDecision(results = []) {
    const normalized = (results || []).filter(Boolean)
    if (normalized.length === 0) return null
    if (normalized.some(result => result.pending || result.needsConfirmation || result.requiresConfirmation)) {
        return {
            completionStatus: 'waiting',
            summary: '任务正在等待用户确认。',
            lastObservation: normalized.filter(result => result.pending || result.needsConfirmation || result.requiresConfirmation).map(result => result.summary).join('；'),
            nextHint: ''
        }
    }
    const userActionRequired = normalized.find(result => result.needsUserAction || result.connectionState === 'disconnected')
    if (userActionRequired) {
        return {
            completionStatus: 'waiting',
            summary: '工具已发现会话连接中断，等待用户重新建立连接或补充操作。',
            lastObservation: userActionRequired.error || userActionRequired.summary,
            nextHint: userActionRequired.nextHints?.[0] || '请先重新建立远端 Shell/SSH 连接，再继续执行目标命令。'
        }
    }
    const failed = normalized.find(result => !result.ok)
    if (failed) {
        return {
            completionStatus: failed.retryable || failed.recoverable ? 'continue' : 'blocked',
            summary: failed.retryable || failed.recoverable ? '工具执行失败，但仍可调整参数或方案重试。' : '工具执行失败，当前无法自动恢复。',
            lastObservation: failed.error || failed.summary,
            nextHint: failed.retryable || failed.recoverable ? '根据工具错误修正参数或更换安全工具后重试。' : ''
        }
    }
    if (normalized.some(result => result.partial || result.status === 'partial')) {
        return {
            completionStatus: 'continue',
            summary: '工具只返回了部分结果，任务仍需继续核对或补充读取。',
            lastObservation: normalized.map(result => result.summary).join('；'),
            nextHint: normalized.flatMap(result => result.nextHints || [])[0] || '继续获取缺失部分，并在完成后执行验证。'
        }
    }
    if (normalized.every(result => result.verified)) {
        return {
            completionStatus: 'ready',
            summary: normalized.some(result => result.changed) ? '工具操作已完成并通过确定性验证。' : '工具查询或操作已完成并通过确定性验证。',
            lastObservation: normalized.map(result => result.summary).join('；'),
            nextHint: ''
        }
    }
    return null
}
