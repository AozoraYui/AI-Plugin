const VALID_STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'skipped'])

function normalizeIdValue(value, fallback = '') {
    return String(value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function normalizeStepId(value, index, usedIds) {
    const base = normalizeIdValue(value, `step_${index + 1}`) || `step_${index + 1}`
    let id = base
    let suffix = 2
    while (usedIds.has(id)) id = `${base}_${suffix++}`
    usedIds.add(id)
    return id
}

export function selectNextAgentPlanStep(plan = {}) {
    const steps = Array.isArray(plan.steps) ? plan.steps : []
    const completed = new Set(steps.filter(step => ['completed', 'skipped'].includes(step.status)).map(step => step.id))
    return steps.find(step => step.status === 'in_progress')
        || steps.find(step => step.status === 'pending' && (Array.isArray(step.dependsOn) ? step.dependsOn : []).every(id => completed.has(id)))
        || null
}

export function normalizeAgentTaskPlan(plan = {}, fallbackObjective = '') {
    let source = plan
    if (typeof source === 'string') {
        try { source = JSON.parse(source) } catch { source = {} }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) source = {}

    const rawSteps = Array.isArray(source.steps) ? source.steps.slice(0, 50) : []
    const usedIds = new Set()
    const ids = rawSteps.map((step, index) => normalizeStepId(step?.id, index, usedIds))
    const validIds = new Set(ids)
    const idAliases = new Map()
    rawSteps.forEach((step, index) => {
        const rawId = String(step?.id || '').trim()
        if (rawId && !idAliases.has(rawId)) idAliases.set(rawId, ids[index])
        idAliases.set(ids[index], ids[index])
    })
    const steps = rawSteps.map((step = {}, index) => {
        const rawDependencies = Array.isArray(step.dependsOn)
            ? step.dependsOn
            : (Array.isArray(step.depends_on) ? step.depends_on : [])
        const dependsOn = [...new Set(rawDependencies.map(item => {
            const rawId = String(item || '').trim()
            return idAliases.get(rawId) || normalizeIdValue(rawId)
        }))]
            .filter(id => id && id !== ids[index] && validIds.has(id))
        const rawStatus = String(step.status || 'pending').trim().toLowerCase()
        return {
            id: ids[index],
            title: String(step.title || step.name || step.description || '').trim().slice(0, 300),
            tool: String(step.tool || step.toolName || '').trim().slice(0, 100),
            args: step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {},
            dependsOn,
            successPredicate: String(step.successPredicate || step.success_predicate || '').trim().slice(0, 600),
            status: VALID_STEP_STATUSES.has(rawStatus) ? rawStatus : 'pending',
            attempts: Math.max(0, Math.floor(Number(step.attempts) || 0))
        }
    })
    const constraints = (Array.isArray(source.constraints) ? source.constraints : [])
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 20)
    const normalized = {
        objective: String(source.objective || fallbackObjective || '').trim().slice(0, 1200),
        constraints,
        steps
    }
    normalized.currentStepId = selectNextAgentPlanStep(normalized)?.id || ''
    return normalized
}

export function buildAgentTaskPlan(modelPlan = {}, fallbackObjective = '') {
    const calls = Array.isArray(modelPlan.tool_plan) ? modelPlan.tool_plan.slice(0, 20) : []
    const isMultiStep = String(modelPlan.task_kind || '').toLowerCase().includes('multi') || calls.length > 1
    return normalizeAgentTaskPlan({
        objective: modelPlan.resolved_request || fallbackObjective,
        constraints: Array.isArray(modelPlan.success_criteria) ? modelPlan.success_criteria : [],
        steps: calls.map((call, index) => ({
            id: `round_1_step_${index + 1}`,
            title: call.purpose || `调用 ${call.tool || call.name || '工具'}`,
            tool: call.tool || call.name || '',
            args: call.params || call.args || {},
            dependsOn: isMultiStep && index > 0 ? [`round_1_step_${index}`] : [],
            successPredicate: call.purpose || '',
            status: index === 0 ? 'in_progress' : 'pending',
            attempts: 0
        }))
    }, fallbackObjective)
}

export function updateAgentTaskPlanFromObservations(plan = {}, observations = []) {
    const normalized = normalizeAgentTaskPlan(plan)
    if (normalized.steps.length === 0 || !Array.isArray(observations) || observations.length === 0) return normalized

    const claimed = new Set()
    for (const observation of observations) {
        const tool = String(observation?.tool || '')
        let index = normalized.steps.findIndex((step, stepIndex) => {
            if (claimed.has(stepIndex) || step.tool !== tool) return false
            return ['pending', 'in_progress', 'failed'].includes(step.status)
        })
        if (index < 0 && tool) {
            const usedIds = new Set(normalized.steps.map(step => step.id))
            let suffix = normalized.steps.length + 1
            let id = `observed_step_${suffix}`
            while (usedIds.has(id)) id = `observed_step_${++suffix}`
            normalized.steps.push({
                id,
                title: `执行 ${tool}`,
                tool,
                args: observation?.args && typeof observation.args === 'object' ? observation.args : {},
                dependsOn: [],
                successPredicate: '',
                status: 'pending',
                attempts: 0
            })
            index = normalized.steps.length - 1
        }
        if (index < 0) continue
        claimed.add(index)
        const step = normalized.steps[index]
        step.attempts += 1
        if (observation.status === 'ok' && observation.protocol?.ok !== false) step.status = 'completed'
        else if (observation.protocol?.recoverable === true) step.status = 'pending'
        else step.status = observation.protocol?.pending ? 'blocked' : 'failed'
    }

    const next = selectNextAgentPlanStep(normalized)
    if (next && next.status === 'pending') next.status = 'in_progress'
    normalized.currentStepId = next?.id || ''
    return normalized
}
