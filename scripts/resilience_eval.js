import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'

global.logger = {
    info() {},
    debug() {},
    warn() {},
    error() {}
}

const { AiClient } = await import('../client/AiClient.js')
const { Config } = await import('../utils/config.js')
const { formatTokenUsageInfo, formatUsageDiagnostic } = await import('../client/AiClient.js')

function createClient(pool) {
    const client = Object.create(AiClient.prototype)
    client.modelStatus = {}
    client.providerStatus = {}
    client.activeModelPools = { flash: { chat: pool, image: [] } }
    client.scheduleModelStatusSave = () => {}
    client._resolveRequestTimeout = () => 1000
    client._waitBeforeFailover = async () => {}
    return client
}

function model(provider, modelId, index = 0) {
    return {
        provider: { id: provider, name: provider },
        modelId,
        modelKey: `${provider}-${index}`,
        modelConfig: { multimodal: true },
        statusKey: `${provider}-${modelId}`,
        perCall: false
    }
}

async function testQuickIntentRequestForwardsStructuredOutputOptions() {
    const client = Object.create(AiClient.prototype)
    client.modelsConfig = [{ id: 'review-provider', name: 'Review Provider' }]
    Object.defineProperty(client, 'webSearchIntentModels', {
        value: [{ id: 'review-model', model_id: 'review-model', provider_id: 'review-provider', multimodal: true }]
    })
    client._recordModelSuccess = () => {}
    client._recordProviderSuccess = () => {}
    client.scheduleModelStatusSave = () => {}
    let capturedRequestOptions = null
    client.attemptRequest = async (...args) => {
        capturedRequestOptions = args[7]
        return { success: true, data: '{"decision":"allow"}' }
    }

    const responseFormat = { type: 'json_object' }
    const result = await client.quickIntentRequest({ contents: [] }, {
        requireMultimodal: true,
        maxAttempts: 1,
        responseFormat
    })

    assert.equal(result.success, true)
    assert.equal(capturedRequestOptions.requireMultimodal, true)
    assert.deepEqual(capturedRequestOptions.responseFormat, responseFormat)
}

async function testQuickIntentRequestRetriesOneEmptyResponse() {
    const client = Object.create(AiClient.prototype)
    client.modelsConfig = [{ id: 'review-provider', name: 'Review Provider' }]
    Object.defineProperty(client, 'webSearchIntentModels', {
        value: [{ id: 'review-model', model_id: 'review-model', provider_id: 'review-provider', multimodal: true }]
    })
    client._recordModelSuccess = () => {}
    client._recordProviderSuccess = () => {}
    client.scheduleModelStatusSave = () => {}
    const calls = []
    client.attemptRequest = async (...args) => {
        calls.push(args)
        return calls.length === 1
            ? { success: false, error: 'API业务错误: AI返回了空消息' }
            : { success: true, data: '{"decision":"review"}' }
    }

    const result = await client.quickIntentRequest({
        contents: [{ role: 'system', parts: [{ text: '审核规则' }] }]
    }, {
        maxAttempts: 1,
        retryOnEmptyResponse: true,
        responseFormat: { type: 'json_object' }
    })

    assert.equal(result.success, true)
    assert.equal(calls.length, 2)
    assert.match(calls[1][1].contents[0].parts.at(-1).text, /重新判断并直接返回完整 JSON 对象/)
}

function testWhitespaceChatResponseIsRejected() {
    const client = Object.create(AiClient.prototype)
    const result = client.parseResponse({
        choices: [{ message: { content: '   ' } }]
    }, 'chat')
    assert.equal(result.success, false)
    assert.match(result.error, /AI返回了空消息/)
}

function testChatReasoningIsNotExposedInParsedOutput() {
    const client = Object.create(AiClient.prototype)
    const parsed = client.parseResponse({
        choices: [{ message: { content: '面向用户的答复', reasoning_content: '内部推理内容' } }]
    }, 'chat')
    assert.equal(parsed.data, '面向用户的答复')
    assert.equal(Object.hasOwn(parsed, 'reasoning'), false)

    const streamed = client.parseStreamResponse([
        'data: {"choices":[{"delta":{"content":"答复","reasoning_content":"内部推理"}}]}',
        'data: [DONE]'
    ].join('\n'), 'chat')
    assert.deepEqual(streamed.choices[0].message, { content: '答复' })
}

async function testUsageTrackingIsolatedPerConcurrentRequest() {
    const client = Object.create(AiClient.prototype)
    const [first, second] = await Promise.all([
        client.withUsageTracking(async () => {
            client._recordTrackedUsage({ prompt_tokens: 12000, completion_tokens: 200 })
            await new Promise(resolve => setTimeout(resolve, 5))
            client._recordTrackedUsage({ input_tokens: 200, output_tokens: 56 })
            return client.getCurrentUsageSnapshot()
        }),
        client.withUsageTracking(async () => {
            client._recordTrackedUsage({ prompt_tokens: 700, completion_tokens: 90 })
            return client.getCurrentUsageSnapshot()
        })
    ])
    assert.equal(first.prompt_tokens, 12200)
    assert.equal(first.completion_tokens, 256)
    assert.equal(first.calls, 2)
    assert.equal(first.missingUsageCalls, 0)
    assert.equal(second.prompt_tokens, 700)
    assert.equal(second.completion_tokens, 90)
    assert.equal(second.calls, 1)
    assert.equal(formatTokenUsageInfo(first, { prompt_tokens: 200, completion_tokens: 56 }), ' | 总输入Tokens: 12200(200) | 总输出Tokens: 256(56)')
    assert.equal(formatTokenUsageInfo({ prompt_tokens: 29856, completion_tokens: 997, total_tokens: 30853, promptReportedCalls: 2, completionReportedCalls: 2, calls: 2, missingUsageCalls: 0 }, { prompt_tokens: 12200, completion_tokens: 256 }), ' | 总输入Tokens: 29856(12200) | 总输出Tokens: 997(256)')
    assert.equal(formatTokenUsageInfo(null, { prompt_tokens: 12, completion_tokens: 3 }), ' | 输入Tokens: 12 | 输出Tokens: 3')
    assert.equal(formatTokenUsageInfo(null, { total_tokens: 15 }), ' | 消耗Token: 15')
    assert.equal(formatUsageDiagnostic({
        prompt_tokens: 100,
        completion_tokens: 20,
        output_tokens_details: { reasoning_tokens: 13 }
    }), 'usage_prompt_tokens=100, usage_completion_tokens=20, reasoning_tokens=13')
    assert.equal(formatUsageDiagnostic({ output_tokens: 8 }), 'usage_prompt_tokens=?, usage_completion_tokens=8')
    assert.equal(formatUsageDiagnostic(null), '')

    const partial = await client.withUsageTracking(async () => {
        client._recordTrackedUsage({ total_tokens: 24 })
        return client.getCurrentUsageSnapshot()
    })
    assert.equal(formatTokenUsageInfo(partial, { total_tokens: 24 }), ' | 已报告总Tokens: 24(24)（另有 1 次模型请求未返回完整输入/输出用量）')

    const missing = await client.withUsageTracking(async () => {
        client._recordTrackedUsage(null)
        return client.getCurrentUsageSnapshot()
    })
    assert.equal(formatTokenUsageInfo(missing, { prompt_tokens: 4, completion_tokens: 2 }), ' | 已统计输入Tokens: 4(4) | 已统计输出Tokens: 2(2)（另有 1 次模型请求未返回完整输入/输出用量）')

    const streamUsage = client.parseStreamResponse([
        'data: {"choices":[{"delta":{"content":"答复"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":8,"total_tokens":38}}',
        'data: [DONE]'
    ].join('\n'), 'chat')
    assert.deepEqual(streamUsage.usage, { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 })
}

async function testFailedRequestsAreExcludedFromUsageTracking() {
    const server = http.createServer((request, response) => {
        if (request.url === '/failed') {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'prompt blocked' }, usage: { prompt_tokens: 900, completion_tokens: 80 } }))
            return
        }
        if (request.url === '/business-error') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'request rejected' }, usage: { prompt_tokens: 700, completion_tokens: 60 } }))
            return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }
        }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
        const { port } = server.address()
        const client = Object.create(AiClient.prototype)
        client.buildRequest = (_type, payload) => ({
            url: `http://127.0.0.1:${port}${payload.path}`,
            options: {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}'
            }
        })
        const usage = await client.withUsageTracking(async () => {
            const failed = await client.attemptRequest(
                'chat', { path: '/failed' }, { name: 'local', api_key: 'test' }, 'test-model', 128, 2000, { multimodal: true }
            )
            const failedAgain = await client.attemptRequest(
                'chat', { path: '/failed' }, { name: 'local', api_key: 'test' }, 'test-model', 128, 2000, { multimodal: true }
            )
            const businessError = await client.attemptRequest(
                'chat', { path: '/business-error' }, { name: 'local', api_key: 'test' }, 'test-model', 128, 2000, { multimodal: true }
            )
            const succeeded = await client.attemptRequest(
                'chat', { path: '/success' }, { name: 'local', api_key: 'test' }, 'test-model', 128, 2000, { multimodal: true }
            )
            return { failed, failedAgain, businessError, succeeded, usage: client.getCurrentUsageSnapshot() }
        })

        assert.equal(usage.failed.success, false)
        assert.equal(usage.failedAgain.success, false)
        assert.equal(usage.businessError.success, false)
        assert.equal(usage.succeeded.success, true)
        assert.equal(usage.usage.calls, 1)
        assert.equal(usage.usage.prompt_tokens, 30)
        assert.equal(usage.usage.completion_tokens, 8)
        assert.equal(usage.usage.missingUsageCalls, 0)
        assert.equal(
            formatTokenUsageInfo(usage.usage, usage.succeeded.usage),
            ' | 总输入Tokens: 30(30) | 总输出Tokens: 8(8)'
        )
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

async function testProviderFailoverBudget() {
    const calls = []
    const client = createClient([
        model('qianye', 'gemini-a'),
        model('qianye', 'gemini-b', 1),
        model('backup', 'flash-c')
    ])
    client.attemptRequest = async (_type, _payload, provider) => {
        calls.push(provider.id)
        return provider.id === 'backup'
            ? { success: true, data: 'ok' }
            : { success: false, error: 'AggregateError: fetch failed' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['qianye', 'backup'])
    assert.equal(client.providerStatus.qianye.fail_count, 1)
}

async function testConfiguredOrderBeatsHealthScore() {
    const calls = []
    const client = createClient([
        model('qianye', 'configured-first'),
        model('qianye', 'configured-second', 1)
    ])
    client.modelStatus['qianye-configured-first'] = {
        success_count: 1,
        fail_count: 0,
        avg_latency_ms: 30000,
    }
    client.modelStatus['qianye-configured-second'] = {
        success_count: 10,
        fail_count: 0,
        avg_latency_ms: 1000,
    }
    client.attemptRequest = async (_type, _payload, _provider, modelId) => {
        calls.push(modelId)
        return { success: true, data: 'ok' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['configured-first'])
}

async function testModelSpecificFailureKeepsConfiguredOrder() {
    const calls = []
    const client = createClient([
        model('first-provider', 'first-model'),
        model('second-provider', 'second-model', 1),
        model('first-provider', 'first-backup', 2)
    ])
    client.attemptRequest = async (_type, _payload, provider, modelId) => {
        calls.push(`${provider.id}/${modelId}`)
        return modelId === 'second-model'
            ? { success: true, data: 'ok' }
            : { success: false, error: 'HTTP状态码: 404，model not found' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['first-provider/first-model', 'second-provider/second-model'])
}

async function testProviderFailurePrioritizesOtherProvider() {
    const calls = []
    const client = createClient([
        model('qianye', 'empty-response'),
        model('qianye', 'same-provider-backup', 1),
        model('backup', 'cross-provider', 2)
    ])
    client.attemptRequest = async (_type, _payload, provider, modelId) => {
        calls.push(`${provider.id}/${modelId}`)
        return provider.id === 'backup'
            ? { success: true, data: 'ok' }
            : { success: false, error: 'API业务错误: AI返回了空消息' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['qianye/empty-response', 'backup/cross-provider'])
}

async function testFailureMessageReportsUntriedCandidates() {
    const client = createClient([
        model('qianye', 'first'),
        model('backup', 'second', 1),
        model('third', 'third', 2)
    ])
    const previousMaxAttempts = Config.MODEL_MAX_ATTEMPTS
    Config.MODEL_MAX_ATTEMPTS = 1
    try {
        client.attemptRequest = async () => ({ success: false, error: 'API业务错误: AI返回了空消息' })
        const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
        assert.match(result.error, /已尝试 1\/3 个候选模型/)
        assert.match(result.error, /仍有 2 个候选未尝试/)
    } finally {
        Config.MODEL_MAX_ATTEMPTS = previousMaxAttempts
    }
}

async function testModelFailureUsesSameProviderBackup() {
    const calls = []
    const client = createClient([
        model('qianye', 'missing-model'),
        model('qianye', 'working-model', 1),
        model('backup', 'flash-c', 2)
    ])
    client.attemptRequest = async (_type, _payload, provider, modelId) => {
        calls.push(`${provider.id}/${modelId}`)
        return modelId === 'working-model'
            ? { success: true, data: 'ok' }
            : { success: false, error: 'HTTP状态码: 503，No available channel for model' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['qianye/missing-model', 'qianye/working-model'])
}

function testErrorClassification() {
    const client = createClient([])
    const billing = client._classifyRequestError('HTTP状态码: 402，Insufficient Balance')
    assert.equal(billing.retryable, false)
    assert.equal(billing.scope, 'provider')

    const missingModel = client._classifyRequestError('HTTP状态码: 503，No available channel for model')
    assert.equal(missingModel.retryable, false)
    assert.equal(missingModel.scope, 'model')

    const network = client._classifyRequestError('AggregateError: connect ECONNRESET')
    assert.equal(network.retryable, true)
    assert.equal(network.scope, 'provider')
    const ipv6Route = client._classifyRequestError('connect ENETUNREACH 2606:4700::1')
    assert.equal(ipv6Route.retryable, true)
    assert.equal(ipv6Route.scope, 'provider')
    const emptyResponse = client._classifyRequestError('API业务错误: AI返回了空消息')
    assert.equal(emptyResponse.retryable, true)
    assert.equal(emptyResponse.scope, 'provider')

    const formatted = client._formatRequestError({
        message: 'AggregateError',
        errors: [{ message: 'fetch failed' }, { message: 'connect ECONNRESET' }]
    })
    assert.match(formatted, /fetch failed/)
    assert.match(formatted, /ECONNRESET/)
}

function testProviderStatsRecordFailuresWithoutCircuit() {
    const client = createClient([])
    const missingModel = client._classifyRequestError('HTTP 503: No available channel for model')
    client._recordProviderFail('qianye', missingModel)
    client._recordProviderFail('qianye', missingModel)
    assert.equal(client.providerStatus.qianye.fail_count, 2)

    const network = client._classifyRequestError('AggregateError: connect ECONNRESET')
    client._recordProviderFail('qianye', network)
    client._recordProviderFail('qianye', network)
    assert.equal(client.providerStatus.qianye.fail_count, 4)
    assert.equal(client.providerStatus.qianye.cooldown_until, undefined)
}

async function testFailuresDoNotSkipCandidates() {
    const client = createClient([
        model('first', 'model-a'),
        model('second', 'model-b'),
        model('second', 'model-c', 1)
    ])
    const calls = []
    client.attemptRequest = async (_type, _payload, provider) => {
        calls.push(provider.id)
        return { success: false, error: 'temporary timeout' }
    }
    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, false)
    assert.deepEqual(calls, ['first', 'second', 'second'])
}

function testVersionedStatusMigrationAndPruning() {
    const client = createClient([])
    client.modelsConfig = [{ id: 'qianye' }]
    client.modelDefinitions = [{ id: 'gemini', provider_id: 'qianye' }]
    const parsed = client._parseModelStatusDocument({
        'qianye-gemini': { success_count: 2, fail_count: 1, status: 'available' },
        'removed-old': { success_count: 9 },
        _provider_status: {
            qianye: { success_count: 3, fail_count: 1, last_error: 'timeout' },
            removed: { success_count: 1 }
        }
    })
    assert.equal(parsed.migrated, true)
    assert.equal(parsed.models['qianye-gemini'].success_count, 2)
    assert.equal(parsed.models['qianye-gemini'].status, undefined)
    assert.equal(parsed.models['qianye-gemini'].cooldown_until, undefined)
    client.modelStatus = parsed.models
    client.providerStatus = parsed.providers
    client._pruneStatusMaps()
    assert.deepEqual(Object.keys(client.modelStatus), ['qianye-gemini'])
    assert.deepEqual(Object.keys(client.providerStatus), ['qianye'])
}

async function testLaterProviderRemainsReachableWithinAttemptBudget() {
    const client = createClient([
        model('first', 'first-a'),
        model('first', 'first-b', 1),
        model('second', 'second-a'),
        model('third', 'third-a')
    ])
    const calls = []
    client.attemptRequest = async (_type, _payload, provider) => {
        calls.push(provider.id)
        return provider.id === 'third'
            ? { success: true, data: 'ok' }
            : { success: false, error: 'AggregateError: fetch failed' }
    }
    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['first', 'second', 'first', 'third'])
}

async function testDirectModelProbe() {
    const client = createClient([])
    client.modelsConfig = [
        { id: 'p1', name: 'Provider 1' },
        { id: 'p2', name: 'Provider 2' }
    ]
    client.modelDefinitions = [
        { id: 'vision', alias: 'same-name', provider_id: 'p1', model_id: 'vendor/vision', multimodal: true },
        { id: 'vision', alias: 'same-name', provider_id: 'p2', model_id: 'vendor/vision', multimodal: true }
    ]
    const ambiguous = await client.testModel('same-name')
    assert.equal(ambiguous.ambiguous, true)

    const calls = []
    client.attemptRequest = async (type, payload, provider, modelId, maxTokens, timeout, modelConfig) => {
        calls.push({ type, prompt: payload.contents[0].parts[0].text, provider: provider.id, modelId, maxTokens, timeout, modelKey: modelConfig.id })
        return { success: true, data: '模型测试通过。', usage: { total_tokens: 9 } }
    }
    const result = await client.testModel('p1/vision')
    assert.equal(result.success, true)
    assert.equal(result.providerId, 'p1')
    assert.equal(result.modelId, 'vendor/vision')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].type, 'chat')
    assert.equal(calls[0].maxTokens, 256)
    assert.equal(client.modelStatus['p1-vision'].success_count, 1)
    assert.equal(client.providerStatus.p1.success_count, 1)
}

async function testAllModelTargetsCoverChatAndImage() {
    const client = createClient([])
    client.modelsConfig = [{
        id: 'p1',
        name: 'Provider 1',
        model_groups: {
            flash: { chat_models: ['chat'], draw_models: ['draw'] }
        }
    }]
    client.modelDefinitions = [
        { id: 'chat', alias: 'chat', provider_id: 'p1', model_id: 'chat-api', multimodal: true },
        { id: 'draw', alias: 'draw', provider_id: 'p1', model_id: 'draw-api', multimodal: true }
    ]
    const targets = client.getModelTestTargets()
    assert.deepEqual(targets.map(target => `${target.model.id}/${target.type}`), ['chat/chat', 'draw/image'])

    const calls = []
    client.attemptRequest = async (type, _payload, _provider, modelId) => {
        calls.push({ type, modelId })
        return { success: true, data: type === 'image' ? 'https://image.test/result.png' : '模型测试通过。' }
    }
    const results = await client.testAllModels()
    assert.equal(results.length, 2)
    assert.deepEqual(calls, [
        { type: 'chat', modelId: 'chat-api' },
        { type: 'image', modelId: 'draw-api' }
    ])
}

async function testAllModelProbeContinuesAfterUnexpectedFailure() {
    const client = createClient([])
    client.modelsConfig = [{
        id: 'p1',
        name: 'Provider 1',
        model_groups: { flash: { chat_models: ['first', 'second'] } }
    }]
    client.modelDefinitions = [
        { id: 'first', provider_id: 'p1', model_id: 'first-api' },
        { id: 'second', provider_id: 'p1', model_id: 'second-api' }
    ]
    client.attemptRequest = async (_type, _payload, _provider, modelId) => {
        if (modelId === 'first-api') throw new Error('模拟测试异常')
        return { success: true, data: '模型测试通过。' }
    }
    const results = await client.testAllModels()
    assert.equal(results.length, 2)
    assert.equal(results[0].success, false)
    assert.equal(results[1].success, true)
}

async function testMultimodalVisionRelayDependsOnConfiguration() {
    const client = createClient([model('qianye', 'vision-model')])
    assert.equal(client._checkModelGroupNeedsVisionRelay('flash'), false)
    client.activeModelPools.flash.chat[0].modelConfig.multimodal = false
    assert.equal(client._checkModelGroupNeedsVisionRelay('flash'), true)
}

async function testVisionRelayAutoDiscoversUnlistedChatFallback() {
    const client = createClient([])
    client.modelsConfig = [
        {
            id: 'qianye',
            name: 'qianye',
            model_groups: { flash: { draw_models: ['draw-only'] } }
        },
        {
            id: 'backup',
            name: 'backup',
            model_groups: {}
        }
    ]
    client.modelDefinitions = [
        { id: 'configured', alias: 'configured', provider_id: 'qianye', model_id: 'configured-api', multimodal: true },
        { id: 'draw-only', alias: 'draw-only', provider_id: 'qianye', model_id: 'draw-api', multimodal: true },
        { id: 'unlisted-vision', alias: 'unlisted-vision', provider_id: 'backup', model_id: 'vision-api', multimodal: true }
    ]
    client.visionRelayConfig = { vision_model: [{ model: 'configured' }] }

    const candidates = client.getVisionRelayModels()
    assert.deepEqual(candidates.map(candidate => candidate.id), ['configured', 'unlisted-vision'])
}

async function testAttemptRequestPassesCancellationSignal() {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
            choices: [{ message: { content: '模型测试通过。' } }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 }
        }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
        const { port } = server.address()
        const client = Object.create(AiClient.prototype)
        client.buildRequest = () => ({
            url: `http://127.0.0.1:${port}/chat/completions`,
            options: {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}'
            }
        })
        const controller = new AbortController()
        const tracked = await client.withUsageTracking(async () => {
            const result = await client.attemptRequest(
                'chat',
                { contents: [] },
                { name: 'local', api_key: 'test' },
                'test-model',
                128,
                2000,
                { multimodal: true },
                { signal: controller.signal }
            )
            return { result, usage: client.getCurrentUsageSnapshot() }
        })
        const { result, usage } = tracked
        assert.equal(result.success, true)
        assert.equal(result.data, '模型测试通过。')
        assert.equal(usage.calls, 1)
        assert.equal(usage.prompt_tokens, 18)
        assert.equal(usage.completion_tokens, 6)
        assert.equal(usage.missingUsageCalls, 0)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

async function testAnimatedImageEndpointOptionsAndMime() {
    const client = Object.create(AiClient.prototype)
    const provider = { base_url: 'https://api.example/v1', api_key: 'test-key', name: 'test' }
    const modelConfig = {
        multimodal: true,
        supports_gif_input: false,
        supports_gif_output: true,
        gif_frame_count: 10,
        gif_frame_duration_ms: 150
    }
    const generation = client.buildRequest('image', {
        contents: [{ parts: [{ text: 'Create an animated GIF' }] }]
    }, provider, 'gpt-image-2.6-flare', 8192, modelConfig, { imageOutputFormat: 'gif' })
    const generationBody = JSON.parse(generation.options.body)
    assert.equal(generation.url, 'https://api.example/v1/images/generations')
    assert.deepEqual(
        { output_format: generationBody.output_format, frame_count: generationBody.frame_count, frame_duration_ms: generationBody.frame_duration_ms },
        { output_format: 'gif', frame_count: 10, frame_duration_ms: 150 }
    )

    const edit = client.buildRequest('image', {
        contents: [{ parts: [
            { text: 'Animate this reference' },
            {
                inline_data: { mime_type: 'image/gif', data: Buffer.from('original-gif').toString('base64') },
                fallback_inline_data: { mime_type: 'image/png', data: Buffer.from('contact-sheet').toString('base64') }
            }
        ] }]
    }, provider, 'gpt-image-2.6-flare', 8192, modelConfig, { imageOutputFormat: 'gif' })
    const editBody = edit.options.body.toString('utf8')
    assert.equal(edit.url, 'https://api.example/v1/images/edits')
    assert.match(editBody, /name="output_format"\r\n\r\ngif/)
    assert.match(editBody, /name="frame_count"\r\n\r\n10/)
    assert.match(editBody, /Content-Type: image\/png/)
    assert.match(editBody, /关键帧拼图/)

    const gifBytes = fs.readFileSync(new URL('./fixtures/animated.gif.b64', import.meta.url), 'utf8').trim()
    const parsed = client.parseResponse({ data: [{ b64_json: gifBytes, output_format: 'gif' }] }, 'image')
    assert.equal(parsed.success, true)
    assert.match(parsed.data, /^data:image\/gif;base64,/)

    const unsupportedClient = Object.create(AiClient.prototype)
    unsupportedClient.activeModelPools = { flash: { image: [{ modelId: 'qwen-image', modelConfig: { supports_gif_output: true } }] } }
    assert.equal(unsupportedClient.supportsGifOutput('flash'), false)
    const unsupported = await unsupportedClient.makeRequest('image', { contents: [] }, 'flash', 8192, { imageOutputFormat: 'gif' })
    assert.equal(unsupported.success, false)
    assert.match(unsupported.error, /没有声明支持 GIF 输出的直连 gpt-image 绘图模型/)

    const supportedClient = Object.create(AiClient.prototype)
    supportedClient.activeModelPools = { flash: { image: [{ modelId: 'gpt-image-2.6-flare', modelConfig: { supports_gif_output: true } }] } }
    assert.equal(supportedClient.supportsGifOutput('flash'), true)
}

await testUsageTrackingIsolatedPerConcurrentRequest()
await testQuickIntentRequestForwardsStructuredOutputOptions()
await testQuickIntentRequestRetriesOneEmptyResponse()
testWhitespaceChatResponseIsRejected()
testChatReasoningIsNotExposedInParsedOutput()
await testFailedRequestsAreExcludedFromUsageTracking()
await testProviderFailoverBudget()
await testConfiguredOrderBeatsHealthScore()
await testModelSpecificFailureKeepsConfiguredOrder()
await testProviderFailurePrioritizesOtherProvider()
await testFailureMessageReportsUntriedCandidates()
await testModelFailureUsesSameProviderBackup()
testErrorClassification()
testProviderStatsRecordFailuresWithoutCircuit()
await testFailuresDoNotSkipCandidates()
testVersionedStatusMigrationAndPruning()
await testLaterProviderRemainsReachableWithinAttemptBudget()
await testDirectModelProbe()
await testAllModelTargetsCoverChatAndImage()
await testAllModelProbeContinuesAfterUnexpectedFailure()
await testMultimodalVisionRelayDependsOnConfiguration()
await testVisionRelayAutoDiscoversUnlistedChatFallback()
await testAttemptRequestPassesCancellationSignal()
await testAnimatedImageEndpointOptionsAndMime()
console.log('Resilience eval: 20 passed, 0 failed')
