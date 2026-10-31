globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
globalThis.Config = globalThis.Config || {}

const { qqUserLookupTool } = await import('../tools/qq_user_lookup.js')

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

const apiCalls = []
const previousManager = globalThis.AIPluginConversationManager
globalThis.AIPluginConversationManager = {
    db: {
        async getGroupMessageLogs() { return [] },
        async getDirectMessageLogs() { return [] },
        async getConversationHistory() { return [] }
    }
}

const result = await qqUserLookupTool.execute({
    user_id: '3371466826',
    mode: 'common_groups'
}, {
    isMaster: true,
    event: {
        bot: {
            async sendApi(action, params) {
                apiCalls.push({ action, params })
                if (action === 'get_group_list') {
                    return {
                        retcode: 0,
                        data: {
                            groups: [
                                { group_id: '10001', group_name: '测试群' },
                                { group_id: '10002', group_name: '另一个群' }
                            ]
                        }
                    }
                }
                if (action === 'get_group_member_info' && String(params.group_id) === '10001') {
                    return {
                        retcode: 0,
                        data: { user_id: '3371466826', nickname: '目标用户', card: '测试名片' }
                    }
                }
                throw new Error('not a member')
            }
        }
    }
})

check('实时群查询识别包装后的 OneBot 返回值', result.ok === true && result.commonGroups.length === 1)
check('实时群查询保留群名和成员身份', result.commonGroups[0]?.groupId === '10001'
    && result.commonGroups[0]?.groupName === '测试群'
    && result.commonGroups[0]?.nickname === '目标用户'
    && result.commonGroups[0]?.card === '测试名片')
check('实时群查询检查机器人所在群', apiCalls.filter(call => call.action === 'get_group_member_info').length === 2)
check('非主人执行仍被拒绝', (await qqUserLookupTool.execute({ user_id: '3371466826' }, { isMaster: false }))?.ok === false)

if (previousManager === undefined) delete globalThis.AIPluginConversationManager
else globalThis.AIPluginConversationManager = previousManager

if (failures.length > 0) {
    console.error(`QQ user lookup eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`QQ user lookup eval: ${passed} passed, 0 failed`)
}
