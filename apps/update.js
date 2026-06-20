import plugin from '../../../lib/plugins/plugin.js'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAccess } from '../utils/access.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_DIR = path.resolve(__dirname, '..')

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

    _runGit(command) {
        try {
            const output = execSync(command, {
                cwd: PLUGIN_DIR,
                encoding: 'utf-8',
                timeout: 30000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
            })
            return { success: true, output: output.trim() || '(无输出)' }
        } catch (err) {
            return { success: false, output: err.stderr || err.message }
        }
    }

    /** 获取 HEAD..origin/main 的提交日志 */
    _getChangelog() {
        const result = this._runGit(
            'git log --format="[%ad] %s" --date=format:"%Y-%m-%d %H:%M" HEAD..origin/main'
        )
        if (!result.success || !result.output || result.output === '(无输出)') return null
        const lines = result.output.split('\n').filter(Boolean)
        return lines
    }

    async gitPull(e) {
        if (!e.isMaster) return e.reply('权限不足：插件更新仅限机器人主人使用。', true)
        if (!await checkAccess(e)) return true

        await e.reply('🔄 正在检查更新...')

        const fetchResult = this._runGit('git fetch origin')
        if (!fetchResult.success) {
            return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)
        }

        const localHash = this._runGit('git rev-parse HEAD')
        const remoteHash = this._runGit('git rev-parse origin/main')

        if (localHash.success && remoteHash.success && localHash.output === remoteHash.output) {
            return e.reply(`✅ 已是最新版本\n本地: ${localHash.output.slice(0, 7)}\n远程: ${remoteHash.output.slice(0, 7)}`)
        }

        // 获取更新日志
        const changelog = this._getChangelog()

        const pullResult = this._runGit('git pull origin main')
        if (pullResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'

            let msg = ''
            if (changelog && changelog.length > 0) {
                msg += `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n`
                msg += changelog.join('\n')
                msg += `\n\n`
            }
            msg += `✅ 更新成功！\n当前版本: ${hashStr}\n\n更新内容:\n${pullResult.output}`

            return e.reply(msg)
        } else {
            return e.reply(`❌ 更新失败:\n${pullResult.output}`)
        }
    }

    async gitForceUpdate(e) {
        if (!e.isMaster) return e.reply('权限不足：插件强制更新仅限机器人主人使用。', true)
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#ai插件强制更新\s*(.*)/i)
        const confirmParam = match ? match[1].trim() : ''

        if (confirmParam !== '确认') {
            return e.reply('⚠️ 强制更新将丢弃所有本地修改！\n\n如需继续，请发送：\n#ai插件强制更新 确认')
        }

        await e.reply('⚠️ 正在强制更新（将丢弃本地修改）...')

        // 先 fetch 获取远程信息
        const fetchResult = this._runGit('git fetch origin')
        if (!fetchResult.success) {
            return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)
        }

        // 获取更新日志（reset 之前）
        const changelog = this._getChangelog()

        const resetResult = this._runGit('git reset --hard origin/main')
        if (!resetResult.success) {
            return e.reply(`❌ git reset 失败:\n${resetResult.output}`)
        }

        const pullResult = this._runGit('git pull origin main')
        if (pullResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'

            let msg = ''
            if (changelog && changelog.length > 0) {
                msg += `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n`
                msg += changelog.join('\n')
                msg += `\n\n`
            }
            msg += `✅ 强制更新成功！\n当前版本: ${hashStr}\n\n${pullResult.output}`

            return e.reply(msg)
        } else {
            return e.reply(`❌ 强制更新失败:\n${pullResult.output}`)
        }
    }
}
