global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const {
    filterToolCallsByIntent,
    hasExplicitMemorySearchIntent,
    hasExplicitLocalFileMutationIntent,
    hasExplicitLocalFileReadIntent,
    hasExplicitFileSendIntent,
    hasExplicitGroupChatContextIntent,
    hasExplicitShellIntent,
    hasExplicitUserProfileHistoryExtractionIntent,
    hasExplicitUserProfileUpdateIntent,
    hasGroupChatContextQuestion,
    hasStrongGroupChatContextQuestion,
    parseGroupLeaveRequest,
    parseGroupSendRequest,
    parseExplicitLocalFileReadRequest
} = await import('../utils/tool_intent.js')
const { classifyAgentRisk, classifyToolCallRisk, decideAgentContinuation, normalizeAgentPlan, summarizeDeterministicAgentRound } = await import('../utils/agent_policy.js')
const { buildFinalAnswerRetryInstruction, isPlanOnlyResponse, sanitizeModelOutput } = await import('../utils/model_output.js')
const { isExpiredGroupContextImageUrl, isGroupContextImageQuestion } = await import('../utils/group_context_images.js')
const { toolRegistry } = await import('../tools/registry.js')
const { configManageTool } = await import('../tools/config_manage.js')

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
    },
    {
        name: '指定配置文件读取不会误判群列表',
        text: '#c你看一下/root/Yunzai/config/config/group.yaml是不是有7100什么的群',
        assert: text => parseExplicitLocalFileReadRequest(text)?.path === '/root/Yunzai/config/config/group.yaml' && !hasExplicitGroupChatContextIntent(text)
    },
    {
        name: '明确询问机器人群列表仍正常命中',
        text: '#c你加入了哪些群？',
        assert: text => hasExplicitGroupChatContextIntent(text)
    },
    {
        name: '配置写入请求命中Shell而非文件发送',
        text: '#c你能不能帮我把“[无用插件]发送图片”写到710024443群配置的disable里面',
        assert: text => hasExplicitLocalFileMutationIntent(text) && hasExplicitShellIntent(text) && !hasExplicitFileSendIntent(text)
    },
    {
        name: '询问配置修改方法不会直接执行',
        text: '#c这个配置应该怎么修改？',
        assert: text => !hasExplicitLocalFileMutationIntent(text)
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

const configMutationText = '#c你能不能帮我把“[无用插件]发送图片”写到710024443群配置的disable里面'
const allowedConfigMutation = filterToolCallsByIntent(
    [{ name: 'shell_exec', args: { command: 'python3 update_group_config.py' } }],
    configMutationText
)
check('安全过滤允许明确配置写入Shell调用', allowedConfigMutation.tools.length === 1 && allowedConfigMutation.blocked.length === 0)

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
check('无工具纠正提示禁止伪造执行结果', buildFinalAnswerRetryInstruction({ hasActualToolResults: false }).includes('本轮没有执行任何工具'))
check('有工具纠正提示限定系统结果区块', buildFinalAnswerRetryInstruction({ hasActualToolResults: true }).includes('由系统注入的工具结果区块'))
check('代码中出现图片字样不会误触发历史读图', !isGroupContextImageQuestion("dsc: '发送随机图片'"))
check('明确询问刚才图片会触发历史读图', isGroupContextImageQuestion('刚才那张图里写了什么？'))
check('过期QQ临时图片链接会被跳过', isExpiredGroupContextImageUrl('https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=test', '2026-07-26 14:00:00', Date.parse('2026-07-26T14:10:01Z')))

check('只读Shell被识别为低风险', classifyToolCallRisk({ name: 'shell_exec', args: { command: "cat -- '/root/Yunzai/config/config/group.yaml'" } }) === 'low')
check('结构化配置更新被识别为中风险', classifyToolCallRisk({ name: 'config_manage', args: { action: 'update' } }) === 'medium')
check('破坏性Shell被识别为高风险', classifyToolCallRisk({ name: 'shell_exec', args: { command: 'rm -rf /tmp/example' } }) === 'high')
check('sudo破坏性Shell仍被识别为高风险', classifyToolCallRisk({ name: 'shell_exec', args: { command: 'sudo rm -rf /tmp/example' } }) === 'high')
check('混合工具风险取最高级', classifyAgentRisk([
    { name: 'config_manage', args: { action: 'get' } },
    { name: 'group_kick', args: { user_id: '1' } }
]) === 'high')

let compilerCalls = 0
const directPlan = await toolRegistry.compileToolPlan({
    need_tools: true,
    reason: '更新群配置',
    resolved_request: '把插件加入指定群的 disable 列表',
    tool_plan: [{
        tool: 'config_manage',
        params: {
            action: 'update',
            path: '/root/Yunzai/config/config/group.yaml',
            key_path: '710024443.disable',
            operation: 'append',
            value: '[无用插件]发送图片'
        }
    }]
}, {
    webSearchIntentModels: [],
    async makeRequest() {
        compilerCalls++
        return { success: false }
    }
}, ['config_manage'], {
    currentInstruction: '帮我把“[无用插件]发送图片”写到 /root/Yunzai/config/config/group.yaml 里 710024443 的 disable 里面'
})
check('主模型完整参数可跳过二次编译', compilerCalls === 0 && directPlan.routedBy === 'main_model_direct' && directPlan.tools.length === 1, JSON.stringify(directPlan))

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-config-eval-'))
const yamlPath = path.join(tempDir, 'group.yaml')
await fs.writeFile(yamlPath, '# 保留这条注释\n710024443:\n  disable:\n    - existing\n', 'utf8')
const updateResult = await configManageTool.execute({
    action: 'update',
    path: yamlPath,
    key_path: '710024443.disable',
    operation: 'append',
    value: '[无用插件]发送图片',
    backup: false
})
const firstContent = await fs.readFile(yamlPath, 'utf8')
check('结构化YAML更新成功并验证', updateResult.ok && updateResult.changed && updateResult.verified, JSON.stringify(updateResult))
check('结构化YAML更新保留注释', firstContent.includes('# 保留这条注释'), firstContent)
const idempotentResult = await configManageTool.execute({
    action: 'update',
    path: yamlPath,
    key_path: '710024443.disable',
    operation: 'append',
    value: '[无用插件]发送图片',
    backup: false
})
check('结构化列表追加具备幂等性', idempotentResult.ok && !idempotentResult.changed && idempotentResult.verified, JSON.stringify(idempotentResult))
const deterministicSummary = summarizeDeterministicAgentRound([{
    tool: 'config_manage',
    args: { action: 'update' },
    status: 'ok',
    data: updateResult
}])
check('结构化配置结果无需LLM即可确定完成', deterministicSummary?.completionStatus === 'ready', JSON.stringify(deterministicSummary))
await fs.rm(tempDir, { recursive: true, force: true })

console.log(`\nAgent eval: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
