export function normalizeAgentPlan(plan = {}) {
    const rawKind = String(plan.task_kind || '').trim().toLowerCase()
    const taskKind = /^(?:multi[_\s-]?step|多步)$/.test(rawKind) ? 'multi_step' : 'single_step'
    const rawCriteria = Array.isArray(plan.success_criteria)
        ? plan.success_criteria
        : (plan.success_criteria ? [plan.success_criteria] : [])
    const successCriteria = rawCriteria
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 6)
    const followupValue = String(plan.requires_followup_check ?? '').trim().toLowerCase()
    const requiresFollowupCheck = plan.requires_followup_check === true
        || ['true', 'yes', '1', '是', '需要'].includes(followupValue)
        || taskKind === 'multi_step'
    return { taskKind, successCriteria, requiresFollowupCheck }
}

export function decideAgentContinuation(options = {}) {
    const completionStatus = String(options.completionStatus || '').trim().toLowerCase()
    if (completionStatus === 'waiting') return { shouldContinue: false, reason: '等待用户确认或补充信息' }
    if (completionStatus === 'blocked') return { shouldContinue: false, reason: '观察器判断任务已阻塞' }

    const observerRequestsContinuation = completionStatus === 'continue'
    const planRequestsContinuation = options.planRequiresFollowup === true
    const heuristicRequestsContinuation = options.heuristicRequestsContinuation === true
    const executedCount = Math.max(0, Number(options.executedCount) || 0)
    const observationCount = Math.max(0, Number(options.observationCount) || 0)

    if (observerRequestsContinuation) {
        return {
            shouldContinue: true,
            reason: executedCount > 0 ? '观察器判断还需补充工具结果' : '工具失败但观察器建议调整方案重试'
        }
    }
    if (completionStatus === 'ready' && !planRequestsContinuation) {
        return { shouldContinue: false, reason: '观察器判断现有结果已足够' }
    }
    if (observationCount === 0) {
        return { shouldContinue: false, reason: '本轮没有可供继续规划的工具观察' }
    }
    if (planRequestsContinuation) return { shouldContinue: true, reason: '原始计划要求执行后验证目标是否完成' }
    if (heuristicRequestsContinuation) return { shouldContinue: true, reason: '任务文本和工具结果显示可能需要后续步骤' }
    return { shouldContinue: false, reason: '没有继续调用工具的充分依据' }
}
