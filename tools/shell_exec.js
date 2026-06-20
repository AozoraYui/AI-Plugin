/**
 * 本地 Shell 执行工具
 * 仅主人可用；仅在 enable_shell_exec 开启后进入工具路由（开启即默认具备文件读取能力）。
 */

import { exec } from 'node:child_process'
import path from 'node:path'
import { toolRegistry } from './registry.js'
import { Config } from '../utils/config.js'

function paginateText(text, offset, pageSize) {
    const full = String(text || '')
    const total = full.length
    if (total === 0) return { text: '', total: 0, start: 0, end: 0, hasMore: false, nextOffset: 0 }
    const start = Math.min(Math.max(offset, 0), total)
    const end = Math.min(start + pageSize, total)
    return {
        text: full.slice(start, end),
        total,
        start,
        end,
        hasMore: end < total,
        nextOffset: end
    }
}

function runShellCommand(command, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || Config.SHELL_EXEC_TIMEOUT_MS, 1000), Config.SHELL_EXEC_MAX_TIMEOUT_MS)
    const maxBuffer = Math.max(Config.SHELL_EXEC_MAX_BUFFER || 10485760, 1048576)
    const cwd = options.cwd || process.cwd()

    return new Promise((resolve) => {
        const startedAt = Date.now()
        exec(command, {
            cwd,
            timeout,
            maxBuffer,
            shell: '/bin/bash',
            windowsHide: true
        }, (error, stdout = '', stderr = '') => {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
            resolve({
                command,
                cwd,
                success: !error,
                code: error?.code ?? 0,
                signal: error?.signal || null,
                timedOut: error?.killed === true && error?.signal === 'SIGTERM',
                elapsed,
                stdout,
                stderr,
                error: error?.message || ''
            })
        })
    })
}

export const shellExecTool = {
    name: 'shell_exec',
    permission: 'master',
    description: '在服务器上执行 Shell 命令并返回 stdout/stderr。拥有完整命令权限，仅限主人，需开启 enable_shell_exec。适合查找文件、grep/rg 搜索、查看日志、诊断服务状态、执行用户明确要求的服务器操作。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'shell_exec',
            description: '在服务器上执行 Shell 命令并返回输出。仅限主人，完整权限。',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '要执行的完整 shell 命令，例如 pwd、ls -la、rg "关键词" /path、git status 等'
                    },
                    cwd: {
                        type: 'string',
                        description: '可选，命令工作目录。默认插件当前工作目录。'
                    },
                    timeout_ms: {
                        type: 'number',
                        description: '可选，超时时间毫秒。默认使用配置 SHELL_EXEC_TIMEOUT_MS。'
                    },
                    max_output_chars: {
                        type: 'number',
                        description: '可选，单页返回给模型的最大输出字符数。默认使用配置 SHELL_EXEC_MAX_OUTPUT_CHARS。输出超过此值时分页返回，不会丢数据。'
                    },
                    offset_chars: {
                        type: 'number',
                        description: '可选，分页游标。从该字符位置开始返回输出，用于翻页读取超长结果的后续部分。默认 0（从头开始）。'
                    }
                },
                required: ['command']
            }
        }
    },

    async execute(args = {}) {
        const command = String(args.command || '').trim()
        if (!command) return '【Shell执行失败】未提供 command。'

        const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd()
        // 单页大小：仍受 SHELL_EXEC_MAX_OUTPUT_CHARS 约束，避免单次请求超出模型上下文
        const pageSize = Math.min(
            Math.max(Number(args.max_output_chars) || Config.SHELL_EXEC_MAX_OUTPUT_CHARS, 1000),
            Config.SHELL_EXEC_MAX_OUTPUT_CHARS
        )
        const offset = Math.max(Number(args.offset_chars) || 0, 0)
        const result = await runShellCommand(command, { cwd, timeoutMs: args.timeout_ms })

        // 分页（不丢数据）：超长输出按游标分页，模型可通过 offset_chars 翻页读取后续部分
        const stdoutPage = paginateText(result.stdout, offset, pageSize)
        const stderrPage = paginateText(result.stderr, offset, pageSize)

        return {
            ...result,
            stdout: stdoutPage.text,
            stderr: stderrPage.text,
            paging: {
                offset,
                pageSize,
                stdoutTotal: stdoutPage.total,
                stderrTotal: stderrPage.total,
                hasMore: stdoutPage.hasMore || stderrPage.hasMore,
                nextOffset: Math.max(stdoutPage.nextOffset, stderrPage.nextOffset)
            }
        }
    },

    formatResult(data) {
        if (!data || typeof data !== 'object') return String(data || '')
        const status = data.success ? '成功' : '失败'
        let output = `\n\n【Shell执行结果】\n命令: ${data.command}\n目录: ${data.cwd}\n状态: ${status}`
        output += `\n退出码: ${data.code}`
        if (data.signal) output += `\n信号: ${data.signal}`
        if (data.timedOut) output += `\n是否超时: 是`
        output += `\n耗时: ${data.elapsed}s`
        const p = data.paging
        if (p && (p.stdoutTotal > p.pageSize || p.stderrTotal > p.pageSize || p.offset > 0)) {
            const shownEnd = Math.min(p.offset + p.pageSize, Math.max(p.stdoutTotal, p.stderrTotal))
            output += `\n分页: 已显示第 ${p.offset}~${shownEnd} 字符 / 共 ${Math.max(p.stdoutTotal, p.stderrTotal)} 字符`
            if (p.hasMore) {
                output += `\n⚠ 输出未读完，如需后续内容，再次调用 shell_exec 并传入相同 command 与 offset_chars=${p.nextOffset}（建议优先用 jq/grep/awk/sed 精确过滤减少数据量）`
            } else {
                output += `（已读完）`
            }
        }
        output += `\n`
        if (data.stdout) output += `\n--- stdout ---\n${data.stdout}\n`
        if (data.stderr) output += `\n--- stderr ---\n${data.stderr}\n`
        if (data.error && !data.stderr) output += `\n--- error ---\n${data.error}\n`
        output += '【Shell执行结果结束】\n'
        return output
    }
}

toolRegistry.register(shellExecTool)
