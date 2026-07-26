import { classifyToolCallRisk } from './agent_policy.js'
import { formatPendingActionHint, formatPendingTtl, savePendingAction } from './pending_actions.js'

const SELF_MANAGED_CONFIRMATION_TOOLS = new Set([
    'shell_exec',
    'shell_session',
    'group_send_message',
    'group_leave'
])

const TOOL_ACTION_LABELS = {
    group_mute: '群成员禁言/解禁',
    group_whole_mute: '全员禁言设置',
    group_kick: '踢出群成员',
    group_request_handle: '处理加群申请'
}

export function getToolActionLabel(toolName = '') {
    return TOOL_ACTION_LABELS[toolName] || toolName || '高风险工具操作'
}

function validateFrozenHighRiskArgs(toolName, args = {}) {
    if (['group_mute', 'group_kick'].includes(toolName)) {
        if (!/^\d{5,}$/.test(String(args.user_id || '').trim())) {
            return { ok: false, error: `${getToolActionLabel(toolName)}需要先解析并固定目标 QQ 号，不能在确认后再根据“他/那个人”重新猜目标。` }
        }
    }
    if (toolName === 'group_request_handle' && !/^\d{5,}$/.test(String(args.user_id || '').trim())) {
        return { ok: false, error: '处理加群申请前需要先固定申请人 QQ 号，不能在确认阶段重新选择申请记录。' }
    }
    if (toolName === 'group_whole_mute' && typeof args.enable !== 'boolean') {
        return { ok: false, error: '全员禁言操作必须明确 enable=true 或 enable=false。' }
    }
    return { ok: true }
}

export async function applyToolExecutionPolicy(name, args = {}, context = {}) {
    const risk = classifyToolCallRisk({ name, args })
    if (risk !== 'high' || context.confirmedPendingAction === true || SELF_MANAGED_CONFIRMATION_TOOLS.has(name)) {
        return { allowed: true, risk }
    }

    const frozenArgs = validateFrozenHighRiskArgs(name, args)
    if (!frozenArgs.ok) return { allowed: false, risk, error: frozenArgs.error }

    const userId = String(context.userId || context.event?.user_id || '').trim()
    if (!userId) return { allowed: false, risk, error: '无法识别操作发起者，已阻止高风险工具执行。' }

    const saveResult = await savePendingAction(userId, {
        type: 'tool_call',
        toolName: name,
        actionLabel: getToolActionLabel(name),
        agentTaskId: context.agentTaskId || '',
        args: { ...args },
        groupId: String(context.groupId || context.event?.group_id || ''),
        userMessage: context.userMessage || context.originalUserMessage || '',
        risk
    })
    if (!saveResult.ok) return { allowed: false, risk, error: saveResult.error }

    return {
        allowed: false,
        pending: true,
        risk,
        data: {
            ok: true,
            pending: true,
            needs_confirmation: true,
            centrallyManagedPending: true,
            toolName: name,
            actionLabel: getToolActionLabel(name),
            args: { ...args },
            risk,
            pendingId: saveResult.record.id,
            expiresAt: saveResult.record.expiresAt,
            confirmationHint: formatPendingActionHint(),
            summary: `${getToolActionLabel(name)}等待明确确认`
        }
    }
}

export function formatCentralPendingToolResult(data = {}) {
    const argsText = JSON.stringify(data.args || {})
    return `\n\n【高风险工具待确认】${data.actionLabel || getToolActionLabel(data.toolName)}尚未执行。\n风险: ${data.risk || 'high'}\n参数: ${argsText}\n请在 ${formatPendingTtl(data)} 内回复「#c确认执行」或「#c取消」。\n${data.confirmationHint || formatPendingActionHint()}`
}

export function validatePendingToolCallScene(pending = {}, event = {}) {
    if (pending.type !== 'tool_call' || !pending.toolName) return { ok: false, error: '待确认工具记录不完整。' }
    if (pending.userId && String(event.user_id || '') !== String(pending.userId)) {
        return { ok: false, error: '当前用户不是这项待确认操作的原发起者。' }
    }
    if (pending.groupId && String(event.group_id || '') !== String(pending.groupId)) {
        return { ok: false, error: `这项高风险操作绑定在群 ${pending.groupId}，只能回到原群确认执行。`, wrongScene: true }
    }
    return { ok: true }
}

export async function executeConfirmedPendingToolCall(pending = {}, event = {}, registry) {
    const scene = validatePendingToolCallScene(pending, event)
    if (!scene.ok) return { success: false, error: scene.error, wrongScene: scene.wrongScene === true }
    if (!registry?.execute) return { success: false, error: '工具注册表不可用。' }
    return registry.execute(pending.toolName, pending.args || {}, event.isMaster === true, {
        event,
        userId: event.user_id,
        groupId: event.group_id || '',
        userMessage: pending.userMessage || '',
        originalUserMessage: pending.userMessage || '',
        agentTaskId: pending.agentTaskId || '',
        confirmedPendingAction: true
    })
}
