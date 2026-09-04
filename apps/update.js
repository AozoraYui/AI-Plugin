import plugin from '../../../lib/plugins/plugin.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAccess } from '../utils/access.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_DIR = path.resolve(__dirname, '..')
const execFileAsync = promisify(execFile)
let updateInProgress = false
const MAX_GIT_OUTPUT = 4000

function sanitizeGitOutput(value) {
    return String(value || '')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1***:***@')
        .replace(/(https?:\/\/[^\s?]+)[?&](?:token|access_token|password|passwd|key)=[^&\s]+/gi, '$1?[credential]=***')
        .slice(0, MAX_GIT_OUTPUT)
}

export class UpdateHandler extends plugin {
    constructor() {
        super({
            name: 'AI插件更新',
            dsc: 'git pull 更新 AI-Plugin',
            event: 'message',
            priority: 1150,
            rule: [
                { reg: /^#ai插件更新$/i, fnc: 'gitPull', permission: 'master' },
                { reg: /^#ai插件强制更新$/i, fnc: 'gitForceUpdate', permission: 'master' },
            ]
        })
    }

    async _runGit(args = []) {
        try {
            const result = await execFileAsync('git', args, {
                cwd: PLUGIN_DIR,
                encoding: 'utf-8',
                timeout: 60000,
                maxBuffer: 8 * 1024 * 1024,
                env: {
                    ...process.env,
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_ASKPASS: 'true',
                    SSH_ASKPASS: 'true',
                    GIT_OPTIONAL_LOCKS: '0'
                }
            })
            return { success: true, output: sanitizeGitOutput(result.stdout.trim() || '(无输出)') }
        } catch (err) {
            return { success: false, output: sanitizeGitOutput(err.stderr || err.stdout || err.message) }
        }
    }

    async _getRemoteBranch() {
        const result = await this._runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
        if (result.success && /^origin\/[\w./-]+$/.test(result.output)) return result.output
        return 'origin/main'
    }

    /** 获取 HEAD..远端分支的提交日志 */
    async _getChangelog(remoteRef) {
        const result = await this._runGit([
            'log', '--format=[%ad] %s', '--date=format:%Y-%m-%d %H:%M', `HEAD..${remoteRef}`
        ])
        if (!result.success || !result.output || result.output === '(无输出)') return null
        const lines = result.output.split('\n').filter(Boolean)
        return lines
    }

    async gitPull(e) {
        if (!e.isMaster) return e.reply('权限不足：插件更新仅限机器人主人使用。', true)
        if (!await checkAccess(e)) return true
        if (updateInProgress) return e.reply('⏳ 插件更新正在进行中，请不要重复触发。', true)

        updateInProgress = true
        await e.reply('🔄 正在检查更新...')
        try {
            const fetchResult = await this._runGit(['fetch', '--prune', 'origin'])
            if (!fetchResult.success) return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)

            const remoteRef = await this._getRemoteBranch()
            const localHash = await this._runGit(['rev-parse', 'HEAD'])
            const remoteHash = await this._runGit(['rev-parse', remoteRef])
            if (localHash.success && remoteHash.success && localHash.output === remoteHash.output) {
                return e.reply(`✅ 已是最新版本\n本地: ${localHash.output.slice(0, 7)}\n远程: ${remoteHash.output.slice(0, 7)}`)
            }

            const changelog = await this._getChangelog(remoteRef)
            const mergeResult = await this._runGit(['merge', '--ff-only', remoteRef])
            if (!mergeResult.success) return e.reply(`❌ 更新失败（仅允许快进合并）:\n${mergeResult.output}`)

            const newHash = await this._runGit(['rev-parse', 'HEAD'])
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'
            let msg = changelog?.length ? `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n${changelog.join('\n')}\n\n` : ''
            msg += `✅ 更新成功！\n当前版本: ${hashStr}\n\n更新内容:\n${mergeResult.output}`
            return e.reply(sanitizeGitOutput(msg))
        } finally {
            updateInProgress = false
        }
    }

    async gitForceUpdate(e) {
        if (!e.isMaster) return e.reply('权限不足：插件强制更新仅限机器人主人使用。', true)
        if (!await checkAccess(e)) return true
        if (updateInProgress) return e.reply('⏳ 插件更新正在进行中，请不要重复触发。', true)

        const match = e.msg.match(/^#ai插件强制更新\s*(.*)/i)
        const confirmParam = match ? match[1].trim() : ''

        if (confirmParam !== '确认') {
            return e.reply('⚠️ 强制更新将丢弃所有本地修改！\n\n如需继续，请发送：\n#ai插件强制更新 确认')
        }

        updateInProgress = true
        await e.reply('⚠️ 正在强制更新（将丢弃本地修改）...')
        try {
            const fetchResult = await this._runGit(['fetch', '--prune', 'origin'])
            if (!fetchResult.success) return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)
            const remoteRef = await this._getRemoteBranch()
            const changelog = await this._getChangelog(remoteRef)
            const resetResult = await this._runGit(['reset', '--hard', remoteRef])
            if (!resetResult.success) return e.reply(`❌ git reset 失败:\n${resetResult.output}`)
            const newHash = await this._runGit(['rev-parse', 'HEAD'])
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'
            const msg = changelog?.length
                ? `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n${changelog.join('\n')}\n\n✅ 强制更新成功！\n当前版本: ${hashStr}`
                : `✅ 强制更新成功！\n当前版本: ${hashStr}`
            return e.reply(sanitizeGitOutput(msg))
        } finally {
            updateInProgress = false
        }
    }
}
