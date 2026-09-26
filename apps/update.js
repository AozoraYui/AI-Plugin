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
                { reg: /^#ai插件更新$/i, fnc: 'gitPull' },
                { reg: /^#ai插件强制更新(?:\s+确认)?$/i, fnc: 'gitForceUpdate' },
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

    _isAncestor(ancestor, descendant) {
        const result = this._runGit(`git merge-base --is-ancestor ${ancestor} ${descendant}`)
        return result.success
    }

    _getWorkingTreeStatus() {
        const result = this._runGit('git status --porcelain --untracked-files=all')
        return result
    }

    _createDivergenceBackup() {
        const branchName = `ai-plugin-update-backup-${Date.now()}`
        const result = this._runGit(`git branch ${branchName} HEAD`)
        return result.success ? branchName : ''
    }

    _formatHashes(localHash, remoteHash) {
        return `本地: ${localHash.slice(0, 7)}\n远程: ${remoteHash.slice(0, 7)}`
    }

    async gitPull(e) {
        if (!await checkAccess(e)) return true

        await e.reply('正在检查更新...')

        const fetchResult = this._runGit('git fetch origin')
        if (!fetchResult.success) {
            return e.reply(`❌ git fetch 失败:\n${fetchResult.output}`)
        }

        const localHash = this._runGit('git rev-parse HEAD')
        const remoteHash = this._runGit('git rev-parse origin/main')

        if (localHash.success && remoteHash.success && localHash.output === remoteHash.output) {
            return e.reply(`✅ 已是最新版本\n本地: ${localHash.output.slice(0, 7)}\n远程: ${remoteHash.output.slice(0, 7)}`)
        }

        if (!localHash.success || !remoteHash.success) {
            return e.reply(`❌ 无法读取本地或远程版本信息。\n${localHash.output}\n${remoteHash.output}`)
        }

        // 获取更新日志
        const changelog = this._getChangelog()

        let updateResult
        let reconciliationNote = ''
        if (this._isAncestor(localHash.output, remoteHash.output)) {
            updateResult = this._runGit('git merge --ff-only origin/main')
        } else if (this._isAncestor(remoteHash.output, localHash.output)) {
            return e.reply(`本地版本领先于远程版本，普通更新不会覆盖本地提交。\n${this._formatHashes(localHash.output, remoteHash.output)}\n如需放弃本地提交并完全同步远程，请发送：\n#ai插件强制更新 确认`)
        } else {
            const workingTree = this._getWorkingTreeStatus()
            if (!workingTree.success) {
                return e.reply(`❌ 无法确认工作区状态，已停止更新以保护本地文件。\n${workingTree.output}`)
            }
            if (workingTree.output) {
                return e.reply(`检测到本地分支与远程分支已分叉，且工作区存在未提交改动，已停止更新以保护本地文件。\n${this._formatHashes(localHash.output, remoteHash.output)}\n请先手动处理本地改动，或确认丢弃本地改动后发送：\n#ai插件强制更新 确认`)
            }

            const backupBranch = this._createDivergenceBackup()
            if (!backupBranch) {
                return e.reply(`❌ 远程历史已改写，但无法创建本地备份分支，未执行覆盖。\n${this._formatHashes(localHash.output, remoteHash.output)}`)
            }
            updateResult = this._runGit('git reset --hard origin/main')
            reconciliationNote = `\n检测到远程历史被强制改写，已创建本地备份分支：${backupBranch}`
        }

        const pullResult = updateResult
        if (pullResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'

            let msg = ''
            if (changelog && changelog.length > 0) {
                msg += `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n`
                msg += changelog.join('\n')
                msg += `\n\n`
            }
            msg += `✅ 更新成功！${reconciliationNote}\n当前版本: ${hashStr}\n\n更新内容:\n${pullResult.output}`

            return e.reply(msg)
        } else {
            return e.reply(`❌ 更新失败:\n${pullResult.output}`)
        }
    }

    async gitForceUpdate(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#ai插件强制更新\s*(.*)/i)
        const confirmParam = match ? match[1].trim() : ''

        if (confirmParam !== '确认') {
            return e.reply('强制更新将丢弃所有本地修改！\n\n如需继续，请发送：\n#ai插件强制更新 确认')
        }

        await e.reply('正在强制更新（将丢弃本地修改）...')

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

        if (resetResult.success) {
            const newHash = this._runGit('git rev-parse HEAD')
            const hashStr = newHash.success ? newHash.output.slice(0, 7) : 'unknown'

            let msg = ''
            if (changelog && changelog.length > 0) {
                msg += `AI-Plugin 更新日志，共 ${changelog.length} 条\n\n`
                msg += changelog.join('\n')
                msg += `\n\n`
            }
            msg += `✅ 强制更新成功！\n当前版本: ${hashStr}\n\n${resetResult.output}`

            return e.reply(msg)
        } else {
            return e.reply(`❌ 强制更新失败:\n${resetResult.output}`)
        }
    }
}
