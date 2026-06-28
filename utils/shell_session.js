import { execFile } from 'node:child_process'
import path from 'node:path'
import { Config } from './config.js'
import { validateShellDirectorySafety } from './shell_safety.js'

const TMUX_TIMEOUT_MS = 5000

function execTmux(args = [], options = {}) {
    return new Promise((resolve, reject) => {
        execFile('tmux', args, {
            timeout: options.timeoutMs || TMUX_TIMEOUT_MS,
            maxBuffer: options.maxBuffer || 1024 * 1024,
            windowsHide: true
        }, (error, stdout = '', stderr = '') => {
            if (error) {
                error.stdout = stdout
                error.stderr = stderr
                reject(error)
                return
            }
            resolve({ stdout, stderr })
        })
    })
}

export function normalizeShellSessionName(name = Config.SHELL_SESSION_NAME) {
    const value = String(name || 'ai-shell').trim()
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
        throw new Error('Shell 会话名只能包含字母、数字、下划线、点和短横线，长度 1-64。')
    }
    return value
}

async function readPaneCurrentPath(sessionName, fallback = process.cwd()) {
    try {
        const { stdout } = await execTmux(['display-message', '-p', '-t', sessionName, '#{pane_current_path}'])
        return path.resolve(stdout.trim() || fallback || process.cwd())
    } catch {
        return path.resolve(fallback || process.cwd())
    }
}

export async function hasShellSession(sessionName = Config.SHELL_SESSION_NAME) {
    const name = normalizeShellSessionName(sessionName)
    try {
        await execTmux(['has-session', '-t', name])
        return { ok: true, exists: true, sessionName: name }
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { ok: false, exists: false, sessionName: name, error: '未找到 tmux，请先在服务器安装 tmux。' }
        }
        if (err.code === 1) {
            return { ok: true, exists: false, sessionName: name }
        }
        return { ok: false, exists: false, sessionName: name, error: err.stderr || err.message || String(err) }
    }
}

export async function ensureShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const cwd = path.resolve(options.cwd || process.cwd())
    const status = await hasShellSession(sessionName)
    if (!status.ok) return status
    if (status.exists) {
        const currentDirectory = await readPaneCurrentPath(sessionName, cwd)
        return { ok: true, exists: true, created: false, sessionName, cwd, currentDirectory }
    }

    try {
        await execTmux(['new-session', '-d', '-s', sessionName, '-c', cwd])
        return { ok: true, exists: true, created: true, sessionName, cwd, currentDirectory: cwd }
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { ok: false, exists: false, sessionName, cwd, error: '未找到 tmux，请先在服务器安装 tmux。' }
        }
        return { ok: false, exists: false, sessionName, cwd, error: err.stderr || err.message || String(err) }
    }
}

export async function captureShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const lines = Math.min(Math.max(Number(options.lines) || Config.SHELL_SESSION_CAPTURE_LINES, 20), 2000)
    const ensured = await ensureShellSession({ sessionName, cwd: options.cwd })
    if (!ensured.ok) return ensured

    try {
        const { stdout } = await execTmux(['capture-pane', '-t', sessionName, '-p', '-S', `-${lines}`], {
            maxBuffer: Math.max(Config.SHELL_SESSION_MAX_OUTPUT_CHARS * 2, 1024 * 1024)
        })
        const maxChars = Math.max(Number(options.maxOutputChars) || Config.SHELL_SESSION_MAX_OUTPUT_CHARS, 1000)
        const output = stdout.length > maxChars ? stdout.slice(-maxChars) : stdout
        return {
            ok: true,
            sessionName,
            currentDirectory: ensured.currentDirectory || await readPaneCurrentPath(sessionName, ensured.cwd),
            lines,
            output,
            truncated: stdout.length > maxChars,
            totalChars: stdout.length
        }
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}

export async function getShellSessionCurrentPath(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const ensured = await ensureShellSession({ sessionName, cwd: options.cwd })
    if (!ensured.ok) return ensured
    const currentDirectory = ensured.currentDirectory || await readPaneCurrentPath(sessionName, ensured.cwd)
    return { ok: true, sessionName, currentDirectory }
}

export async function sendToShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const input = String(options.input || '')
    if (!input.trim()) return { ok: false, sessionName, error: '缺少要发送到 Shell 会话的 input。' }
    if (input.length > 4000) return { ok: false, sessionName, error: '输入过长：最多 4000 字符。' }
    if (input.includes('\0')) return { ok: false, sessionName, error: '输入包含非法 NUL 字符。' }

    const ensured = await ensureShellSession({ sessionName, cwd: options.cwd })
    if (!ensured.ok) return ensured
    const pathStatus = await getShellSessionCurrentPath({ sessionName, cwd: options.cwd })
    if (!pathStatus.ok) return pathStatus

    const directorySafety = validateShellDirectorySafety({
        command: input,
        cwd: pathStatus.currentDirectory,
        userMessage: options.userMessage || '',
        toolName: 'shell_session'
    })
    if (!directorySafety.ok) {
        return {
            ok: false,
            sessionName,
            input,
            enter: options.enter !== false,
            currentDirectory: pathStatus.currentDirectory,
            error: `${directorySafety.reason} 已停止输入，命令没有发送到 tmux。请先向主人确认下一步应该切换到哪个目录或如何处理。`,
            directorySafety
        }
    }

    try {
        await execTmux(['send-keys', '-t', sessionName, '--', input])
        if (options.enter !== false) {
            await execTmux(['send-keys', '-t', sessionName, 'C-m'])
        }
        return { ok: true, sessionName, input, enter: options.enter !== false, currentDirectory: pathStatus.currentDirectory, directorySafety }
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}

export async function interruptShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const ensured = await ensureShellSession({ sessionName, cwd: options.cwd })
    if (!ensured.ok) return ensured
    try {
        await execTmux(['send-keys', '-t', sessionName, 'C-c'])
        return { ok: true, sessionName }
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}

export async function clearShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const ensured = await ensureShellSession({ sessionName, cwd: options.cwd })
    if (!ensured.ok) return ensured
    try {
        await execTmux(['send-keys', '-t', sessionName, 'C-l'])
        await execTmux(['clear-history', '-t', sessionName])
        return { ok: true, sessionName }
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}

export async function restartShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const status = await hasShellSession(sessionName)
    if (!status.ok) return status
    try {
        if (status.exists) await execTmux(['kill-session', '-t', sessionName])
        return await ensureShellSession({ sessionName, cwd: options.cwd })
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}

export async function closeShellSession(options = {}) {
    const sessionName = normalizeShellSessionName(options.sessionName || Config.SHELL_SESSION_NAME)
    const status = await hasShellSession(sessionName)
    if (!status.ok) return status
    if (!status.exists) return { ok: true, sessionName, closed: false, message: 'Shell 会话不存在，无需关闭。' }
    try {
        await execTmux(['kill-session', '-t', sessionName])
        return { ok: true, sessionName, closed: true }
    } catch (err) {
        return { ok: false, sessionName, error: err.stderr || err.message || String(err) }
    }
}
