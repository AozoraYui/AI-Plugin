import plugin from '../../../lib/plugins/plugin.js'
import { Config, MODELS_CONFIG_FILE, MODEL_STATUS_FILE, DISABLED_MODELS_FILE, PRESETS_FILE } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { sessionManager } from '../utils/session.js'
import { setMsgEmojiLike, getTodayDateStr } from '../utils/common.js'
import fs from 'node:fs'
import yaml from 'yaml'

export class ManagementHandler extends plugin {
    constructor(client, conversationManager) {
        super({
            name: 'AI管理',
            dsc: 'AI插件管理功能',
            event: 'message',
            priority: 1147,
            rule: [
                { reg: '^#gemini模型测试$', fnc: 'testAllModels', permission: 'master' },
                { reg: '^#gemini模型全部启用$', fnc: 'enableAllModels', permission: 'master' },
                { reg: '^#gemini模型禁用(.*)$', fnc: 'disableModel', permission: 'master' },
                { reg: '^#gemini模型启用(.*)$', fnc: 'enableModel', permission: 'master' },
                { reg: '^#gemini重载$', fnc: 'reloadPlugin', permission: 'master' },
                { reg: '^#gemini设置白名单$', fnc: 'setWhitelist', permission: 'master' },
                { reg: '^#gemini设置黑名单$', fnc: 'setBlacklist', permission: 'master' },
                { reg: '^#gemini添加白名单用户(.*)$', fnc: 'addWhitelistUser', permission: 'master' },
                { reg: '^#gemini删除白名单用户(.*)$', fnc: 'removeWhitelistUser', permission: 'master' },
                { reg: '^#gemini添加白名单群(.*)$', fnc: 'addWhitelistGroup', permission: 'master' },
                { reg: '^#gemini删除白名单群(.*)$', fnc: 'removeWhitelistGroup', permission: 'master' },
                { reg: '^#gemini添加黑名单用户(.*)$', fnc: 'addBlacklistUser', permission: 'master' },
                { reg: '^#gemini删除黑名单用户(.*)$', fnc: 'removeBlacklistUser', permission: 'master' },
                { reg: '^#gemini添加黑名单群(.*)$', fnc: 'addBlacklistGroup', permission: 'master' },
                { reg: '^#gemini删除黑名单群(.*)$', fnc: 'removeBlacklistGroup', permission: 'master' },
                { reg: '^#gemini查看权限配置$', fnc: 'viewAccessConfig', permission: 'master' },
            ]
        })
        this.client = client
        this.conversationManager = conversationManager
    }

    async testAllModels(e) {
        await e.reply("🧪 开始测试所有模型，这可能需要几分钟...")
        const result = await this.client.testAllModels()
        const message = `✅ 模型测试完成！\n总计: ${result.total} 个\n成功: ${result.success} 个\n失败: ${result.failed} 个\n跳过: ${result.skipped} 个`
        await e.reply(message)
    }

    async enableAllModels(e) {
        const result = this.client.enableAllModels()
        await e.reply(result.message)
    }

    async disableModel(e) {
        const modelId = e.msg.replace(/^#gemini模型禁用/, '').trim()
        if (!modelId) return e.reply("请提供要禁用的模型ID")
        const result = this.client.toggleModelDisabled('禁用', modelId)
        await e.reply(result.message)
    }

    async enableModel(e) {
        const modelId = e.msg.replace(/^#gemini模型启用/, '').trim()
        if (!modelId) return e.reply("请提供要启用的模型ID")
        const result = this.client.toggleModelDisabled('启用', modelId)
        await e.reply(result.message)
    }

    async reloadPlugin(e) {
        try {
            this.client.reload()
            Config.reloadPresets()
            await e.reply("✅ 插件已重载完成")
        } catch (err) {
            await e.reply(`❌ 重载失败: ${err.message}`)
        }
    }

    async setWhitelist(e) {
        const config = getAccessConfig()
        config.mode = 'whitelist'
        saveAccessConfig(config)
        await e.reply("✅ 已切换到白名单模式")
    }

    async setBlacklist(e) {
        const config = getAccessConfig()
        config.mode = 'blacklist'
        saveAccessConfig(config)
        await e.reply("✅ 已切换到黑名单模式")
    }

    async addWhitelistUser(e) {
        const userId = e.msg.replace(/^#gemini添加白名单用户/, '').trim()
        if (!userId) return e.reply("请提供用户ID")
        const config = getAccessConfig()
        if (!config.whitelist_users.includes(userId)) {
            config.whitelist_users.push(userId)
            saveAccessConfig(config)
            await e.reply(`✅ 已添加用户 ${userId} 到白名单`)
        } else {
            await e.reply(`用户 ${userId} 已在白名单中`)
        }
    }

    async removeWhitelistUser(e) {
        const userId = e.msg.replace(/^#gemini删除白名单用户/, '').trim()
        if (!userId) return e.reply("请提供用户ID")
        const config = getAccessConfig()
        const index = config.whitelist_users.indexOf(userId)
        if (index > -1) {
            config.whitelist_users.splice(index, 1)
            saveAccessConfig(config)
            await e.reply(`✅ 已从白名单删除用户 ${userId}`)
        } else {
            await e.reply(`用户 ${userId} 不在白名单中`)
        }
    }

    async addWhitelistGroup(e) {
        const groupId = e.msg.replace(/^#gemini添加白名单群/, '').trim()
        if (!groupId) return e.reply("请提供群号")
        const config = getAccessConfig()
        if (!config.whitelist_groups.includes(groupId)) {
            config.whitelist_groups.push(groupId)
            saveAccessConfig(config)
            await e.reply(`✅ 已添加群 ${groupId} 到白名单`)
        } else {
            await e.reply(`群 ${groupId} 已在白名单中`)
        }
    }

    async removeWhitelistGroup(e) {
        const groupId = e.msg.replace(/^#gemini删除白名单群/, '').trim()
        if (!groupId) return e.reply("请提供群号")
        const config = getAccessConfig()
        const index = config.whitelist_groups.indexOf(groupId)
        if (index > -1) {
            config.whitelist_groups.splice(index, 1)
            saveAccessConfig(config)
            await e.reply(`✅ 已从白名单删除群 ${groupId}`)
        } else {
            await e.reply(`群 ${groupId} 不在白名单中`)
        }
    }

    async addBlacklistUser(e) {
        const userId = e.msg.replace(/^#gemini添加黑名单用户/, '').trim()
        if (!userId) return e.reply("请提供用户ID")
        const config = getAccessConfig()
        if (!config.blacklist_users.includes(userId)) {
            config.blacklist_users.push(userId)
            saveAccessConfig(config)
            await e.reply(`✅ 已添加用户 ${userId} 到黑名单`)
        } else {
            await e.reply(`用户 ${userId} 已在黑名单中`)
        }
    }

    async removeBlacklistUser(e) {
        const userId = e.msg.replace(/^#gemini删除黑名单用户/, '').trim()
        if (!userId) return e.reply("请提供用户ID")
        const config = getAccessConfig()
        const index = config.blacklist_users.indexOf(userId)
        if (index > -1) {
            config.blacklist_users.splice(index, 1)
            saveAccessConfig(config)
            await e.reply(`✅ 已从黑名单删除用户 ${userId}`)
        } else {
            await e.reply(`用户 ${userId} 不在黑名单中`)
        }
    }

    async addBlacklistGroup(e) {
        const groupId = e.msg.replace(/^#gemini添加黑名单群/, '').trim()
        if (!groupId) return e.reply("请提供群号")
        const config = getAccessConfig()
        if (!config.blacklist_groups.includes(groupId)) {
            config.blacklist_groups.push(groupId)
            saveAccessConfig(config)
            await e.reply(`✅ 已添加群 ${groupId} 到黑名单`)
        } else {
            await e.reply(`群 ${groupId} 已在黑名单中`)
        }
    }

    async removeBlacklistGroup(e) {
        const groupId = e.msg.replace(/^#gemini删除黑名单群/, '').trim()
        if (!groupId) return e.reply("请提供群号")
        const config = getAccessConfig()
        const index = config.blacklist_groups.indexOf(groupId)
        if (index > -1) {
            config.blacklist_groups.splice(index, 1)
            saveAccessConfig(config)
            await e.reply(`✅ 已从黑名单删除群 ${groupId}`)
        } else {
            await e.reply(`群 ${groupId} 不在黑名单中`)
        }
    }

    async viewAccessConfig(e) {
        const config = getAccessConfig()
        let message = "📋 权限配置信息:\n"
        message += `模式: ${config.mode === 'whitelist' ? '白名单' : '黑名单'}\n`
        message += `白名单用户: ${config.whitelist_users.join(', ') || '无'}\n`
        message += `白名单群: ${config.whitelist_groups.join(', ') || '无'}\n`
        message += `黑名单用户: ${config.blacklist_users.join(', ') || '无'}\n`
        message += `黑名单群: ${config.blacklist_groups.join(', ') || '无'}\n`
        message += `显示思考: ${config.show_thinking ? '开启' : '关闭'}`
        await e.reply(message)
    }
}
