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

const RISK_RANK = { low: 0, medium: 1, high: 2 }

function classifyShellCommandRisk(command = '') {
    const value = String(command || '').trim()
    if (!value) return 'high'
    const dynamicShellPatterns = [
        /(?:^|[;&|]\s*)(?:(?:sudo|command|nohup)\s+)*(?:env\s+(?:\w+=\S+\s+)*)?(?:bash|sh|zsh|dash|fish|ksh)\s+(?:-[^\s]*c\b|[^;&|\s]+(?:\s|$))/i,
        /(?:^|[;&|]\s*)(?:(?:sudo|command|nohup)\s+)*(?:env\s+(?:\w+=\S+\s+)*)?(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|php)\s+-(?:c|e)\b/i,
        /(?:^|[;&|]\s*)(?:(?:sudo|env)\s+)*(?:eval|source|\.)\s+/i,
        /\|\s*(?:(?:sudo|env)\s+)*(?:bash|sh|zsh|dash|fish|ksh)(?:\s|$)/i,
        /\|\s*(?:(?:sudo|env)\s+)*(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|php)\s+-(?:c|e)\b/i,
        /(?:^|[;&|]\s*)xargs\b[^;&|]*(?:bash|sh|zsh|dash|fish|ksh)\b/i,
        /\$\(|`|<\(|>\(/,
        /(?:^|[;&|]\s*)\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\b/
    ]
    if (dynamicShellPatterns.some(pattern => pattern.test(value))) return 'high'
    if (/(?:^|[;&|]\s*)(?:(?:sudo|env)\s+)*(?:rm|rmdir|shred|mkfs|fdisk|parted|dd|reboot|shutdown|poweroff|halt|kill|pkill|killall)\b/i.test(value)) return 'high'
    if (/(?:^|\s)(?:git\s+(?:reset\s+--hard|clean\s+-|push\s+--force)|chmod\s+-R|chown\s+-R)\b/i.test(value)) return 'high'
    if (/(?:>>?|\b(?:mv|cp|touch|mkdir|install|tee|truncate|sed\s+-i|perl\s+-i|git\s+(?:pull|merge|rebase|checkout|switch|commit|push)|npm\s+(?:install|update)|pnpm\s+(?:install|update)|yarn\s+(?:install|upgrade)|systemctl\s+(?:start|stop|restart|enable|disable))\b)/i.test(value)) return 'medium'

    const segments = value
        .split(/(?:&&|\|\||[;|])/)
        .map(item => item.trim())
        .filter(Boolean)
    const readOnly = /^(?:(?:sudo|env)\s+)*(?:(?:\/usr)?\/bin\/)?(?:pwd|ls|find|rg|grep|cat|head|tail|less|more|stat|file|wc|du|df|free|uname|hostname|whoami|id|echo|printf|which|whereis|type|realpath|readlink|date|uptime|ps|pgrep|ip|ss|netstat|lsof|jq|yq|awk|sed\b(?!.*\s-i)|git\s+(?:status|log|diff|show|branch|rev-parse|remote|ls-files|grep)|npm\s+(?:list|view)|pnpm\s+list|yarn\s+list)\b/i
    return segments.length > 0 && segments.every(segment => readOnly.test(segment)) ? 'low' : 'high'
}

export function classifyToolCallRisk(call = {}) {
    const name = String(call?.name || '')
    const args = call?.args || {}
    if (name === 'shell_exec') return classifyShellCommandRisk(args.command)
    if (name === 'shell_session') {
        const action = String(args.action || '').toLowerCase()
        if (action === 'send' && args.enter !== false) return classifyShellCommandRisk(args.input)
        return ['restart', 'close', 'interrupt'].includes(action) ? 'medium' : 'low'
    }
    if (name === 'config_manage') return args.action === 'update' ? 'medium' : 'low'
    if (['group_leave', 'group_kick', 'group_whole_mute', 'group_mute', 'group_request_handle'].includes(name)) return 'high'
    if (['group_send_message', 'group_set_card', 'group_set_title', 'group_essence', 'file_send', 'file_download', 'group_file_download', 'user_profile_update'].includes(name)) return 'medium'
    return 'low'
}

export function classifyAgentRisk(toolCalls = []) {
    return (toolCalls || []).reduce((highest, call) => {
        const current = classifyToolCallRisk(call)
        return RISK_RANK[current] > RISK_RANK[highest] ? current : highest
    }, 'low')
}

export function summarizeDeterministicAgentRound(observations = []) {
    if (!Array.isArray(observations) || observations.length === 0) return null
    const protocolDecision = deterministicToolDecision(observations.map(item => item?.protocol).filter(Boolean))
    if (protocolDecision) return protocolDecision
    if (!observations.every(item => item?.tool === 'config_manage')) return null

    const failed = observations.find(item => item.status !== 'ok' || item.data?.ok === false)
    if (failed) {
        const reason = failed.data?.error || failed.text || '结构化配置操作失败'
        return {
            summary: '结构化配置任务未完成。',
            lastObservation: String(reason).slice(0, 1600),
            completionStatus: failed.data?.recoverable === true ? 'continue' : 'blocked',
            nextHint: failed.data?.recoverable === true ? '根据错误修正配置路径或参数后重试。' : ''
        }
    }

    const unverifiedUpdate = observations.find(item => item.args?.action === 'update' && item.data?.verified !== true)
    if (unverifiedUpdate) {
        return {
            summary: '配置已尝试更新，但确定性校验尚未通过。',
            lastObservation: '配置工具没有返回 verified=true。',
            completionStatus: 'continue',
            nextHint: '调用 config_manage 的 validate/get 操作确认目标值和文件语法。'
        }
    }

    const changed = observations.some(item => item.data?.changed === true)
    return {
        summary: changed ? '结构化配置操作已完成并通过重新解析校验。' : '结构化配置读取或校验已完成。',
        lastObservation: observations.map(item => item.data?.summary || `${item.args?.action || '操作'}成功`).join('；').slice(0, 1600),
        completionStatus: 'ready',
        nextHint: ''
    }
}
import { deterministicToolDecision } from './tool_result.js'
