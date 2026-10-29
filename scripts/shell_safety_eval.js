import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveShellWorkingDirectory, validateShellDirectorySafety } from '../utils/shell_safety.js'
const { executeShellExecNow } = await import('../tools/shell_exec.js')

const failures = []
let passed = 0

function check(name, condition) {
    if (condition) {
        passed++
        return
    }
    failures.push(name)
}

const previousCwd = process.cwd()
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-plugin-shell-safety-'))
const pluginRoot = path.join(runtimeRoot, 'plugins', 'AI-Plugin')
fs.mkdirSync(pluginRoot, { recursive: true })

try {
    process.chdir(runtimeRoot)

    const autoSelected = resolveShellWorkingDirectory({
        command: 'git pull',
        currentDirectory: runtimeRoot,
        userMessage: '#c 更新一下插件，然后看下这次更新了什么'
    })
    check('明确更新插件且未提供 cwd 时自动选择插件根目录', autoSelected.autoSelected === true
        && autoSelected.directory === pluginRoot)

    const executed = await executeShellExecNow({ command: 'pwd' }, {
        userMessage: '#c 查看插件目录'
    })
    check('真实 shell 执行会使用自动选择的插件目录', executed.success === true
        && executed.cwd === pluginRoot
        && executed.stdout.trim() === pluginRoot)

    const safety = validateShellDirectorySafety({
        command: 'git pull',
        cwd: autoSelected.directory,
        userMessage: '#c 更新一下插件，然后看下这次更新了什么'
    })
    check('自动选择后的插件目录通过安全检查', safety.ok === true)

    const explicitCwd = resolveShellWorkingDirectory({
        cwd: runtimeRoot,
        command: 'git pull',
        currentDirectory: runtimeRoot,
        userMessage: '#c 更新一下插件'
    })
    check('显式 cwd 优先于自动目录选择', explicitCwd.autoSelected === false
        && explicitCwd.directory === runtimeRoot)
    check('显式错误 cwd 不会被安全自动修正', validateShellDirectorySafety({
        command: 'git pull',
        cwd: explicitCwd.directory,
        userMessage: '#c 更新一下插件'
    }).ok === false)

    const explicitCommandDirectory = resolveShellWorkingDirectory({
        command: `git -C ${pluginRoot} pull`,
        currentDirectory: runtimeRoot,
        userMessage: '#c 更新一下插件'
    })
    check('git -C 显式目录优先于自动目录选择', explicitCommandDirectory.autoSelected === false
        && explicitCommandDirectory.effectiveDirectory === pluginRoot)

    const compoundCommand = resolveShellWorkingDirectory({
        command: `echo start; cd ${pluginRoot} && git pull`,
        currentDirectory: runtimeRoot,
        userMessage: '#c 更新一下插件'
    })
    check('复杂命令含目录切换时不自动注入目录', compoundCommand.autoSelected === false)

    const unrelated = resolveShellWorkingDirectory({
        command: 'git pull',
        currentDirectory: runtimeRoot,
        userMessage: '#c 更新服务器主仓库'
    })
    check('未明确指向插件时不擅自切换到插件目录', unrelated.autoSelected === false
        && unrelated.directory === runtimeRoot)

    process.chdir(pluginRoot)
    const pluginRuntime = resolveShellWorkingDirectory({
        command: 'git pull',
        currentDirectory: pluginRoot,
        userMessage: '#c 更新一下插件'
    })
    check('运行时已在插件目录时保持原工作目录', pluginRuntime.autoSelected === false
        && pluginRuntime.directory === pluginRoot)
} finally {
    process.chdir(previousCwd)
    fs.rmSync(runtimeRoot, { recursive: true, force: true })
}

if (failures.length > 0) {
    console.error(`Shell safety eval: ${passed} passed, ${failures.length} failed`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
} else {
    console.log(`Shell safety eval: ${passed} passed, 0 failed`)
}
