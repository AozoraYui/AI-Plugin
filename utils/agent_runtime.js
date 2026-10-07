import { normalizeToolResult } from './tool_result.js'

export function stableAgentStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableAgentStringify).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableAgentStringify(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

export function agentToolCallKey(call = {}) {
    return `${call.name || ''}:${stableAgentStringify(call.args || {})}`
}

export function filterRepeatedAgentToolCalls(toolCalls = [], seenToolCalls = new Set()) {
    const tools = []
    const skipped = []
    const reserved = new Set(seenToolCalls)
    for (const call of toolCalls || []) {
        const key = agentToolCallKey(call)
        if (reserved.has(key)) {
            skipped.push(call)
            continue
        }
        reserved.add(key)
        tools.push(call)
    }
    return { tools, skipped }
}

export function deferDependentSideEffectCalls(toolCalls = [], stopTools = []) {
    const calls = Array.isArray(toolCalls) ? toolCalls : []
    const stopSet = new Set(Array.isArray(stopTools) ? stopTools : [])
    const readCalls = calls.filter(call => call?.name && !stopSet.has(call.name))
    const sideEffectCalls = calls.filter(call => call?.name && stopSet.has(call.name))
    if (readCalls.length === 0 || sideEffectCalls.length === 0) {
        return { tools: calls, deferred: [] }
    }
    return { tools: readCalls, deferred: sideEffectCalls }
}

export function retainAgentContinuationTools(candidateTools = [], previousToolCalls = [], enabledTools = [], allowedTools = []) {
    const enabled = new Set(Array.isArray(enabledTools) ? enabledTools : [])
    const allowed = new Set(Array.isArray(allowedTools) ? allowedTools : [])
    const merged = new Set((Array.isArray(candidateTools) ? candidateTools : []).filter(name => enabled.has(name)))
    for (const call of Array.isArray(previousToolCalls) ? previousToolCalls : []) {
        const name = String(call?.name || '').trim()
        if (name && enabled.has(name) && (allowed.size === 0 || allowed.has(name))) merged.add(name)
    }
    return [...merged]
}

export function createAgentToolContext(baseContext = {}, call = {}, index = 0) {
    return {
        ...baseContext,
        toolName: call.name || '',
        toolCallIndex: index,
        toolArgs: call.args || {}
    }
}

export function isUnfulfilledImageSearch(call = {}, resultData = {}) {
    return call?.name === 'web_search'
        && Number(call?.args?.image_count || 0) > 0
        && Number(resultData?.requestedImages || 0) > 0
        && (!Array.isArray(resultData?.sentImages) || resultData.sentImages.length === 0)
}

export function shouldStopRepeatedImageSearch(failedAttempts = 0, maxAttempts = 2) {
    return Math.max(0, Number(failedAttempts) || 0) >= Math.max(1, Number(maxAttempts) || 2)
}

export function shouldContinueAgentRound(options = {}) {
    const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : []
    const protocols = Array.isArray(options.protocols) ? options.protocols.filter(Boolean) : []
    const stopTools = new Set(Array.isArray(options.stopTools) ? options.stopTools : [])
    const names = new Set(toolCalls.map(call => call?.name).filter(Boolean))
    if (names.size === 0 || [...names].some(name => stopTools.has(name))) return false
    if (protocols.some(protocol => protocol.pending || protocol.needsConfirmation)) return false
    if (protocols.some(protocol => !protocol.ok && (protocol.retryable || protocol.recoverable))) return true

    const instruction = String(options.instruction || '').trim()
    const contextTail = String(options.accumulatedText || '').slice(-12000)
    if (/目录安全检查|已阻止执行|安全检查阻止|请先向主人确认下一步/i.test(contextTail)) return false
    if (/输出未读完|offset_chars|仍未读完|分页: 已显示/i.test(contextTail)) return true
    if (/(?:先|首先|第一步).{0,100}(?:再|然后|接着|之后|最后)|(?:然后|接着|再|顺便|同时|并且|以及).{0,80}(?:看|查|分析|统计|确认|验证|整理|总结|执行|修复|修改|更新|跑)/i.test(instruction)) return true

    const hasShell = names.has('shell_exec') || names.has('shell_session')
    if (hasShell) {
        if (/(?:更新|拉取|git\s+pull).{0,50}(?:更新内容|变更|变化|改了啥|改了什么|提交|commit|diff|日志)|(?:更新内容|变更|变化|改了啥|改了什么|提交|commit|diff|日志).{0,50}(?:更新|拉取|插件|仓库|代码)/i.test(instruction)) return true
        if (/(?:nmap|局域网|内网|LAN|网段|入网设备|在线设备|网关|路由器)/i.test(instruction)) return true
        if (/(?:排查|诊断|定位|分析).{0,30}(?:原因|问题|故障|报错|异常|卡顿|性能|慢|失败)|(?:为什么|为啥|哪里|哪个).{0,30}(?:报错|失败|卡|慢|占用|异常)/i.test(instruction)) return true
    }
    if (names.has('web_search')) {
        return /(?:搜索|查询|联网|上网).{0,80}(?:打开|抓取|fetch|网页|原文|详情|来源|对比|汇总|总结)/i.test(instruction)
    }
    if (names.has('config_manage')) {
        const readAction = toolCalls.some(call => call.name === 'config_manage' && ['read', 'get', 'validate'].includes(call.args?.action))
        return readAction && /(?:修改|更新|写入|加入|添加|删除|移除|改成|设置)/i.test(instruction)
    }
    return false
}

export function buildAgentRoundFingerprint(observations = [], decision = {}) {
    const compact = (Array.isArray(observations) ? observations : []).map(item => ({
        tool: item?.tool || '',
        status: item?.status || '',
        args: item?.args || {},
        ok: item?.protocol?.ok,
        pending: item?.protocol?.pending,
        recoverable: item?.protocol?.recoverable,
        retryable: item?.protocol?.retryable,
        verified: item?.protocol?.verified,
        summary: String(item?.protocol?.summary || '').slice(0, 600),
        error: String(item?.protocol?.error || '').slice(0, 600),
        result: String(item?.text || '').slice(-1200)
    }))
    return stableAgentStringify({
        observations: compact,
        completionStatus: decision?.completionStatus || '',
        lastObservation: String(decision?.lastObservation || '').slice(0, 1000),
        nextHint: String(decision?.nextHint || '').slice(0, 600)
    })
}

export function updateAgentStagnationState(state = {}, fingerprint = '') {
    if (!fingerprint) return { fingerprint: '', repeatCount: 0, shouldStop: false }
    const repeatCount = state.fingerprint === fingerprint ? Math.max(0, Number(state.repeatCount) || 0) + 1 : 0
    return {
        fingerprint,
        repeatCount,
        shouldStop: repeatCount >= 2
    }
}

export function createAgentTelemetry(options = {}) {
    return {
        startedAt: Number(options.startedAt) || Date.now(),
        calls: 0,
        successes: 0,
        failures: 0,
        verified: 0,
        pending: 0,
        partial: 0,
        elapsedMs: 0,
        byTool: {}
    }
}

export function recordAgentTelemetry(telemetry, execution = {}) {
    if (!telemetry) return telemetry
    const toolName = String(execution.call?.name || execution.protocol?.tool || 'unknown')
    const elapsedMs = Math.max(0, Number(execution.metrics?.elapsedMs || execution.protocol?.metrics?.elapsedMs) || 0)
    const pending = execution.pending === true
        || execution.protocol?.pending === true
        || execution.protocol?.needsConfirmation === true
        || execution.protocol?.requiresConfirmation === true
    const successful = execution.result?.success === true && execution.protocol?.ok === true && !pending
    telemetry.calls = Math.max(0, Number(telemetry.calls) || 0) + 1
    telemetry.elapsedMs = Math.max(0, Number(telemetry.elapsedMs) || 0) + elapsedMs
    if (successful) telemetry.successes = Math.max(0, Number(telemetry.successes) || 0) + 1
    if (!execution.result?.success || execution.protocol?.ok === false) telemetry.failures = Math.max(0, Number(telemetry.failures) || 0) + 1
    if (execution.protocol?.verified === true && !pending) telemetry.verified = Math.max(0, Number(telemetry.verified) || 0) + 1
    if (pending) telemetry.pending = Math.max(0, Number(telemetry.pending) || 0) + 1
    if (execution.protocol?.partial === true || execution.protocol?.status === 'partial') telemetry.partial = Math.max(0, Number(telemetry.partial) || 0) + 1
    if (!telemetry.byTool[toolName]) telemetry.byTool[toolName] = { calls: 0, successes: 0, failures: 0, verified: 0, elapsedMs: 0 }
    const toolStats = telemetry.byTool[toolName]
    toolStats.calls++
    toolStats.elapsedMs += elapsedMs
    if (successful) toolStats.successes++
    if (!execution.result?.success || execution.protocol?.ok === false) toolStats.failures++
    if (execution.protocol?.verified === true && !pending) toolStats.verified++
    return telemetry
}

export function getAgentTelemetrySnapshot(telemetry = null) {
    if (!telemetry) return { calls: 0, successes: 0, failures: 0, verified: 0, pending: 0, partial: 0, elapsedMs: 0, wallClockMs: 0, byTool: {} }
    return {
        calls: Math.max(0, Number(telemetry.calls) || 0),
        successes: Math.max(0, Number(telemetry.successes) || 0),
        failures: Math.max(0, Number(telemetry.failures) || 0),
        verified: Math.max(0, Number(telemetry.verified) || 0),
        pending: Math.max(0, Number(telemetry.pending) || 0),
        partial: Math.max(0, Number(telemetry.partial) || 0),
        elapsedMs: Math.max(0, Number(telemetry.elapsedMs) || 0),
        wallClockMs: Math.max(0, Date.now() - (Number(telemetry.startedAt) || Date.now())),
        byTool: Object.fromEntries(Object.entries(telemetry.byTool || {}).map(([name, stats]) => [name, { ...stats }]))
    }
}

export function summarizeAgentExecutions(executions = [], options = {}) {
    const items = Array.isArray(executions) ? executions.filter(Boolean) : []
    const isPending = execution => execution.pending === true
        || execution.protocol?.pending === true
        || execution.protocol?.needsConfirmation === true
        || execution.protocol?.requiresConfirmation === true
    const pending = items.filter(isPending)
    const successful = items.filter(execution => execution.result?.success === true
        && execution.protocol?.ok === true
        && !isPending(execution))
    const failures = items.filter(execution => execution.result?.success !== true || execution.protocol?.ok !== true)
    const partial = items.filter(execution => execution.protocol?.partial === true || execution.protocol?.status === 'partial')
    const retryableFailures = failures.filter(execution => execution.protocol?.retryable === true || execution.protocol?.recoverable === true)
    const elapsedMs = items.reduce((total, execution) => total + Math.max(
        0,
        Number(execution.metrics?.elapsedMs || execution.protocol?.metrics?.elapsedMs) || 0
    ), 0)
    const budgetExhausted = items.some(execution => execution.budgetExhausted === true)
        || options.budget?.exhausted === true
    return {
        calls: items.length,
        successes: successful.length,
        failures: failures.length,
        verified: items.filter(execution => execution.protocol?.verified === true && !isPending(execution)).length,
        pending: pending.length,
        partial: partial.length,
        retryableFailures: retryableFailures.length,
        terminalFailures: Math.max(0, failures.length - retryableFailures.length),
        budgetExhausted,
        elapsedMs,
        protocols: items.map(execution => execution.protocol).filter(Boolean),
        allFailed: items.length > 0 && failures.length === items.length,
        hasSuccessfulResult: successful.length > 0
    }
}

export function resolveAgentRoundCompletion(options = {}) {
    const summary = options.summary || {}
    const verificationStatus = String(options.verification?.completionStatus || '').trim().toLowerCase()
    const allowedStatuses = new Set(['ready', 'continue', 'waiting', 'blocked'])
    if (options.pending === true || summary.pending > 0 || verificationStatus === 'waiting') return 'waiting'
    if (summary.budgetExhausted === true) return 'blocked'
    if (options.researchEvidenceIncomplete === true) return 'continue'
    if (allowedStatuses.has(verificationStatus)) return verificationStatus
    if (summary.allFailed === true && summary.retryableFailures === 0) return 'blocked'
    if (summary.partial > 0 || summary.retryableFailures > 0 || summary.hasSuccessfulResult === true) return 'continue'
    return 'blocked'
}

export function createAgentBudget(options = {}) {
    return {
        startedAt: Number(options.startedAt) || Date.now(),
        maxToolCalls: Math.max(1, Number(options.maxToolCalls) || 32),
        toolCalls: 0,
        byTool: {},
        exhausted: false
    }
}

export function getAgentBudgetSnapshot(budget = null) {
    if (!budget) return { toolCalls: 0, maxToolCalls: 0, elapsedMs: 0, exhausted: false, byTool: {} }
    return {
        toolCalls: Math.max(0, Number(budget.toolCalls) || 0),
        maxToolCalls: Math.max(0, Number(budget.maxToolCalls) || 0),
        elapsedMs: Math.max(0, Date.now() - (Number(budget.startedAt) || Date.now())),
        exhausted: budget.exhausted === true,
        byTool: { ...(budget.byTool || {}) }
    }
}

function reserveAgentBudget(budget, toolName) {
    if (!budget) return { allowed: true, used: 0, max: 0 }
    const maxToolCalls = Math.max(1, Number(budget.maxToolCalls) || 32)
    if (Number(budget.toolCalls) >= maxToolCalls) {
        budget.exhausted = true
        return { allowed: false, used: budget.toolCalls, max: maxToolCalls }
    }
    budget.toolCalls = Math.max(0, Number(budget.toolCalls) || 0) + 1
    const name = String(toolName || 'unknown')
    budget.byTool[name] = Math.max(0, Number(budget.byTool[name]) || 0) + 1
    return { allowed: true, used: budget.toolCalls, max: maxToolCalls }
}

function buildBudgetExceededExecution(call, budget) {
    const error = `Agent 工具调用预算已用尽（${budget.toolCalls}/${budget.maxToolCalls}），已停止继续执行 ${call?.name || '未知工具'}`
    const result = { success: false, error }
    const protocol = normalizeToolResult(call?.name, {
        ok: false,
        status: 'blocked',
        error,
        retryable: false,
        facts: { budgetExhausted: true }
    })
    return {
        result,
        protocol,
        formattedResult: error,
        status: 'failed',
        protocolStatus: protocol.status,
        pending: false,
        budgetExhausted: true
    }
}

export async function* executeAgentToolCalls(options = {}) {
    const registry = options.registry
    const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : []
    const budget = options.budget || null
    if (!registry?.execute) throw new Error('Agent runtime requires a tool registry')

    for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index]
        const reservation = reserveAgentBudget(budget, call?.name)
        if (!reservation.allowed) {
            const execution = {
                index: index + 1,
                call: { ...call, args: call?.args || {} },
                key: agentToolCallKey({ ...call, args: call?.args || {} }),
                ...buildBudgetExceededExecution(call, budget)
            }
            recordAgentTelemetry(options.telemetry, execution)
            yield execution
            return
        }
        const args = call?.args && typeof call.args === 'object' ? call.args : {}
        const toolName = String(call?.name || 'unknown')
        const startedAt = Date.now()
        let result
        try {
            const baseContext = typeof options.contextFactory === 'function'
                ? await options.contextFactory(call, index + 1)
                : (options.context || {})
            const context = createAgentToolContext(baseContext, call, index + 1)
            result = await registry.execute(toolName, args, options.isMaster === true, context)
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                result = { success: false, error: '工具返回了无效结果' }
            }
        } catch (error) {
            result = { success: false, error: error?.message || String(error) }
        }
        const rawProtocol = result.protocol && typeof result.protocol === 'object'
            ? result.protocol
            : normalizeToolResult(toolName, result.success ? result.data : { ok: false, error: result.error }, {
            elapsedMs: Date.now() - startedAt,
            attempt: budget?.byTool?.[toolName] || 1
            })
        const protocol = {
            ...rawProtocol,
            metrics: {
                ...(rawProtocol.metrics || {}),
                elapsedMs: Math.max(0, Date.now() - startedAt),
                attempt: budget?.byTool?.[toolName] || 1
            }
        }
        let formattedResult
        if (!result.success) {
            formattedResult = `工具 ${toolName} 执行失败：${result.error || '未知错误'}`
        } else {
            try {
                const formatted = typeof registry.formatToolResult === 'function'
                    ? registry.formatToolResult(toolName, result.data)
                    : result.data
                formattedResult = typeof formatted === 'string' ? formatted : JSON.stringify(formatted ?? '')
            } catch (error) {
                formattedResult = `工具 ${toolName} 已执行，但结果格式化失败：${error?.message || String(error)}`
            }
        }
        const status = !result.success ? 'failed' : (protocol.ok ? 'ok' : 'tool_failed')
        const protocolStatus = protocol.status || (protocol.ok ? 'success_unverified' : 'failed')
        const execution = {
            index: index + 1,
            call: { ...call, name: toolName, args },
            key: agentToolCallKey({ ...call, name: toolName, args }),
            result,
            protocol,
            formattedResult,
            status,
            protocolStatus,
            pending: protocol.pending || protocol.needsConfirmation || protocol.requiresConfirmation,
            metrics: {
                elapsedMs: Math.max(0, Date.now() - startedAt),
                budgetUsed: budget?.toolCalls || 0,
                budgetLimit: budget?.maxToolCalls || 0
            }
        }
        recordAgentTelemetry(options.telemetry, execution)
        yield execution
    }
}
