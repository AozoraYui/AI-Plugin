import { getDBTimestamp } from './common.js'

export const AGENT_TASK_STEP_MAX_CHARS = 6000
export const AGENT_TASK_OBSERVATION_MAX_CHARS = 1600
export const AGENT_TASK_SUMMARY_MAX_CHARS = 3000

function truncateTaskText(text, maxChars) {
    const value = String(text || '')
    if (value.length <= maxChars) return value
    const head = Math.floor(maxChars * 0.65)
    const tail = maxChars - head
    return `${value.slice(0, head)}\n\n...【任务记录过长，已截断 ${value.length - maxChars} 字符】...\n\n${value.slice(-tail)}`
}

function taskLogger(options = {}) {
    return options.logger || global.logger
}

function taskLogPrefix(options = {}) {
    return String(options.logPrefix || '[AI-Plugin] Agent任务')
}

export function mergeAgentRisk(previous = 'low', next = 'low') {
    const rank = { low: 0, medium: 1, high: 2 }
    return (rank[next] || 0) > (rank[previous] || 0) ? next : previous
}

export async function createOrResumeAgentTask(db, options = {}) {
    const logger = taskLogger(options)
    const prefix = taskLogPrefix(options)
    const currentTask = options.task?.taskId ? options.task : null
    if (!db) return currentTask

    if (!currentTask) {
        if (!db.createAgentTask || !options.userId || !String(options.objective || '').trim()) return null
        try {
            const task = await db.createAgentTask({
                userId: options.userId,
                groupId: options.groupId || '',
                objective: truncateTaskText(options.objective, 1200),
                status: options.status || 'active',
                riskLevel: options.riskLevel || 'low',
                summary: truncateTaskText(options.summary || '', AGENT_TASK_SUMMARY_MAX_CHARS),
                lastObservation: truncateTaskText(options.lastObservation || '', AGENT_TASK_OBSERVATION_MAX_CHARS)
            })
            if (task?.taskId) logger?.info?.(`${prefix}已创建: ${task.taskId}, risk=${task.riskLevel}`)
            return task || null
        } catch (err) {
            logger?.warn?.(`${prefix}创建失败: ${err.message}`)
            return null
        }
    }

    const riskLevel = mergeAgentRisk(currentTask.riskLevel, options.riskLevel || 'low')
    const updates = {
        status: options.status || 'active',
        riskLevel
    }
    if (options.objective) updates.objective = truncateTaskText(options.objective, 1200)
    try {
        await db.updateAgentTask?.(currentTask.taskId, updates)
        return { ...currentTask, ...updates }
    } catch (err) {
        logger?.warn?.(`${prefix}续接更新失败: ${err.message}`)
        return currentTask
    }
}

export async function recordAgentTaskStep(db, task, step = {}, options = {}) {
    if (!db?.addAgentStep || !task?.taskId) return false
    try {
        await db.addAgentStep(task.taskId, {
            ...step,
            content: truncateTaskText(step.content || '', options.maxChars || AGENT_TASK_STEP_MAX_CHARS)
        })
        return true
    } catch (err) {
        taskLogger(options)?.warn?.(`${taskLogPrefix(options)}步骤记录失败: ${err.message}`)
        return false
    }
}

export async function updateAgentTaskProgress(db, task, updates = {}, options = {}) {
    if (!db?.updateAgentTask || !task?.taskId) return task || null
    const normalized = { ...updates }
    if ('summary' in normalized) normalized.summary = truncateTaskText(normalized.summary, AGENT_TASK_SUMMARY_MAX_CHARS)
    if ('lastObservation' in normalized) normalized.lastObservation = truncateTaskText(normalized.lastObservation, AGENT_TASK_OBSERVATION_MAX_CHARS)
    if (normalized.riskLevel) normalized.riskLevel = mergeAgentRisk(task.riskLevel, normalized.riskLevel)
    try {
        await db.updateAgentTask(task.taskId, normalized)
        return { ...task, ...normalized }
    } catch (err) {
        taskLogger(options)?.warn?.(`${taskLogPrefix(options)}状态更新失败: ${err.message}`)
        return task
    }
}

export async function finalizeAgentTask(db, task, options = {}) {
    if (!task?.taskId) return task || null
    const preserveWaiting = options.preserveWaiting !== false
    const requestedStatus = options.status || 'completed'
    const status = preserveWaiting && task.status === 'waiting' && requestedStatus === 'completed'
        ? 'waiting'
        : requestedStatus
    const content = String(options.content || options.lastObservation || options.summary || '').trim()
    if (options.recordStep !== false) {
        await recordAgentTaskStep(db, task, {
            stepIndex: options.stepIndex || 9999,
            stepType: options.stepType || 'final',
            toolName: options.toolName || '',
            toolArgs: options.toolArgs || {},
            status: options.stepStatus || status,
            content
        }, options)
    }
    return updateAgentTaskProgress(db, task, {
        status,
        summary: options.summary ?? task.summary ?? content,
        lastObservation: options.lastObservation ?? task.lastObservation ?? content,
        completedAt: ['completed', 'blocked', 'cancelled'].includes(status) ? getDBTimestamp() : ''
    }, options)
}
