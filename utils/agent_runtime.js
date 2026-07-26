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

export function shouldContinueAgentRound(options = {}) {
    const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : []
    const protocols = Array.isArray(options.protocols) ? options.protocols.filter(Boolean) : []
    const stopTools = new Set(Array.isArray(options.stopTools) ? options.stopTools : [])
    const names = new Set(toolCalls.map(call => call?.name).filter(Boolean))
    if (names.size === 0 || [...names].some(name => stopTools.has(name))) return false
    if (protocols.some(protocol => protocol.pending || protocol.needsConfirmation)) return false
    if (protocols.some(protocol => !protocol.ok && protocol.recoverable)) return true

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
