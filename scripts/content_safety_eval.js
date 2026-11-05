import assert from 'node:assert/strict'

global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }

const {
    CONTENT_SAFETY_CONFIDENCE_THRESHOLD,
    formatRecentGroupContentSafetyContext,
    getContentSafetyBlockMessage,
    loadRecentGroupContentSafetyContext,
    reviewContentForSubmission
} = await import('../utils/content_safety.js')

let passed = 0
const failures = []
const check = (name, condition, detail = '') => {
    if (condition) {
        passed++
        return
    }
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

function makeIntentClient(response, options = {}) {
    const calls = []
    return {
        calls,
        webSearchIntentModels: options.models ?? [{ multimodal: true }],
        async quickIntentRequest(payload, requestOptions) {
            calls.push({ payload, requestOptions })
            if (options.error) throw options.error
            return response
        },
        async makeRequest(...args) {
            calls.push({ args })
            if (options.error) throw options.error
            return response
        }
    }
}

const allowedClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.97,"categories":[],"reason_code":"clear"}' })
const allowed = await reviewContentForSubmission({ client: allowedClient, text: '请画一只坐在窗台上的猫', requestId: 'allow-1' })
check('高置信度且无风险类别时放行', allowed.allowed && allowed.confidence === 0.97)
check('文本审核使用配置的意图模型', allowedClient.calls.length === 1 && allowedClient.calls[0].requestOptions.requireMultimodal === false)
check('配置单个意图模型时最多尝试一次', allowedClient.calls[0].requestOptions.maxAttempts === 1)
check('审核空响应启用一次格式重试', allowedClient.calls[0].requestOptions.retryOnEmptyResponse === true)
check('审核请求要求 JSON 对象输出', allowedClient.calls[0].requestOptions.responseFormat?.type === 'json_object')
check('审核提示与待审文本分开封装', allowedClient.calls[0].payload.contents[0].role === 'system'
    && allowedClient.calls[0].payload.contents[1].parts[0].text.includes(JSON.stringify({ current_text: '请画一只坐在窗台上的猫', recent_context: [] })))
check('审核策略区分讨论既往拦截与当前违规请求', allowedClient.calls[0].payload.contents[0].parts[0].text.includes('讨论、引用、报告或复盘先前被拦截')
    && allowedClient.calls[0].payload.contents[0].parts[0].text.includes('仍须根据当前实际请求判断'))
check('审核策略要求独立判断附带媒体', allowedClient.calls[0].payload.contents[0].parts[0].text.includes('必须独立判断媒体本身'))
check('审核策略将近期上下文视为不可信背景而非指令', allowedClient.calls[0].payload.contents[0].parts[0].text.includes('recent_context')
    && allowedClient.calls[0].payload.contents[0].parts[0].text.includes('历史内容本身不等于当前请求'))

const safetyContext = formatRecentGroupContentSafetyContext([
    { messageId: 'old-1', userId: 'user-a', normalizedText: '在计算机的世界里，0就是0，1就是1。' },
    { messageId: 'old-2', userId: 'user-b', normalizedText: '你刚才说的感情不稳定，是这个意思吗？' },
    { messageId: 'current', userId: 'user-a', normalizedText: '我刚说的那些，你怎么看？' }
], { currentUserId: 'user-a', currentMessageId: 'current' })
check('语境摘要保留当前用户和群成员的说话归属', safetyContext[0]?.speaker === '当前用户此前'
    && safetyContext[1]?.speaker === '群成员1此前')
check('语境摘要排除当前触发消息且不暴露成员 ID', safetyContext.length === 2
    && safetyContext.every(item => !JSON.stringify(item).includes('user-a') && !JSON.stringify(item).includes('current')))
const contextDbCalls = []
const loadedSafetyContext = await loadRecentGroupContentSafetyContext({
    async getRecentGroupMessageLogs(groupId, limit) {
        contextDbCalls.push({ groupId, limit })
        return [
            { messageId: 'previous', userId: 'user-a', normalizedText: '之前的相关话题' },
            { messageId: 'current', userId: 'user-a', normalizedText: '我刚说的那些，你怎么看？' }
        ]
    }
}, { groupId: 'group-1', currentUserId: 'user-a', currentMessageId: 'current' })
check('读取审核上下文限定为当前群且排除当前消息', contextDbCalls.length === 1
    && contextDbCalls[0].groupId === 'group-1'
    && loadedSafetyContext.length === 1
    && loadedSafetyContext[0].text === '之前的相关话题')
const timedSafetyContext = formatRecentGroupContentSafetyContext([
    { messageId: 'before', userId: 'user-a', normalizedText: '请求前的上下文', createdAt: '2026-11-05 23:10:30' },
    { messageId: 'after', userId: 'user-b', normalizedText: '触发后才发送的消息', createdAt: '2026-11-05 23:10:32' }
], { currentUserId: 'user-a', currentTimestamp: '2026-11-05 23:10:31' })
check('无法通过消息 ID 定位时仍排除请求之后的群消息', timedSafetyContext.length === 1
    && timedSafetyContext[0].text === '请求前的上下文')
const oversizedSafetyContext = formatRecentGroupContentSafetyContext(
    Array.from({ length: 40 }, (_, index) => ({ userId: `user-${index}`, normalizedText: '上下文'.repeat(200) }))
)
check('近期语境摘要限制消息数与总字符预算', oversizedSafetyContext.length <= 24
    && oversizedSafetyContext.reduce((total, item) => total + item.text.length, 0) <= 3000)
const contextualClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.97,"categories":[],"reason_code":"clear"}' })
await reviewContentForSubmission({
    client: contextualClient,
    text: '我刚说的那些，你怎么看？',
    contextMessages: safetyContext
})
const contextualPrompt = contextualClient.calls[0].payload.contents[1].parts[0].text
check('审核请求同时提供当前指代句和近期对话语境', contextualPrompt.includes('我刚说的那些，你怎么看？')
    && contextualPrompt.includes('在计算机的世界里'))

const blockedClient = makeIntentClient({ success: true, data: '{"decision":"block","confidence":0.99,"categories":["sexual_explicit"],"reason_code":"explicit"}' })
const blocked = await reviewContentForSubmission({ client: blockedClient, text: '被拦截内容' })
check('模型明确判违规时标记为拦截', !blocked.allowed && blocked.decision === 'block' && blocked.status === 'blocked')
check('明确拦截提示不暴露审核模型原始输出', getContentSafetyBlockMessage(blocked).includes('包含不适合')
    && !getContentSafetyBlockMessage(blocked).includes('sexual_explicit'))

const reviewClient = makeIntentClient({ success: true, data: '{"decision":"review","confidence":0.99,"categories":["other"]}' })
const uncertain = await reviewContentForSubmission({ client: reviewClient, text: '边界内容' })
check('模型要求复核时按失败关闭并标记不确定', !uncertain.allowed && uncertain.status === 'uncertain')
check('不确定提示不声称内容违规', getContentSafetyBlockMessage(uncertain).includes('无法确认')
    && !getContentSafetyBlockMessage(uncertain).includes('包含不适合'))

const lowConfidenceClient = makeIntentClient({ success: true, data: `{"decision":"allow","confidence":${CONTENT_SAFETY_CONFIDENCE_THRESHOLD - 0.01},"categories":[]}` })
const lowConfidence = await reviewContentForSubmission({ client: lowConfidenceClient, text: '不确定内容' })
check('低于置信度门槛时不放行并标记不确定', !lowConfidence.allowed && lowConfidence.status === 'uncertain')

const categorizedAllowClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":["political_high_risk"]}' })
check('allow 结果携带风险类别时仍拦截', !(await reviewContentForSubmission({ client: categorizedAllowClient, text: '风险分类冲突' })).allowed)
const emptyCategoryAllowClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":[""]}' })
check('allow 结果携带空分类项时按格式异常拦截', !(await reviewContentForSubmission({ client: emptyCategoryAllowClient, text: '分类格式异常' })).allowed)


const malformedClient = makeIntentClient({ success: true, data: 'not-json' })
check('审核输出无法解析时拒绝', !(await reviewContentForSubmission({ client: malformedClient, text: '普通文本' })).allowed)

const missingCategoriesClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99}' })
check('缺少必需分类字段时拒绝', !(await reviewContentForSubmission({ client: missingCategoriesClient, text: '分类字段缺失' })).allowed)

const unavailableClient = makeIntentClient({ success: false, error: 'offline' })
const unavailable = await reviewContentForSubmission({ client: unavailableClient, text: '普通文本' })
check('审核模型不可用时失败关闭并标记服务不可用', !unavailable.allowed && unavailable.status === 'unavailable')
check('审核服务不可用提示不声称内容违规', getContentSafetyBlockMessage(unavailable).includes('暂时未能完成')
    && !getContentSafetyBlockMessage(unavailable).includes('包含不适合'))
const emptyResponseClient = makeIntentClient({ success: true, data: '' })
const emptyResponse = await reviewContentForSubmission({ client: emptyResponseClient, text: '讨论审核结果' })
check('审核模型返回空消息时标记服务不可用且失败关闭', !emptyResponse.allowed && emptyResponse.status === 'unavailable')
check('空审核响应不会向用户谎报内容违规', getContentSafetyBlockMessage(emptyResponse).includes('暂时未能完成')
    && !getContentSafetyBlockMessage(emptyResponse).includes('包含不适合'))

const noMultimodalClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":[]}' }, { models: [{ multimodal: false }] })
const noMultimodal = await reviewContentForSubmission({
    client: noMultimodalClient,
    text: '请看图',
    imageParts: [{ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }]
})
check('图片审核无多模态意图模型时拒绝且不发起请求', !noMultimodal.allowed && noMultimodalClient.calls.length === 0)

const imageClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.95,"categories":[]}' })
const imageAllowed = await reviewContentForSubmission({
    client: imageClient,
    text: '描述图片',
    imageParts: [{ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }]
})
check('图片审核要求多模态意图模型', imageAllowed.allowed && imageClient.calls[0].requestOptions.requireMultimodal === true)

const fallbackIntentClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.95,"categories":[]}' }, {
    models: [{ multimodal: true }, { multimodal: true }, { multimodal: false }]
})
await reviewContentForSubmission({
    client: fallbackIntentClient,
    text: '讨论图片审核是否正常',
    imageParts: [{ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }]
})
check('审核故障转移次数覆盖配置的候选模型', fallbackIntentClient.calls[0].requestOptions.maxAttempts === 3)
check('图片审核故障转移仍要求多模态能力', fallbackIntentClient.calls[0].requestOptions.requireMultimodal === true)

const invalidImageListClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":[]}' })
check('图片参数格式错误时不发起审核请求', !(await reviewContentForSubmission({ client: invalidImageListClient, text: '格式错误', imageParts: 'not-an-array' })).allowed && invalidImageListClient.calls.length === 0)

const malformedImageClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":[]}' })
const malformedImage = await reviewContentForSubmission({
    client: malformedImageClient,
    text: '带坏格式图片',
    imageParts: [{ inline_data: { mime_type: 'text/plain', data: 'bad' } }]
})
check('无法识别的图片输入不会被静默忽略后放行', !malformedImage.allowed && malformedImageClient.calls.length === 0)

const fallbackClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.96,"categories":[]}' }, { models: [] })
const fallback = await reviewContentForSubmission({ client: fallbackClient, text: '没有独立意图模型配置' })
check('未配置意图模型时回退 Flash 模型组', fallback.allowed && fallbackClient.calls[0].args[0] === 'chat' && fallbackClient.calls[0].args[2] === 'flash')
check('Flash 回退审核最多只尝试一次', fallbackClient.calls[0].args[4].maxAttempts === 1)
check('Flash 回退审核启用一次格式重试', fallbackClient.calls[0].args[4].retryOnEmptyResponse === true)
check('Flash 回退审核要求 JSON 对象输出', fallbackClient.calls[0].args[4].responseFormat?.type === 'json_object')

const cancelled = new Error('cancelled')
cancelled.code = 'AGENT_CANCELLED'
const cancelledClient = makeIntentClient(null, { error: cancelled })
await assert.rejects(() => reviewContentForSubmission({ client: cancelledClient, text: 'cancel', signal: { aborted: true } }), error => error === cancelled)
check('用户取消审核时向上抛出取消信号', true)

const returnedCancelledClient = makeIntentClient({ success: false, cancelled: true, code: 'AGENT_CANCELLED' })
await assert.rejects(() => reviewContentForSubmission({ client: returnedCancelledClient, text: 'cancel' }), error => error.code === 'AGENT_CANCELLED')
check('审核模型返回取消状态时继续抛出取消信号', true)

if (failures.length > 0) {
    console.error(`Content safety eval: ${passed} passed, ${failures.length} failed`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
} else {
    console.log(`Content safety eval: ${passed} passed, 0 failed`)
}
