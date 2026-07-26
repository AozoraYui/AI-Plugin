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

export function createAgentToolContext(baseContext = {}, call = {}, index = 0) {
    return {
        ...baseContext,
        toolName: call.name || '',
        toolCallIndex: index,
        toolArgs: call.args || {}
    }
}

export async function* executeAgentToolCalls(options = {}) {
    const registry = options.registry
    const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : []
    if (!registry?.execute) throw new Error('Agent runtime requires a tool registry')

    for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index]
        const args = call?.args && typeof call.args === 'object' ? call.args : {}
        const baseContext = typeof options.contextFactory === 'function'
            ? await options.contextFactory(call, index + 1)
            : (options.context || {})
        const context = createAgentToolContext(baseContext, call, index + 1)
        const result = await registry.execute(call.name, args, options.isMaster === true, context)
        const protocol = result.protocol || normalizeToolResult(call.name, result.success ? result.data : { ok: false, error: result.error })
        const formattedResult = result.success
            ? registry.formatToolResult(call.name, result.data)
            : `工具 ${call.name} 执行失败：${result.error || '未知错误'}`
        const status = !result.success ? 'failed' : (protocol.ok ? 'ok' : 'tool_failed')
        yield {
            index: index + 1,
            call: { ...call, args },
            key: agentToolCallKey({ ...call, args }),
            result,
            protocol,
            formattedResult,
            status,
            pending: protocol.pending || protocol.needsConfirmation
        }
    }
}
