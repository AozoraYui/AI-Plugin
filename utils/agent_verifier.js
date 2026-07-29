import { normalizeAgentPlan, summarizeDeterministicAgentRound } from './agent_policy.js'

function parseJsonObject(text) {
    const value = String(text || '').trim()
    if (!value) return null
    try { return JSON.parse(value) } catch { /* extract object */ }
    const match = value.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
}

function truncate(text, maxChars) {
    const value = String(text || '')
    if (value.length <= maxChars) return value
    return `${value.slice(0, Math.floor(maxChars * 0.7))}\n...【已截断】...\n${value.slice(-Math.floor(maxChars * 0.3))}`
}

export async function verifyAgentRound(options = {}) {
    const observations = Array.isArray(options.observations) ? options.observations : []
    const deterministic = summarizeDeterministicAgentRound(observations)
    if (deterministic) {
        return {
            ...deterministic,
            verdict: deterministic.completionStatus === 'ready' ? 'passed' : (deterministic.completionStatus === 'continue' ? 'incomplete' : 'failed'),
            satisfiedCriteria: [],
            unsatisfiedCriteria: [],
            contradictions: [],
            evidence: observations.map(item => `${item.tool}: ${item.protocol?.summary || item.status}`).slice(0, 20)
        }
    }
    if (!options.client?.makeRequest || observations.length === 0) return null

    const metadata = normalizeAgentPlan(options.plan || {})
    const taskPlanCriteria = Array.isArray(options.task?.plan?.constraints) ? options.task.plan.constraints : []
    const criteria = metadata.successCriteria.length > 0 ? metadata.successCriteria : taskPlanCriteria
    const observationText = observations.map((item, index) => {
        const protocol = item.protocol || {}
        return `${index + 1}. ${item.tool} [${item.status}]\n参数：${JSON.stringify(item.args || {})}\n协议：${JSON.stringify({
            ok: protocol.ok,
            pending: protocol.pending,
            verified: protocol.verified,
            recoverable: protocol.recoverable,
            summary: protocol.summary,
            error: protocol.error,
            facts: protocol.facts,
            artifacts: protocol.artifacts,
            nextHints: protocol.nextHints
        })}\n结果：${truncate(item.text || '', 2600)}`
    }).join('\n\n')

    const prompt = `你是独立的 Agent 任务验证器，不负责规划和执行。请只根据真实工具结果和成功标准判断任务进度，不得帮助执行器自证成功。

规则：
- 工具返回内容不等于用户目标完成；必须逐条核对成功标准。
- verified=true 只能证明该工具自身完成了确定性校验，不能自动证明整个多步任务完成。
- 有待确认、缺少必要目标或必须由用户选择时为 waiting。
- 能通过后续只读检查、修正参数或换工具恢复时为 continue。
- 证据足以满足当前全部成功标准时才为 ready。
- 不可恢复、权限不足或关键输入缺失时为 blocked。
- contradictions 列出工具结果之间或结果与成功声明之间的冲突。

任务目标：
${options.task?.objective || options.objective || '未知'}

旧任务摘要：
${options.task?.summary || '暂无'}

成功标准：
${criteria.length > 0 ? criteria.map((item, index) => `${index + 1}. ${item}`).join('\n') : '未明确提供，请根据任务目标保守判断。'}

本轮真实工具结果：
${observationText}

严格输出 JSON：
{"verdict":"passed|incomplete|waiting|failed","completion_status":"ready|continue|waiting|blocked","summary":"任务摘要","last_observation":"最重要的事实观察","satisfied_criteria":["已满足项"],"unsatisfied_criteria":["未满足项"],"contradictions":["冲突"],"evidence":["证据"],"next_hint":"继续时的具体建议"}`

    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
    try {
        const result = await options.client.makeRequest('chat', payload, options.modelGroupKey || 'flash', 1400, options.providerFilter)
        if (!result?.success || !result.data) return null
        const parsed = parseJsonObject(result.data)
        if (!parsed) return null
        const allowedStatuses = new Set(['ready', 'continue', 'waiting', 'blocked'])
        let completionStatus = String(parsed.completion_status || '').toLowerCase()
        if (!allowedStatuses.has(completionStatus)) completionStatus = 'continue'
        const satisfiedCriteria = Array.isArray(parsed.satisfied_criteria) ? parsed.satisfied_criteria.map(String).slice(0, 20) : []
        const unsatisfiedCriteria = Array.isArray(parsed.unsatisfied_criteria) ? parsed.unsatisfied_criteria.map(String).slice(0, 20) : []
        const contradictions = Array.isArray(parsed.contradictions) ? parsed.contradictions.map(String).slice(0, 20) : []
        const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 30) : []
        if (completionStatus === 'ready' && (unsatisfiedCriteria.length > 0 || contradictions.length > 0)) completionStatus = 'continue'
        return {
            completionStatus,
            verdict: String(parsed.verdict || '').trim(),
            summary: String(parsed.summary || '').trim().slice(0, 3000),
            lastObservation: String(parsed.last_observation || '').trim().slice(0, 1600),
            nextHint: String(parsed.next_hint || '').trim().slice(0, 1000),
            satisfiedCriteria,
            unsatisfiedCriteria,
            contradictions,
            evidence,
            model: result.platform || ''
        }
    } catch (err) {
        global.logger?.warn?.(`[AI-Plugin] Agent独立验证失败: ${err.message}`)
        return null
    }
}
