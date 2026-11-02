import assert from 'node:assert/strict'

global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }

const {
    CONTENT_SAFETY_CONFIDENCE_THRESHOLD,
    getContentSafetyBlockMessage,
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
check('配置意图模型审核最多只尝试一次', allowedClient.calls[0].requestOptions.maxAttempts === 1)
check('审核提示与待审文本分开封装', allowedClient.calls[0].payload.contents[0].role === 'system'
    && allowedClient.calls[0].payload.contents[1].parts[0].text.includes(JSON.stringify('请画一只坐在窗台上的猫')))

const blockedClient = makeIntentClient({ success: true, data: '{"decision":"block","confidence":0.99,"categories":["sexual_explicit"],"reason_code":"explicit"}' })
const blocked = await reviewContentForSubmission({ client: blockedClient, text: '被拦截内容' })
check('模型明确判违规时拦截', !blocked.allowed && blocked.decision === 'block')
check('拒绝提示不暴露审核模型原始输出', !getContentSafetyBlockMessage().includes('sexual_explicit'))

const reviewClient = makeIntentClient({ success: true, data: '{"decision":"review","confidence":0.99,"categories":["other"]}' })
check('模型要求人工复核时按失败关闭', !(await reviewContentForSubmission({ client: reviewClient, text: '边界内容' })).allowed)

const lowConfidenceClient = makeIntentClient({ success: true, data: `{"decision":"allow","confidence":${CONTENT_SAFETY_CONFIDENCE_THRESHOLD - 0.01},"categories":[]}` })
check('低于置信度门槛时不放行', !(await reviewContentForSubmission({ client: lowConfidenceClient, text: '不确定内容' })).allowed)

const categorizedAllowClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":["political_high_risk"]}' })
check('allow 结果携带风险类别时仍拦截', !(await reviewContentForSubmission({ client: categorizedAllowClient, text: '风险分类冲突' })).allowed)
const emptyCategoryAllowClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99,"categories":[""]}' })
check('allow 结果携带空分类项时按格式异常拦截', !(await reviewContentForSubmission({ client: emptyCategoryAllowClient, text: '分类格式异常' })).allowed)


const malformedClient = makeIntentClient({ success: true, data: 'not-json' })
check('审核输出无法解析时拒绝', !(await reviewContentForSubmission({ client: malformedClient, text: '普通文本' })).allowed)

const missingCategoriesClient = makeIntentClient({ success: true, data: '{"decision":"allow","confidence":0.99}' })
check('缺少必需分类字段时拒绝', !(await reviewContentForSubmission({ client: missingCategoriesClient, text: '分类字段缺失' })).allowed)

const unavailableClient = makeIntentClient({ success: false, error: 'offline' })
check('审核模型不可用时拒绝', !(await reviewContentForSubmission({ client: unavailableClient, text: '普通文本' })).allowed)

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
