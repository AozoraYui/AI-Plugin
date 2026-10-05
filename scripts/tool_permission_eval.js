globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
globalThis.Config = globalThis.Config || {}
const { toolRegistry } = await import('../tools/index.js')

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

const masterArgs = {
    system_info: {},
    file_send: { path: '/tmp/not-used-by-permission-test' },
    file_download: {},
    group_file_list: {},
    group_file_download: {},
    group_send_message: { message: '权限测试' },
    group_leave: { target: '权限测试群' },
    shell_exec: { command: 'true' },
    config_manage: { action: 'read', path: '/tmp/not-used-by-permission-test.yml' },
    workspace_list: { path: '/tmp/not-used-by-permission-test' },
    workspace_survey: { path: '/tmp/not-used-by-permission-test' },
    workspace_search: { path: '/tmp/not-used-by-permission-test', query: 'x', mode: 'filename' },
    workspace_read: { path: '/tmp/not-used-by-permission-test' },
    workspace_patch: { path: '/tmp/not-used-by-permission-test', old_text: 'x', new_text: 'y' },
    workspace_verify: { path: '/tmp/not-used-by-permission-test' },
    shell_session: { action: 'status' },
    web_fetch: { url: 'https://example.com' },
    qq_user_lookup: { user_id: '114514' }
}

const masterTools = toolRegistry.getToolNames().filter(name => toolRegistry.get(name)?.permission === 'master')
check('主人专用工具清单完整', masterTools.length === Object.keys(masterArgs).length, `${masterTools.length} registered vs ${Object.keys(masterArgs).length} fixtures`)
check('非主人候选过滤移除主人专用工具', toolRegistry.getToolsForActor([...masterTools, 'weather'], false).join(',') === 'weather')
check('主人候选保留主人专用工具', toolRegistry.getToolsForActor(masterTools, true).length === masterTools.length)

for (const name of masterTools) {
    const result = await toolRegistry.execute(name, masterArgs[name], false, { userId: 'not-master' })
    check(`非主人执行 ${name} 被硬拦截`, result?.success === false && /权限不足/.test(String(result.error || '')), JSON.stringify(result))
}

check('公开工具不标记为主人专用', ['web_search', 'weather', 'draw_image', 'memory_search', 'group_chat_context'].every(name => toolRegistry.get(name)?.permission !== 'master'))

if (failures.length > 0) {
    console.error(`Tool permission eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Tool permission eval: ${passed} passed, 0 failed`)
}
