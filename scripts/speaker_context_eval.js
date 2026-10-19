import assert from 'node:assert/strict'

globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} }

const {
    buildSpeakerMeta,
    formatSpeakerAwareHistoryTurn,
    SPEAKER_ATTRIBUTION_RULE,
    stripLegacyGroupContextMemory,
    toModelHistory
} = await import('../utils/speaker_context.js')
const { buildHistoryText } = await import('../utils/summarizer.js')
const { compactConversationHistory } = await import('../utils/memory_context.js')
const { buildHistoryRowVectorDocs } = await import('../utils/vector_memory.js')
const { buildParticipantIdentityHint } = await import('../utils/message_context.js')
const { buildUserProfilePrompt } = await import('../utils/user_profile.js')

const aliceMeta = buildSpeakerMeta({ userId: '10001', nickname: 'Alice', scope: 'group', source: 'fast_chat', groupId: '90001' })
const bobMeta = buildSpeakerMeta({ userId: '10002', nickname: 'Bob', scope: 'group', source: 'fast_chat', groupId: '90001' })
const aiMeta = buildSpeakerMeta({ userId: '99999', nickname: '诺亚', isBot: true, scope: 'group', source: 'fast_chat', groupId: '90001' })

assert.equal(formatSpeakerAwareHistoryTurn({
    role: 'user',
    parts: [{ text: '我今天吃了拉面' }],
    meta: aliceMeta
}), 'Alice(QQ 10001): 我今天吃了拉面')

const historyText = buildHistoryText([
    { role: 'user', parts: [{ text: '我今天吃了拉面' }], meta: aliceMeta },
    { role: 'user', parts: [{ text: '我今天加班' }], meta: bobMeta },
    { role: 'model', parts: [{ text: '辛苦了' }], meta: aiMeta }
], '诺亚')
assert.match(historyText, /Alice\(QQ 10001\): 我今天吃了拉面/)
assert.match(historyText, /Bob\(QQ 10002\): 我今天加班/)
assert.match(historyText, /诺亚: 辛苦了/)
assert.ok(historyText.includes(SPEAKER_ATTRIBUTION_RULE))
assert.doesNotMatch(historyText, /^用户:/m)

const modelHistory = toModelHistory([
    { role: 'user', parts: [{ text: '测试' }], meta: aliceMeta, date_str: '2026-10-20' }
])
assert.deepEqual(modelHistory, [{ role: 'user', parts: [{ text: '测试' }] }])

const legacyMemory = [
    '【畅聊模式记录】以下内容来自群聊畅聊模式',
    '触发者：Bob(10002)',
    '触发消息：我今天吃了拉面',
    '当时最近群聊上下文：',
    'Alice(10001): 我今天吃了拉面',
    'Bob(10002): 我今天加班',
    '注意：这是一段群聊公开上下文记录，回复时仍需遵守当前聊天环境的隐私规则。'
].join('\n')
const cleanedLegacy = stripLegacyGroupContextMemory(legacyMemory)
assert.match(cleanedLegacy, /触发消息：我今天吃了拉面/)
assert.doesNotMatch(cleanedLegacy, /Alice\(10001\): 我今天吃了拉面/)
assert.equal(stripLegacyGroupContextMemory('普通文本：当时最近群聊上下文：只是正文'),
    '普通文本：当时最近群聊上下文：只是正文')
assert.equal(stripLegacyGroupContextMemory('我的问题\n=== 引用Alice的消息 ===\nAlice: 我今天吃了拉面\n=======================\n'),
    '我的问题')
assert.equal(buildHistoryText([], '诺亚'), '')

const compactedLegacy = compactConversationHistory([
    { role: 'user', parts: [{ text: legacyMemory }] }
])
assert.doesNotMatch(compactedLegacy[0].parts[0].text, /Alice\(10001\): 我今天吃了拉面/)

const vectorDocs = buildHistoryRowVectorDocs({
    id: 1,
    user_id: '10001',
    role: 'user',
    parts: [{ text: '我今天吃了拉面' }],
    meta: aliceMeta,
    date_str: '2026-10-20',
    created_at: '2026-10-20 12:00:00'
})
assert.equal(vectorDocs.length, 1)
assert.equal(vectorDocs[0].metadata.speaker_user_id, '10001')
assert.equal(vectorDocs[0].metadata.speaker_name, 'Alice')
assert.equal(vectorDocs[0].metadata.scope, 'group')
assert.match(vectorDocs[0].text, /说话人: Alice\(QQ 10001\)/)

const modelVectorDocs = buildHistoryRowVectorDocs({
    id: 2,
    user_id: '10001',
    role: 'model',
    parts: [{ text: '这是 AI 的回复' }],
    date_str: '2026-10-20'
})
assert.equal(modelVectorDocs[0].metadata.speaker_user_id, '')
assert.equal(modelVectorDocs[0].metadata.speaker_is_bot, true)
assert.match(modelVectorDocs[0].text, /说话人: /)

const identityHint = buildParticipantIdentityHint('10002', [])
assert.match(identityHint, /昵称\(QQ\)/)
assert.match(identityHint, /不能转移/)

const profilePrompt = buildUserProfilePrompt({
    userId: '10002',
    oldProfile: null,
    summaryText: 'Alice(QQ 10001): 我今天吃了拉面\nBob(QQ 10002): 我今天加班',
    summaryType: 'incremental',
    dateStr: '2026-10-20'
})
assert.match(profilePrompt, /QQ 10002/)
assert.match(profilePrompt, /其他昵称\/QQ 的发言.*不得写入/)

console.log('Speaker context eval: passed')
