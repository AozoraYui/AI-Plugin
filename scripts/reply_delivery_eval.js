import assert from 'node:assert/strict'

const warnings = []
global.logger = {
    warn(message) { warnings.push(message) },
    info() {}
}

const {
    sendReplyWithForwardFallback,
    sendTextInChunks,
    splitReplyText
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
            if (args[0]?.type === 'forward') return { status: 'failed', retcode: 1200, message: 'failed' }
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
await testFastPathUsesReplyOnlyOnceForShortText()
console.log('Reply delivery eval: 5 passed, 0 failed')
