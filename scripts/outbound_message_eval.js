import assert from 'node:assert/strict'

global.logger = { info() {}, warn() {} }

const {
    extractMessageIds,
    hydrateCachedForwardMessage,
    normalizeOutboundMessage,
    rememberOutboundForwardMessage
} = await import('../utils/outbound_message.js')

function testOutboundNormalization() {
    const result = normalizeOutboundMessage({
        type: 'node',
        data: [
            { user_id: '1', nickname: '甲', message: '第一条' },
            {
                user_id: '2',
                nickname: '乙',
                message: [
                    { type: 'text', data: { text: '第二条' } },
                    { type: 'image', data: { url: 'https://img.test/a.jpg' } }
                ]
            }
        ]
    })
    assert.equal(result.forwardNodes.length, 2)
    assert.match(result.normalizedText, /第一条/)
    assert.match(result.normalizedText, /第二条/)
    assert.equal(result.imageMeta.length, 1)
}

function testMessageIdExtraction() {
    assert.deepEqual(
        extractMessageIds({ message_id: ['123', '456'], data: [{ message_id: 789 }] }),
        ['123', '456', '789']
    )
}

async function testCachedHydration() {
    global.AIPluginConversationManager = {
        db: {
            async getOutboundForwardMessage({ messageId, groupId }) {
                assert.equal(messageId, '42')
                assert.equal(groupId, '100')
                return {
                    nodes_json: JSON.stringify([{
                        user_id: '1',
                        nickname: '诺亚',
                        message: [{ type: 'text', text: '帮助内容' }]
                    }])
                }
            }
        }
    }
    const source = await hydrateCachedForwardMessage(
        { message_id: 42, message: [{ type: 'forward', id: 'resid' }] },
        '100'
    )
    assert.equal(source.message[0].content[0].message[0].text, '帮助内容')
}

async function testCachedHydrationByRecentGroupFallback() {
    let exactLookups = 0
    global.AIPluginConversationManager = {
        db: {
            async getOutboundForwardMessage() {
                exactLookups += 1
                return null
            },
            async getLatestOutboundForwardMessage({ groupId, maxAgeSeconds }) {
                assert.equal(groupId, '100')
                assert.equal(maxAgeSeconds, 900)
                return {
                    message_id: 'recent-forward-id',
                    nodes_json: JSON.stringify([{
                        user_id: 'bot',
                        nickname: '诺亚',
                        message: [{ type: 'text', text: '最近帮助内容' }]
                    }])
                }
            }
        }
    }
    const source = await hydrateCachedForwardMessage(
        { message: [{ type: 'forward', data: { id: 'temporary-resid' } }] },
        '100',
        'outer-message-id',
        { botUserId: 'bot' }
    )
    assert.equal(exactLookups, 2)
    assert.equal(source.message[0].content[0].message[0].text, '最近帮助内容')
}

async function testSameProcessMemoryHydration() {
    rememberOutboundForwardMessage({
        groupId: '200',
        messageId: 'memory-forward-id',
        nodes: [{
            user_id: 'bot',
            nickname: '诺亚',
            message: [{ type: 'text', text: '内存缓存内容' }]
        }]
    })
    global.AIPluginConversationManager = {
        db: {
            async getOutboundForwardMessage() {
                throw new Error('不应回读数据库')
            }
        }
    }
    const source = await hydrateCachedForwardMessage(
        { message: [{ type: 'forward', data: { id: 'memory-forward-id' } }] },
        '200',
        '',
        { botUserId: 'bot' }
    )
    assert.equal(source.message[0].content[0].message[0].text, '内存缓存内容')
}

testOutboundNormalization()
testMessageIdExtraction()
await testCachedHydration()
await testCachedHydrationByRecentGroupFallback()
await testSameProcessMemoryHydration()
console.log('Outbound message eval: 5 passed, 0 failed')
