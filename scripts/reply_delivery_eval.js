import assert from 'node:assert/strict'

const warnings = []
global.logger = {
    warn(message) { warnings.push(message) },
    info() {}
}

const {
    sendReplyWithForwardFallback,
    sendTextInChunks,
    splitReplyText,
    buildDeliveryKey,
    clearDeliveryState,
    getDeliveryState
} = await import('../utils/reply_delivery.js')

function assertSafeChunks(chunks, maxBytes = 3500) {
    for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(chunk, 'utf8') <= maxBytes, `chunk exceeds ${maxBytes} bytes`)
    }
}

async function testByteSafeSplitting() {
    const source = '这是中文内容。'.repeat(1200)
    const chunks = splitReplyText(source, { maxChars: 3500, maxBytes: 3500 })
    assert.ok(chunks.length > 1)
    assertSafeChunks(chunks)
    assert.equal(chunks.join(''), source)
}

async function testForwardSuccess() {
    const sent = []
    let nodes
    const delivery = await sendReplyWithForwardFallback({
        responseText: '正文'.repeat(2200),
        footerInfo: '耗时信息'.repeat(700),
        aiName: '诺亚',
        botUin: '123',
        makeForwardMsg: value => {
            nodes = value
            return { type: 'forward' }
        },
        sendReply: async (...args) => {
            sent.push(args)
            return { status: 'ok' }
        }
    })
    assert.equal(delivery.method, 'forward')
    assert.equal(sent.length, 1)
    assert.ok(nodes.length > 1)
    assertSafeChunks(nodes.map(node => node.message))
    assert.ok(nodes.some(node => node.message.includes('耗时信息')))
}

async function testForwardRetcodeFallsBackToPlainChunks() {
    const sent = []
    const source = '普通消息'.repeat(1800)
    const delivery = await sendReplyWithForwardFallback({
        responseText: source,
        makeForwardMsg: () => ({ type: 'forward' }),
        sendReply: async (...args) => {
            sent.push(args)
            if (args[0]?.type === 'forward') return { status: 'failed', retcode: 1200, message: 'unsupported message type' }
            return { status: 'ok' }
        }
    })
    assert.equal(delivery.method, 'plain-fallback')
    assert.equal(delivery.error, '')
    const plainSent = sent.filter(args => typeof args[0] === 'string')
    assert.ok(plainSent.length > 1)
    assert.equal(plainSent[0][1], true)
    assert.ok(plainSent.slice(1).every(args => args[1] === false))
    const plainText = plainSent.map(args => args[0]).join('')
    assert.match(plainText, /普通消息/)
    assertSafeChunks(plainSent.map(args => args[0]))
    assert.ok(warnings.some(message => message.includes('1200')))
}

async function testUnknownAdapterFailureDoesNotTriggerFallbackRetry() {
    let attempts = 0
    const delivery = await sendReplyWithForwardFallback({
        responseText: '未知失败'.repeat(1200),
        makeForwardMsg: () => ({ type: 'forward' }),
        sendReply: async args => {
            attempts++
            return { status: 'failed', retcode: 1200, message: 'adapter failed' }
        }
    })
    assert.equal(delivery.method, 'failed')
    assert.equal(delivery.deliveryStatus, 'ambiguous')
    assert.equal(attempts, 1)
}

async function testInvalidForwardFailureFallsBack() {
    let attempts = 0
    const delivery = await sendReplyWithForwardFallback({
        responseText: '格式不支持'.repeat(1200),
        makeForwardMsg: () => ({ type: 'forward' }),
        sendReply: async message => {
            attempts++
            if (message?.type === 'forward') return { status: 'failed', retcode: 400, message: 'unsupported message type' }
            return { status: 'ok' }
        }
    })
    assert.equal(delivery.method, 'plain-fallback')
    assert.equal(delivery.error, '')
    assert.ok(attempts > 1)
}

async function testTransportFailureDoesNotTriggerFallbackRetry() {
    let attempts = 0
    const delivery = await sendReplyWithForwardFallback({
        responseText: '网络失败'.repeat(1200),
        makeForwardMsg: () => ({ type: 'forward' }),
        sendReply: async () => {
            attempts++
            return { status: 'failed', retcode: 1200, message: '网络连接异常!' }
        }
    })
    assert.equal(delivery.method, 'failed')
    assert.match(delivery.error, /网络连接异常/)
    assert.equal(attempts, 1)
}

async function testPlainSendFailureIsReported() {
    let attempts = 0
    const delivery = await sendReplyWithForwardFallback({
        responseText: '失败回退'.repeat(1200),
        makeForwardMsg: () => { throw new Error('forward unavailable') },
        sendReply: async () => {
            attempts++
            return { status: 'failed', retcode: 1200, message: 'plain failed' }
        }
    })
    assert.equal(delivery.method, 'failed')
    assert.match(delivery.error, /forward unavailable/)
    assert.match(delivery.error, /plain failed/)
    assert.ok(attempts > 0)
}

async function testConcurrentSameDeliveryOnlySendsOnce() {
    clearDeliveryState()
    const deliveryKey = buildDeliveryKey({ requestId: 'message-1', targetId: 'group:1', method: 'plain', message: '并发消息' })
    let attempts = 0
    const send = () => sendTextInChunks({
        text: '并发消息',
        sendReply: async () => {
            attempts++
            await new Promise(resolve => setTimeout(resolve, 10))
            return { status: 'ok', message_id: 'sent-1' }
        },
        deliveryKey,
        deliveryContext: { requestId: 'message-1', targetId: 'group:1' }
    })
    const [first, second] = await Promise.all([send(), send()])
    assert.equal(attempts, 1)
    assert.equal(first.error, '')
    assert.equal(second.error, '')
    assert.equal(getDeliveryState(buildDeliveryKey({
        requestId: 'message-1', targetId: 'group:1', method: 'plain', segmentIndex: 0, message: '并发消息', scope: deliveryKey
    }))?.status, 'sent')
}

async function testSentDeliveryIsNotRepeated() {
    clearDeliveryState()
    let attempts = 0
    const context = { requestId: 'message-2', targetId: 'private:2', stepId: 'final_reply' }
    const send = () => sendTextInChunks({
        text: '只发送一次',
        sendReply: async () => {
            attempts++
            return { status: 'ok' }
        },
        deliveryContext: context
    })
    await send()
    await send()
    assert.equal(attempts, 1)
}

async function testFailedSecondChunkDoesNotRestartFirstChunk() {
    clearDeliveryState()
    const source = '分段内容'.repeat(1600)
    const context = { requestId: 'message-3', targetId: 'group:3', stepId: 'final_reply' }
    let attempts = 0
    const send = () => sendTextInChunks({
        text: source,
        maxChars: 100,
        maxBytes: 3500,
        sendReply: async (_chunk, quote) => {
            attempts++
            if (!quote) throw new Error('socket hang up')
            return { status: 'ok' }
        },
        deliveryContext: context
    })
    const first = await send()
    const second = await send()
    assert.equal(first.deliveryStatus, 'transport')
    assert.equal(second.deliveryStatus, 'transport')
    assert.equal(first.sentChunks, 1)
    assert.equal(second.sentChunks, 1)
    assert.equal(attempts, 2)
}

async function testPendingStateIsPersistedBeforeSend() {
    clearDeliveryState()
    const previousManager = global.AIPluginConversationManager
    const states = new Map()
    let stateAtSend = null
    global.AIPluginConversationManager = {
        db: {
            async getOutboundDeliveryState(key) { return states.get(key) || null },
            async saveOutboundDeliveryState(record) {
                states.set(record.deliveryKey, { ...record })
                return true
            }
        }
    }
    try {
        const delivery = await sendTextInChunks({
            text: '发送前落盘',
            deliveryKey: 'pending-before-send',
            sendReply: async () => {
                stateAtSend = [...states.values()][0]
                return { status: 'ok' }
            }
        })
        assert.equal(delivery.error, '')
        assert.equal(stateAtSend?.status, 'pending')
        assert.equal([...states.values()][0].status, 'sent')
    } finally {
        if (previousManager === undefined) delete global.AIPluginConversationManager
        else global.AIPluginConversationManager = previousManager
    }
}

async function testPersistedSentDeliverySurvivesProcessCacheReset() {
    clearDeliveryState()
    const previousManager = global.AIPluginConversationManager
    const states = new Map()
    global.AIPluginConversationManager = {
        db: {
            async getOutboundDeliveryState(key) { return states.get(key) || null },
            async saveOutboundDeliveryState(record) {
                states.set(record.deliveryKey, {
                    ...record,
                    result: record.result
                })
                return true
            }
        }
    }
    try {
        let attempts = 0
        const options = {
            text: '持久化消息',
            deliveryKey: 'persisted-key',
            sendReply: async () => {
                attempts++
                return { status: 'ok', message_id: 'persisted-1' }
            }
        }
        const first = await sendTextInChunks(options)
        clearDeliveryState()
        const second = await sendTextInChunks(options)
        assert.equal(first.error, '')
        assert.equal(second.error, '')
        assert.equal(attempts, 1)
        assert.equal(states.size, 1)
        assert.equal([...states.values()][0].status, 'sent')
    } finally {
        if (previousManager === undefined) delete global.AIPluginConversationManager
        else global.AIPluginConversationManager = previousManager
    }
}

async function testPersistedPendingDeliveryIsNotRetried() {
    clearDeliveryState()
    const previousManager = global.AIPluginConversationManager
    const pendingKey = buildDeliveryKey({ scope: 'pending-key', method: 'plain', message: '进程中断消息' })
    global.AIPluginConversationManager = {
        db: {
            async getOutboundDeliveryState(key) {
                return key === pendingKey ? {
                    deliveryKey: key,
                    status: 'pending',
                    result: undefined,
                    error: '',
                    createdAt: Date.now() - 1000,
                    updatedAt: Date.now() - 1000,
                    expiresAt: Date.now() + 100000
                } : null
            },
            async saveOutboundDeliveryState() { return true }
        }
    }
    try {
        let attempts = 0
        const delivery = await sendTextInChunks({
            text: '进程中断消息',
            deliveryKey: 'pending-key',
            sendReply: async () => {
                attempts++
                return { status: 'ok' }
            }
        })
        assert.equal(delivery.deliveryStatus, 'ambiguous')
        assert.match(delivery.error, /无法确认|不自动重发/)
        assert.equal(attempts, 0)
    } finally {
        if (previousManager === undefined) delete global.AIPluginConversationManager
        else global.AIPluginConversationManager = previousManager
    }
}

async function testFastPathUsesReplyOnlyOnceForShortText() {
    const sent = []
    const delivery = await sendTextInChunks({
        text: '短消息',
        sendReply: async (...args) => {
            sent.push(args)
            return { status: 'ok' }
        }
    })
    assert.equal(delivery.error, '')
    assert.equal(sent.length, 1)
    assert.equal(sent[0][1], true)
}

await testByteSafeSplitting()
await testForwardSuccess()
await testForwardRetcodeFallsBackToPlainChunks()
await testPlainSendFailureIsReported()
await testUnknownAdapterFailureDoesNotTriggerFallbackRetry()
await testInvalidForwardFailureFallsBack()
await testTransportFailureDoesNotTriggerFallbackRetry()
await testConcurrentSameDeliveryOnlySendsOnce()
await testSentDeliveryIsNotRepeated()
await testFailedSecondChunkDoesNotRestartFirstChunk()
await testPendingStateIsPersistedBeforeSend()
await testPersistedSentDeliverySurvivesProcessCacheReset()
await testPersistedPendingDeliveryIsNotRetried()
await testFastPathUsesReplyOnlyOnceForShortText()
console.log('Reply delivery eval: 14 passed, 0 failed')
