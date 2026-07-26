global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }

const {
    filterToolCallsByIntent,
    hasExplicitMemorySearchIntent,
    hasExplicitLocalFileReadIntent,
    hasExplicitShellIntent,
    hasExplicitUserProfileHistoryExtractionIntent,
    hasExplicitUserProfileUpdateIntent,
    hasGroupChatContextQuestion,
    hasStrongGroupChatContextQuestion,
    parseGroupLeaveRequest,
    parseGroupSendRequest
} = await import('../utils/tool_intent.js')
const { decideAgentContinuation, normalizeAgentPlan } = await import('../utils/agent_policy.js')
const { isPlanOnlyResponse, sanitizeModelOutput } = await import('../utils/model_output.js')
const { toolRegistry } = await import('../tools/registry.js')

const failures = []
let passed = 0

function check(name, condition, detail = '') {
    if (condition) {
        passed++
        console.log(`✓ ${name}`)
        return
    }
    failures.push({ name, detail })
    console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`)
}

const routingCases = [
    {
        name: 'Git变更记录走Shell而不是群聊',
        text: '#c看一下最近16条git变更记录',
        assert: text => hasExplicitShellIntent(text) && !hasGroupChatContextQuestion(text) && !hasStrongGroupChatContextQuestion(text)
    },
    {
        name: '群聊前情问题命中强群聊语义',
        text: '#c他们刚才聊了啥',
        assert: text => !hasExplicitShellIntent(text) && hasStrongGroupChatContextQuestion(text)
    },
    {
        name: '模糊记录请求不被强行路由',
        text: '#c最近16条记录',
        assert: text => !hasExplicitShellIntent(text) && !hasGroupChatContextQuestion(text)
    },
    {
        name: '询问个人档案不会误写档案',
        text: '#c我的个人档案有写我的居住城市吗？',
        assert: text => !hasExplicitUserProfileUpdateIntent(text)
    },
    {
        name: '明确从历史提炼档案会命中更新',
        text: '#c从最近聊天历史提炼我的个人档案',
        assert: text => hasExplicitUserProfileUpdateIntent(text) && hasExplicitUserProfileHistoryExtractionIntent(text)
    },
    {
        name: '明确历史检索命中语义记忆',
        text: '#c历史里查一下我以前说过的居住城市',
        assert: text => hasExplicitMemorySearchIntent(text)
    },
    {
        name: '查看相对脚本字段命中Shell',
        text: '#c看下sendimage.js的tag名称是什么',
        assert: text => hasExplicitLocalFileReadIntent(text) && hasExplicitShellIntent(text)
    },
    {
        name: '普通提及脚本名不会误触发Shell',
        text: '#csendimage.js这个名字挺直观的',
        assert: text => !hasExplicitLocalFileReadIntent(text) && !hasExplicitShellIntent(text)
    }
]

for (const item of routingCases) check(item.name, item.assert(item.text), item.text)

const sendRequest = parseGroupSendRequest('帮我在测试群发一句：今晚维护')
check('明确群代发可解析目标和正文', Boolean(sendRequest?.target && sendRequest?.message), JSON.stringify(sendRequest))
check('讨论代发能力不会解析成执行', !parseGroupSendRequest('你能帮我代发群消息吗？'))

const forbiddenLeave = parseGroupLeaveRequest('退出所有群')
check('开放式退群集合必须拒绝解析', !forbiddenLeave || forbiddenLeave.forbidden_set === true, JSON.stringify(forbiddenLeave))

const guarded = filterToolCallsByIntent(
    [{ name: 'group_send_message', args: { target: '测试群', message: '今晚维护' } }],
    '你能帮我代发群消息吗？'
)
check('安全过滤拦截非执行式高风险调用', guarded.tools.length === 0 && guarded.blocked.length === 1)

const multiPlan = normalizeAgentPlan({
    task_kind: 'multi_step',
    success_criteria: ['拿到实际状态', '根据状态给出结论']
})
check('多步计划自动要求执行后复核', multiPlan.requiresFollowupCheck && multiPlan.successCriteria.length === 2)

const tolerantPlan = normalizeAgentPlan({
    task_kind: 'multi-step',
    requires_followup_check: 'true',
    success_criteria: '验证最终结果'
})
check('规划元数据兼容常见模型格式偏差', tolerantPlan.taskKind === 'multi_step' && tolerantPlan.requiresFollowupCheck && tolerantPlan.successCriteria.length === 1)

const continueAfterFailure = decideAgentContinuation({
    completionStatus: 'continue',
    executedCount: 0,
    observationCount: 1
})
check('可恢复失败允许调整方案继续', continueAfterFailure.shouldContinue, continueAfterFailure.reason)

const readyDecision = decideAgentContinuation({
    completionStatus: 'ready',
    executedCount: 1,
    observationCount: 1,
    planRequiresFollowup: false,
    heuristicRequestsContinuation: true
})
check('观察器确认完成后不会被启发式强行续跑', !readyDecision.shouldContinue, readyDecision.reason)

const forcedVerification = decideAgentContinuation({
    completionStatus: 'ready',
    executedCount: 1,
    observationCount: 1,
    planRequiresFollowup: true
})
check('多步计划在成功标准未复核前继续规划', forcedVerification.shouldContinue, forcedVerification.reason)

const waitingDecision = decideAgentContinuation({
    completionStatus: 'waiting',
    executedCount: 1,
    observationCount: 1,
    planRequiresFollowup: true
})
check('等待确认状态必须停止自动执行', !waitingDecision.shouldContinue, waitingDecision.reason)

const cityHints = toolRegistry._extractWeatherCityHints(
    '诺亚帮我查一下天气',
    '基本信息：目前工作和生活的城市是广东中山，在三乡镇。',
    []
)
check('天气工具能从个人档案提取城市', cityHints.includes('中山'), JSON.stringify(cityHints))

check('标准think标签会被清除', sanitizeModelOutput('<think>内部推理</think>最终答案') === '最终答案')
check('未闭合think标签不会回退泄露', sanitizeModelOutput('<think>内部推理') === '')
check('Analysis区块只保留最终答案', sanitizeModelOutput('Analysis:\n先查看文件\n\nFinal Answer:\ntag 是 image') === 'tag 是 image')
check('纯工具规划会被识别', isPlanOnlyResponse('【工具规划】查看 sendImage.js 文件内容'))
check('正常解释中的分析一词不会误删', sanitizeModelOutput('这个分析是合理的，因为已有真实结果。') === '这个分析是合理的，因为已有真实结果。')

console.log(`\nAgent eval: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
