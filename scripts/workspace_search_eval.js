globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }

const { scoreWorkspaceFilenameMatch } = await import('../tools/workspace.js')
const { normalizeFuzzyFileName } = await import('../utils/file_access.js')

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

check('自然语言文件名会去除“的插件”等后缀', normalizeFuzzyFileName('网页截图Pro的插件') === '网页截图pro')
check('完整文件名请求命中目标文件', scoreWorkspaceFilenameMatch('网页截图Pro.js', '网页截图Pro的插件') >= 95)
check('“名字接近”请求仍命中目标文件', scoreWorkspaceFilenameMatch('网页截图Pro.js', '名字接近的网页截图Pro的插件') >= 95)
check('相近中文文件名可以被召回', scoreWorkspaceFilenameMatch('网页截图工具V1.0.js', '网页截图Pro') > 0)
check('无关中文文件名不会被误召回', scoreWorkspaceFilenameMatch('下载依赖.js', '网页截图Pro') === 0)

if (failures.length > 0) {
    console.error(`Workspace search eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Workspace search eval: ${passed} passed, 0 failed`)
}
