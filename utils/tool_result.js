function firstText(...values) {
    for (const value of values) {
        const text = String(value || '').trim()
        if (text) return text
    }
    return ''
}

export function normalizeToolResult(toolName, rawResult, options = {}) {
    const raw = rawResult
    const objectResult = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    const stringResult = typeof raw === 'string' ? raw : ''
    const stringFailed = /^【[^】]+失败】/.test(stringResult.trim())
    const explicitOk = objectResult && typeof objectResult.ok === 'boolean'
        ? objectResult.ok
        : (objectResult && typeof objectResult.success === 'boolean' ? objectResult.success : undefined)
    const ok = explicitOk !== undefined ? explicitOk : !stringFailed
    const pending = objectResult?.pending === true || objectResult?.needs_confirmation === true
    const verified = objectResult?.verified === true
    const changed = typeof objectResult?.changed === 'boolean' ? objectResult.changed : undefined
    const recoverable = objectResult?.recoverable === true
    const error = ok ? '' : firstText(objectResult?.error, objectResult?.reason, stringResult)
    const summary = firstText(
        objectResult?.summary,
        objectResult?.message,
        pending ? `${toolName} 等待用户确认` : '',
        ok ? `${toolName} 执行完成` : `${toolName} 执行失败`
    )

    return {
        protocolVersion: 1,
        tool: String(toolName || ''),
        ok,
        pending,
        needsConfirmation: pending,
        verified,
        changed,
        recoverable,
        summary,
        error,
        data: raw,
        metrics: {
            elapsedMs: Math.max(0, Number(options.elapsedMs) || 0)
        }
    }
}

export function deterministicToolDecision(results = []) {
    const normalized = (results || []).filter(Boolean)
    if (normalized.length === 0) return null
    if (normalized.some(result => result.pending || result.needsConfirmation)) {
        return {
            completionStatus: 'waiting',
            summary: '任务正在等待用户确认。',
            lastObservation: normalized.filter(result => result.pending || result.needsConfirmation).map(result => result.summary).join('；'),
            nextHint: ''
        }
    }
    const failed = normalized.find(result => !result.ok)
    if (failed) {
        return {
            completionStatus: failed.recoverable ? 'continue' : 'blocked',
            summary: failed.recoverable ? '工具执行失败，但仍可调整参数或方案重试。' : '工具执行失败，当前无法自动恢复。',
            lastObservation: failed.error || failed.summary,
            nextHint: failed.recoverable ? '根据工具错误修正参数或更换安全工具后重试。' : ''
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
