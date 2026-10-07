import {
    agentToolCallKey,
    executeAgentToolCalls,
    filterRepeatedAgentToolCalls,
    deferDependentSideEffectCalls,
    summarizeAgentExecutions
} from './agent_runtime.js'

export function prepareAgentRound(toolCalls = [], options = {}) {
    const deduped = filterRepeatedAgentToolCalls(toolCalls, options.seenToolCalls || new Set())
    const deferred = deferDependentSideEffectCalls(deduped.tools, options.sideEffectTools || [])
    return {
        tools: deferred.tools,
        deferred: deferred.deferred,
        skipped: deduped.skipped
    }
}

export async function executeAgentRound(options = {}) {
    const executions = []
    const startedAt = Date.now()
    for await (const execution of executeAgentToolCalls(options)) {
        executions.push(execution)
        if (typeof options.onExecution === 'function') {
            const decision = await options.onExecution(execution, executions)
            if (decision?.stop === true) break
        }
    }
    return {
        executions,
        summary: summarizeAgentExecutions(executions, { budget: options.budget }),
        elapsedMs: Math.max(0, Date.now() - startedAt)
    }
}

export async function planAgentContinuation(options = {}) {
    if (typeof options.analyze !== 'function') throw new Error('Agent orchestrator requires a continuation analyzer')
    if (typeof options.filterTools !== 'function') throw new Error('Agent orchestrator requires a tool safety filter')
    const enabled = new Set(Array.isArray(options.enabledTools) ? options.enabledTools : [])
    const allowed = new Set(Array.isArray(options.allowedTools) ? options.allowedTools : [])
    if (enabled.size === 0 || allowed.size === 0) {
        return { analysis: null, tools: [], blocked: [], skipped: [], intent: '', reason: '无可用的已授权工具' }
    }
    const analysis = await options.analyze()
    const extracted = typeof options.extractTools === 'function'
        ? await options.extractTools(analysis)
        : analysis?.tools
    const rawTools = Array.isArray(extracted) ? extracted : []
    const filteredResult = await options.filterTools(rawTools, analysis)
    const filteredTools = Array.isArray(filteredResult)
        ? filteredResult
        : (Array.isArray(filteredResult?.tools) ? filteredResult.tools : [])
    const blocked = Array.isArray(filteredResult?.blocked) ? filteredResult.blocked : []
    let tools = filteredTools.filter(call => allowed.has(call?.name) && enabled.has(call.name))
    if (typeof options.normalizeTools === 'function') {
        const approvedCalls = new Set(tools.map(agentToolCallKey))
        const normalized = await options.normalizeTools(tools, analysis)
        tools = Array.isArray(normalized)
            ? normalized.filter(call => approvedCalls.has(agentToolCallKey(call)))
            : []
    }
    const deduped = filterRepeatedAgentToolCalls(tools, options.seenToolCalls || new Set())
    const maxTools = Math.max(0, Number(options.maxTools) || 0)
    if (maxTools > 0) tools = deduped.tools.slice(0, maxTools)
    else tools = deduped.tools
    return {
        analysis,
        tools,
        blocked,
        skipped: deduped.skipped,
        intent: String(analysis?.intent || options.fallbackIntent || '').trim(),
        reason: String(analysis?.reason || '').trim()
    }
}
