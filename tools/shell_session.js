/**
 * 持久 Shell 会话工具
 * 仅主人可用；通过 tmux 维护一个独立的 ai-shell 窗口。
 */

import { toolRegistry } from './registry.js'
import { Config } from '../utils/config.js'
import {
    captureShellSession,
    clearShellSession,
    closeShellSession,
    ensureShellSession,
    interruptShellSession,
    restartShellSession,
    sendToShellSession
} from '../utils/shell_session.js'

const ACTION_LABELS = {
    status: '查看状态',
    read: '读取窗口',
    send: '发送输入',
    interrupt: '中断任务',
    clear: '清屏',
    restart: '重启会话',
    close: '关闭会话'
}

function normalizeAction(action = 'read') {
    const value = String(action || '').trim().toLowerCase()
    if (['status', 'read', 'send', 'interrupt', 'clear', 'restart', 'close'].includes(value)) return value
    return 'read'
}

function limitLines(lines) {
    const value = Number(lines)
    if (!Number.isFinite(value)) return Config.SHELL_SESSION_CAPTURE_LINES
    return Math.min(Math.max(Math.trunc(value), 20), 2000)
}

export const shellSessionTool = {
    name: 'shell_session',
    permission: 'master',
    description: '操作持久 tmux Shell 会话（默认 ai-shell）：读取窗口、发送命令、Ctrl-C 中断、清屏、重启或关闭。仅主人，需开启 enable_shell_session。适合长任务、dev server、tail 日志和交互式排查。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'shell_session',
            description: '操作主人专用的持久 tmux Shell 会话。会话名由配置 SHELL_SESSION_NAME 控制，默认 ai-shell。',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['status', 'read', 'send', 'interrupt', 'clear', 'restart', 'close'],
                        description: '操作类型：status 查看/确保会话，read 读取窗口输出，send 输入命令或文本，interrupt 发送 Ctrl-C，clear 清屏，restart 重启会话，close 关闭会话。'
                    },
                    input: {
                        type: 'string',
                        description: 'action=send 时必填，要输入到 tmux 会话的命令或文本。'
                    },
                    enter: {
                        type: 'boolean',
                        description: 'action=send 时是否自动回车，默认 true。需要只输入不执行时设为 false。'
                    },
                    lines: {
                        type: 'number',
                        description: '读取最近多少行窗口内容；action=send 后自动回读也会使用该行数。默认使用 SHELL_SESSION_CAPTURE_LINES，范围 20-2000。'
                    },
                    read_after_send: {
                        type: 'boolean',
                        description: 'action=send 时是否在发送并回车后自动读取 tmux 窗口输出，默认 true。长任务只会读取快照，不会等待任务结束。'
                    },
                    after_send_delay_ms: {
                        type: 'number',
                        description: 'action=send 自动回读第一次检查前等待的毫秒数，默认使用 SHELL_SESSION_AFTER_SEND_DELAY_MS。'
                    },
                    after_send_timeout_ms: {
                        type: 'number',
                        description: 'action=send 自动回读最多等待多久，默认 64000ms；期间检测到窗口出现新输出就返回，超时则返回当前快照。'
                    },
                    after_send_poll_ms: {
                        type: 'number',
                        description: 'action=send 自动回读轮询间隔，默认 1000ms。'
                    },
                    cwd: {
                        type: 'string',
                        description: '创建或重启会话时的工作目录；已有会话不会被 cd。'
                    }
                },
                required: ['action']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!context.isMaster && !event?.isMaster) {
            return { ok: false, error: '权限不足：持久 Shell 会话仅限主人使用。' }
        }
        if (global.AIPluginClient?.enableShellSession !== true) {
            return { ok: false, error: '持久 Shell 会话未启用。请先在 models_config.yaml 设置 enable_shell_session: true。' }
        }

        const action = normalizeAction(args.action)
        let result
        if (action === 'status') {
            result = await ensureShellSession({ cwd: args.cwd })
        } else if (action === 'read') {
            result = await captureShellSession({
                cwd: args.cwd,
                lines: limitLines(args.lines),
                maxOutputChars: Config.SHELL_SESSION_MAX_OUTPUT_CHARS
            })
        } else if (action === 'send') {
            result = await sendToShellSession({
                cwd: args.cwd,
                input: args.input,
                enter: args.enter !== false,
                userMessage: context.userMessage || context.originalUserMessage || '',
                readAfterSend: args.read_after_send !== false,
                afterSendDelayMs: args.after_send_delay_ms,
                afterSendTimeoutMs: args.after_send_timeout_ms,
                afterSendPollMs: args.after_send_poll_ms,
                lines: limitLines(args.lines),
                maxOutputChars: Config.SHELL_SESSION_MAX_OUTPUT_CHARS
            })
        } else if (action === 'interrupt') {
            result = await interruptShellSession({ cwd: args.cwd })
        } else if (action === 'clear') {
            result = await clearShellSession({ cwd: args.cwd })
        } else if (action === 'restart') {
            result = await restartShellSession({ cwd: args.cwd })
        } else if (action === 'close') {
            result = await closeShellSession()
        }

        if (result?.ok) {
            logger.info(`[AI-Plugin] shell_session ${action} 完成: session=${result.sessionName || Config.SHELL_SESSION_NAME}`)
        } else {
            logger.warn(`[AI-Plugin] shell_session ${action} 失败: ${result?.error || '未知错误'}`)
        }

        return { action, actionLabel: ACTION_LABELS[action] || action, ...result }
    },

    formatResult(data) {
        if (!data || typeof data !== 'object') return String(data || '')
        const name = data.sessionName || Config.SHELL_SESSION_NAME
        if (data.ok === false) {
            let output = `\n\n【Shell会话失败】动作: ${data.actionLabel || data.action || '未知'}\n会话: ${name}\n原因: ${data.error || '未知错误'}`
            if (data.directorySafety?.safetyBlocked) {
                output += `\n\n【目录安全检查】已阻止执行，命令没有发送到 tmux。`
                output += `\n当前目录: ${data.directorySafety.currentDirectory}`
                output += `\n生效目录: ${data.directorySafety.effectiveDirectory}`
                output += `\n期望目录: ${data.directorySafety.expectedDirectory}`
                output += `\n处理建议: 请反问主人下一步要切换到哪个目录或是否仍要继续。`
            }
            return output
        }

        let output = `\n\n【Shell会话结果】\n动作: ${data.actionLabel || data.action}\n会话: ${name}\n状态: 成功`
        if (data.created) output += `\n提示: 会话不存在，已自动创建。`
        if (data.directorySafety?.safetyBlocked) {
            output += `\n\n【目录安全检查】已阻止执行，命令没有发送到 tmux。`
            output += `\n原因: ${data.directorySafety.reason}`
            output += `\n当前目录: ${data.directorySafety.currentDirectory}`
            output += `\n生效目录: ${data.directorySafety.effectiveDirectory}`
            output += `\n期望目录: ${data.directorySafety.expectedDirectory}`
            output += `\n处理建议: 请反问主人下一步要切换到哪个目录或是否仍要继续。`
        }
        if (data.cwd) output += `\n目录: ${data.cwd}`
        if (data.currentDirectory) output += `\n当前目录: ${data.currentDirectory}`
        if (data.closed !== undefined) output += `\n是否关闭: ${data.closed ? '是' : '否'}`
        if (data.enter !== undefined) output += `\n是否回车: ${data.enter ? '是' : '否'}`
        if (data.readAfterSend) {
            output += `\n自动回读: 是，先等 ${data.afterSendDelayMs || 0}ms，最多等待 ${data.afterSendTimeoutMs || 0}ms，轮询 ${data.afterSendPollMs || 0}ms`
            output += `\n回读状态: ${data.outputChanged ? '检测到新输出' : (data.waitTimedOut ? '等待超时，返回当前快照' : '已读取快照')}`
            if (data.readAttempts) output += `，检查 ${data.readAttempts} 次，耗时 ${data.waitElapsedMs || 0}ms`
        }
        if (data.readError) output += `\n回读失败: ${data.readError}`
        if (data.truncated) output += `\n提示: 输出较长，仅显示末尾 ${Config.SHELL_SESSION_MAX_OUTPUT_CHARS} 字符。`
        if (data.output) output += `\n\n--- tmux窗口输出 ---\n${data.output}`
        output += `\n【Shell会话结果结束】\n`
        return output
    }
}

toolRegistry.register(shellSessionTool)
