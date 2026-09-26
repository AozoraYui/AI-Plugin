import assert from 'node:assert/strict'

global.logger = {
    info() {},
    debug() {},
    warn() {},
    error() {}
}

const { AiClient } = await import('../client/AiClient.js')

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
    assert.equal(client.providerStatus.qianye.consecutive_fails, 1)
    assert.equal(client.providerStatus.qianye.cooldown_until, 0)
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
        consecutive_fails: 0,
        cooldown_until: 0
    }
    client.modelStatus['qianye-configured-second'] = {
        success_count: 10,
        fail_count: 0,
        avg_latency_ms: 1000,
        consecutive_fails: 0,
        cooldown_until: 0
    }
    client.attemptRequest = async (_type, _payload, _provider, modelId) => {
        calls.push(modelId)
        return { success: true, data: 'ok' }
    }

    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['configured-first'])
}

async function testInterleavedProvidersFollowConfiguredOrder() {
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
    assert.equal(client.providerStatus.qianye.cooldown_until, 0)
}

function testErrorClassification() {
    const client = createClient([])
    const billing = client._classifyRequestError('HTTP状态码: 402，Insufficient Balance')
    assert.equal(billing.retryable, false)
    assert.equal(billing.scope, 'provider')
    assert.ok(billing.cooldownMs >= 10 * 60 * 1000)

    const missingModel = client._classifyRequestError('HTTP状态码: 503，No available channel for model')
    assert.equal(missingModel.retryable, false)
    assert.equal(missingModel.scope, 'model')

    const network = client._classifyRequestError('AggregateError: connect ECONNRESET')
    assert.equal(network.retryable, true)
    assert.equal(network.scope, 'provider')

    const formatted = client._formatRequestError({
        message: 'AggregateError',
        errors: [{ message: 'fetch failed' }, { message: 'connect ECONNRESET' }]
    })
    assert.match(formatted, /fetch failed/)
    assert.match(formatted, /ECONNRESET/)
}

function testModelFailuresDoNotPoisonProviderCircuit() {
    const client = createClient([])
    const missingModel = client._classifyRequestError('HTTP 503: No available channel for model')
    client._recordProviderFail('qianye', missingModel)
    client._recordProviderFail('qianye', missingModel)
    assert.equal(client.providerStatus.qianye.fail_count, 2)
    assert.equal(client.providerStatus.qianye.consecutive_fails, 0)
    assert.equal(client.providerStatus.qianye.cooldown_until, 0)

    const network = client._classifyRequestError('AggregateError: connect ECONNRESET')
    client._recordProviderFail('qianye', network)
    client._recordProviderFail('qianye', network)
    assert.equal(client.providerStatus.qianye.consecutive_fails, 2)
    assert.ok(client.providerStatus.qianye.cooldown_until > Date.now())
}

async function testAllCooldownFailsFastWithoutProbe() {
    const client = createClient([
        model('first', 'model-a'),
        model('second', 'model-b'),
        model('second', 'model-c', 1)
    ])
    const now = Date.now()
    client.providerStatus = {
        first: { cooldown_until: now + 30000 },
        second: { cooldown_until: now + 60000 }
    }
    const calls = []
    client.attemptRequest = async (_type, _payload, provider) => {
        calls.push(provider.id)
        return { success: false, error: 'temporary timeout' }
    }
    const result = await client.makeRequest('chat', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    assert.equal(result.success, false)
    assert.deepEqual(calls, [])
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
    client.modelStatus = parsed.models
    client.providerStatus = parsed.providers
    client._pruneStatusMaps()
    assert.deepEqual(Object.keys(client.modelStatus), ['qianye-gemini'])
    assert.deepEqual(Object.keys(client.providerStatus), ['qianye'])
}

async function testLaterProviderIsNotStarvedByEarlierQueues() {
    const client = createClient([
        model('first', 'first-a'),
        model('first', 'first-b', 1),
        model('second', 'second-a'),
        model('second', 'second-b', 1),
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
    assert.deepEqual(calls, ['first', 'second', 'third'])
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

await testProviderFailoverBudget()
await testConfiguredOrderBeatsHealthScore()
await testInterleavedProvidersFollowConfiguredOrder()
await testModelFailureUsesSameProviderBackup()
testErrorClassification()
testModelFailuresDoNotPoisonProviderCircuit()
await testAllCooldownFailsFastWithoutProbe()
testVersionedStatusMigrationAndPruning()
await testLaterProviderIsNotStarvedByEarlierQueues()
await testDirectModelProbe()
await testAllModelTargetsCoverChatAndImage()
await testAllModelProbeContinuesAfterUnexpectedFailure()
console.log('Resilience eval: 11 passed, 0 failed')
