/**
 * 服务器系统信息查询工具
 * 查询 CPU、内存、温度、磁盘、负载等系统状态
 */

import { toolRegistry } from './registry.js'
import { execSync } from 'node:child_process'

function safeExec(command) {
    try {
        const output = execSync(command, {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        return output.trim() || '(无输出)'
    } catch (err) {
        return `(命令失败: ${err.message})`
    }
}

async function getSystemInfo() {
    const info = {}

    // 主机名
    info.hostname = safeExec('hostname')

    // 运行时间
    info.uptime = safeExec('uptime')

    // 系统版本
    info.os_version = safeExec('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\' || echo N/A')

    // CPU 型号
    info.cpu_model = safeExec("cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1 | cut -d: -f2 | xargs || echo N/A")

    // CPU 核心数
    info.cpu_cores = safeExec("nproc 2>/dev/null || echo N/A")

    // CPU 负载 (1/5/15分钟)
    info.loadavg = safeExec("cat /proc/loadavg 2>/dev/null || echo N/A")

    // 内存使用
    info.memory = safeExec("free -h 2>/dev/null | head -3 || echo N/A")

    // 磁盘使用
    info.disk = safeExec("df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2 || echo N/A")

    // CPU 温度 (需要 lm-sensors)
    const sensorsRaw = safeExec("sensors 2>/dev/null | grep -E '(Core|Package|temp|Tdie|Tctl|Composite)' | head -10 || echo N/A")
    info.temperature = (sensorsRaw.includes('(命令失败') || sensorsRaw === 'N/A')
        ? '(未安装 sensors 或传感器不可用)' : sensorsRaw

    // CPU 当前频率
    info.cpu_freq = safeExec("cat /proc/cpuinfo 2>/dev/null | grep 'cpu MHz' | head -4 | awk '{print $4}' | xargs -I{} echo '{} MHz' || lscpu 2>/dev/null | grep 'CPU MHz' || echo N/A")

    // 进程数
    info.processes = safeExec("ps aux --no-headers 2>/dev/null | wc -l || echo N/A")

    // fastfetch / neofetch（优先 fastfetch，其次 neofetch，降级为纯文本）
    const fastfetchRaw = safeExec('fastfetch --pipe 2>/dev/null || neofetch --stdout 2>/dev/null')
    info.fastfetch = fastfetchRaw.includes('(命令失败') ? '' : fastfetchRaw

    // 格式化为文本
    let text = '\n\n【以下是从服务器获取到的实时系统状态信息：】\n'

    // fastfetch/neofetch 优先展示（信息最全）
    if (info.fastfetch) {
        text += `\n\`\`\`\n${info.fastfetch}\n\`\`\`\n`
        // 补充 fastfetch 没有覆盖的信息
        if (info.temperature && !info.temperature.includes('不可用')) {
            text += `\n🌡️ 温度:\n${info.temperature}\n`
        }
        if (info.processes && info.processes !== 'N/A') {
            text += `\n🔢 进程数: ${info.processes}`
        }
    } else {
        // 降级：传统格式
        text += `\n🖥️ 主机名: ${info.hostname}`
        text += `\n📋 系统版本: ${info.os_version}`
        text += `\n\n⏱️ 运行时间与负载:\n${info.uptime}`
        text += `\n负载: ${info.loadavg}`
        text += `\n\n🧠 CPU: ${info.cpu_model}`
        text += `\n核心数: ${info.cpu_cores}`
        text += `\n频率: ${info.cpu_freq}`
        text += `\n\n🌡️ 温度:\n${info.temperature}`
        text += `\n\n💾 内存:\n${info.memory}`
        text += `\n📀 磁盘:\n${info.disk}`
        text += `\n🔢 进程数: ${info.processes}`
    }
    text += `\n【系统信息结束】\n`

    return text
}

export const systemInfoTool = {
    name: 'system_info',
    description: '查询服务器系统状态：CPU、内存、温度、磁盘、负载等。当用户询问服务器状态或系统信息时使用。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'system_info',
            description: '查询服务器实时系统状态（CPU、内存、温度、磁盘、负载等）',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },

    async execute() {
        const info = await getSystemInfo()
        return info
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(systemInfoTool)