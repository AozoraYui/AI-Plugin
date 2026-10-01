globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
globalThis.cfg = { masterQQ: [] }
globalThis.AIPluginClient = { enableGroupAdmin: true }

const {
    GROUP_INCREASE_KEY,
    groupMemberListTool,
    normalizeMemberInfo
} = await import('../tools/group_admin.js')

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

check('标准 join_time 会被保留并转换为毫秒', normalizeMemberInfo({ user_id: 1, join_time: 1700000000 }).joinTime === 1700000000000)

const records = new Map()
globalThis.redis = {
    async keys(pattern) {
        return [...records.keys()].filter(key => key.startsWith(pattern.replace('*', '')))
    },
    async get(key) {
        return records.get(key) || null
    }
}

function makeEvent(members) {
    return {
        group_id: '10001',
        user_id: '20001',
        sender: { role: 'admin' },
        group: { is_admin: true },
        bot: {
            async sendApi(action) {
                if (action !== 'get_group_member_list') throw new Error(`unexpected api: ${action}`)
                return { data: members }
            }
        }
    }
}

const directMembers = [
    { user_id: '10001', nickname: '旧成员', role: 'member', join_time: 1700000000 },
    { user_id: '10002', nickname: '新成员', role: 'member', join_time: 1800000000 }
]
const recent = await groupMemberListTool.execute({ recent_limit: 1 }, {
    event: makeEvent(directMembers),
    originalUserMessage: '#c 最近有哪些新成员？'
})
check('按真实 join_time 倒序返回最近成员', recent?.ok === true && recent.members.length === 1 && recent.members[0].userId === '10002', JSON.stringify(recent))
check('最近成员结果标记完整时间覆盖', recent?.knownJoinTimeCount === 2 && recent.recentUnavailable === false)
check('结果包含入群时间', groupMemberListTool.formatResult(recent).includes('入群时间：'))

const noTime = await groupMemberListTool.execute({}, {
    event: makeEvent([
        { user_id: '10003', nickname: '甲', role: 'member' },
        { user_id: '10004', nickname: '乙', role: 'member' }
    ]),
    originalUserMessage: '#c 最近有哪些新成员？'
})
check('没有任何时间时不猜测新成员', noTime?.recentUnavailable === true && noTime.members.length === 0)
check('没有时间时明确说明无法判断', /无法可靠判断/.test(groupMemberListTool.formatResult(noTime)))

records.set(GROUP_INCREASE_KEY('10001', '10004', 1900000000), JSON.stringify({
    group_id: '10001', user_id: '10004', join_time: 1900000000
}))
const fromHistory = await groupMemberListTool.execute({ recent_limit: 1 }, {
    event: makeEvent([
        { user_id: '10003', nickname: '甲', role: 'member' },
        { user_id: '10004', nickname: '乙', role: 'member' }
    ]),
    originalUserMessage: '#c 最近有哪些新成员？'
})
check('本地 group_increase 历史可补足缺失 join_time', fromHistory?.members[0]?.userId === '10004' && fromHistory.knownJoinTimeCount === 1)
check('历史覆盖不完整时保留提示', /结果可能不完整/.test(groupMemberListTool.formatResult(fromHistory)))

if (failures.length > 0) {
    console.error(`Group member eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Group member eval: ${passed} passed, 0 failed`)
}
