import { agentToolCallKey } from './agent_runtime.js'

function observationTool(observation = {}) {
    return String(observation.tool || observation.call?.name || '')
}

function observationArgs(observation = {}) {
    return observation.args || observation.call?.args || {}
}

function observationData(observation = {}) {
    return observation.data || observation.result?.data || {}
}

function isSuccessfulObservation(observation = {}) {
    if (observation.result && observation.result.success === false) return false
    if (observation.protocol?.ok === false) return false
    return ['ok', 'success'].includes(String(observation.status || '').toLowerCase()) || observation.protocol?.ok === true
}

export function findPendingWorkspaceVerification(observations = [], seenToolCalls = new Set()) {
    const history = Array.isArray(observations) ? observations : []
    for (let index = history.length - 1; index >= 0; index--) {
        const observation = history[index]
        if (observationTool(observation) !== 'workspace_patch' || !isSuccessfulObservation(observation)) continue
        const data = observationData(observation)
        if (data.changed === false) continue
        const path = String(data.facts?.path || observationArgs(observation).path || '').trim()
        if (!path) continue
        const verifiedLater = history.slice(index + 1).some(item => {
            if (observationTool(item) !== 'workspace_verify' || !isSuccessfulObservation(item)) return false
            const verifiedPath = String(observationData(item).facts?.path || observationArgs(item).path || '').trim()
            return verifiedPath === path && observationData(item).verified !== false
        })
        if (verifiedLater) continue
        const call = {
            name: 'workspace_verify',
            args: { path, include_git_diff: true, verification_token: `patch_${index + 1}` }
        }
        if (seenToolCalls.has(agentToolCallKey(call))) continue
        return {
            call,
            reason: `检测到 ${path} 已被修改但尚未完成确定性静态校验`,
            instruction: `代码修改闭环：先对 ${path} 执行 workspace_verify。静态校验通过后，如果原任务涉及行为修复、构建或测试，再继续选择最相关的测试命令；不得把静态校验表述为测试通过。`
        }
    }
    return null
}
