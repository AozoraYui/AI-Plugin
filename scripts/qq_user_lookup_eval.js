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
check('正常不在群不计入接口失败', result.notMemberGroups === 1 && result.failedGroups === 0)
check('正常不在群的最终文本不误报接口失败', /明确不在群 1 个/.test(qqUserLookupTool.formatResult(result))
    && !/成员查询失败|结果可能不完整/.test(qqUserLookupTool.formatResult(result)))
check('实时群查询检查机器人所在群', apiCalls.filter(call => call.action === 'get_group_member_info').length === 2)

let groupListAttempts = 0
let transientAttempts = 0
let fallbackListCalls = 0
const recovered = await qqUserLookupTool.execute({
    user_id: '3371466826',
    mode: 'common_groups'
}, {
    isMaster: true,
    event: {
        bot: {
            async sendApi(action, params) {
                if (action === 'get_group_list') {
                    groupListAttempts++
                    if (groupListAttempts === 1) throw new Error('ECONNRESET')
                    return [
                        { group_id: '20001', group_name: '重试群' },
                        { group_id: '20002', group_name: '降级群' },
                        { group_id: '20003', group_name: '异常群' }
                    ]
                }
                if (action === 'get_group_member_info' && String(params.group_id) === '20001') {
                    transientAttempts++
                    if (transientAttempts === 1) throw new Error('socket hang up')
                    return { user_id: '3371466826', nickname: '重试成功' }
                }
                if (action === 'get_group_member_info' && String(params.group_id) === '20002') {
                    throw new Error('unsupported action')
                }
                if (action === 'get_group_member_info' && String(params.group_id) === '20003') {
                    throw new Error('permission denied')
                }
                if (action === 'get_group_member_list' && String(params.group_id) === '20002') {
                    fallbackListCalls++
                    return { data: { members: [{ user_id: '3371466826', nickname: '降级成功' }] } }
                }
                if (action === 'get_group_member_list' && String(params.group_id) === '20003') {
                    throw new Error('permission denied')
                }
                throw new Error(`unexpected api: ${action}`)
            }
        }
    }
})
check('群列表临时连接错误会有限重试并恢复', groupListAttempts === 2 && recovered.commonGroups.length === 2)
check('成员查询临时连接错误会有限重试并恢复', transientAttempts === 2
    && recovered.commonGroups.some(group => group.groupId === '20001')
    && recovered.transientFailures === 0)
check('成员信息接口异常会降级成员列表', fallbackListCalls === 1
    && recovered.commonGroups.some(group => group.groupId === '20002'))
check('真实权限/接口异常仍标记结果不完整', recovered.failedGroups === 1
    && recovered.apiFailures === 1
    && recovered.warnings.some(warning => /接口异常 1 个/.test(warning)))
check('非主人执行仍被拒绝', (await qqUserLookupTool.execute({ user_id: '3371466826' }, { isMaster: false }))?.ok === false)

if (previousManager === undefined) delete globalThis.AIPluginConversationManager
else globalThis.AIPluginConversationManager = previousManager

if (failures.length > 0) {
    console.error(`QQ user lookup eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`QQ user lookup eval: ${passed} passed, 0 failed`)
}
