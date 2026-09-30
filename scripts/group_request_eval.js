global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }
global.AIPluginClient = { enableGroupAdmin: true }
const { groupRequestHandleTool, GROUP_REQUEST_TTL_SECONDS } = await import('../tools/group_admin.js')
const { classifyToolCallRisk } = await import('../utils/agent_policy.js')
const { hasExplicitGroupRequestListIntent, parseExplicitGroupRequestDecision } = await import('../utils/tool_intent.js')

const failures = []
let passed = 0

function check(name, condition, detail = '') {
    if (condition) {
        passed++
        console.log(`PASS ${name}`)
        return
    }
    failures.push({ name, detail })
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

check('明确入群审核属于中风险直接动作', classifyToolCallRisk({ name: 'group_request_handle', args: { approve: true } }) === 'medium')
check('入群申请缓存至少覆盖截图中的延迟', GROUP_REQUEST_TTL_SECONDS >= 24 * 60 * 60)
check('明确同意申请被识别为通过', parseExplicitGroupRequestDecision('#c 同意申请') === true)
check('明确拒绝申请被识别为拒绝', parseExplicitGroupRequestDecision('#c 拒绝申请') === false)
check('能力问句不能触发审核', parseExplicitGroupRequestDecision('#c 你会通过申请吗？') === null)
check('含糊同意不能授权审核', parseExplicitGroupRequestDecision('#c 同意你的方案') === null)
check('“有人加群了”可查询待审申请', hasExplicitGroupRequestListIntent('#c 有人加群了？') === true)
check('否定句不能授权审核', parseExplicitGroupRequestDecision('#c 不要通过申请') === null)
check('不同意申请不能被反向解析为通过', parseExplicitGroupRequestDecision('#c 不同意申请') === null)
check('历史提问不能触发审核', parseExplicitGroupRequestDecision('#c 谁通过了刚才的入群申请？') === null)
check('已处理记录问题不查询待审列表', hasExplicitGroupRequestListIntent('#c 有没有人通过了入群申请？') === false)

const calls = []
const records = new Map([
    ['AI-Plugin:groupAdd:10001:2096404956', JSON.stringify({
        user_id: '2096404956',
        group_id: '10001',
        flag: 'request-flag',
        sub_type: 'add',
        nickname: '白团维特',
        comment: '想进群',
        time: Date.now()
    })]
])

global.redis = {
    async keys() { return [...records.keys()] },
    async get(key) { return records.get(key) || null },
    async del(key) { records.delete(key); return 1 }
}

global.Bot = {
    async setGroupAddRequest(...args) {
        calls.push(args)
    }
}

const result = await groupRequestHandleTool.execute({ approve: true }, {
    originalUserMessage: '#c 同意申请',
    event: {
        group_id: '10001',
        user_id: '3559125985',
        isMaster: true,
        bot: global.Bot,
        group: { is_admin: true }
    }
})
check('单条申请的“同意申请”可以直接处理', result?.ok === true && result.approve === true && result.userId === '2096404956')
check('直接处理使用原始申请 flag', calls.length === 1 && calls[0][0] === 'request-flag' && calls[0][2] === true)
check('处理成功后删除申请缓存', records.size === 0)

records.set('AI-Plugin:groupAdd:10001:1000000001', JSON.stringify({ user_id: '1000000001', group_id: '10001', flag: 'flag-1', nickname: '甲', time: Date.now() }))
records.set('AI-Plugin:groupAdd:10001:1000000002', JSON.stringify({ user_id: '1000000002', group_id: '10001', flag: 'flag-2', nickname: '乙', time: Date.now() }))
const ambiguous = await groupRequestHandleTool.execute({ approve: true }, {
    originalUserMessage: '#c 同意申请',
    event: { group_id: '10001', user_id: '3559125985', isMaster: true, bot: global.Bot, group: { is_admin: true } }
})
check('多条申请不会默认选择第一条', typeof ambiguous === 'string' && ambiguous.includes('多条待审核申请') && calls.length === 1)
const mismatched = await groupRequestHandleTool.execute({ approve: false }, {
    originalUserMessage: '#c 同意申请',
    event: { group_id: '10001', user_id: '3559125985', isMaster: true, bot: global.Bot, group: { is_admin: true } }
})
check('模型参数与当前指令冲突时不得审核', typeof mismatched === 'string' && mismatched.includes('不一致') && calls.length === 1)

if (failures.length > 0) {
    console.error(`Group request eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Group request eval: ${passed} passed, 0 failed`)
}
