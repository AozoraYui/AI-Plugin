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
                { reg: /^#gemini插件更新$/i, fnc: 'gitPull' },
                { reg: /^#gemini插件强制更新$/i, fnc: 'gitForceUpdate' },
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

    async gitPull(e) {
        if (!await checkAccess(e)) return true

        await e.reply('🔄 正在检查更新...')

        const fetchResult = this._runGit('git fetch origin')
        if (!fetchResult.success) {
            return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)
        }

        const localHash = this._runGit('git rev-parse HEAD')
        const remoteHash = this._runGit('git rev-parse origin/master')

        if (localHash.success && remoteHash.success && localHash.output === remoteHash.output) {
            return e.reply(`✅ 已是最新版本\n本地: ${localHash.output.slice(0, 7)}\n远程: ${remoteHash.output.slice(0, 7)}`)
        }

        const pullResult = this._runGit('git pull origin master')
        if (pullResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'
            return e.reply(`✅ 更新成功！\n当前版本: ${hashStr}\n\n更新内容:\n${pullResult.output}`)
        } else {
            return e.reply(`❌ 更新失败:\n${pullResult.output}`)
        }
    }

    async gitForceUpdate(e) {
        if (!await checkAccess(e)) return true

        await e.reply('⚠️ 正在强制更新（将丢弃本地修改）...')

        const resetResult = this._runGit('git reset --hard origin/master')
        if (!resetResult.success) {
            return e.reply(`❌ git reset 失败:\n${resetResult.output}`)
        }

        const pullResult = this._runGit('git pull origin master')
        if (pullResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'
            return e.reply(`✅ 强制更新成功！\n当前版本: ${hashStr}\n\n${pullResult.output}`)
        } else {
            return e.reply(`❌ 强制更新失败:\n${pullResult.output}`)
        }
    }
}
