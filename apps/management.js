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
    constructor() {
        super({
            name: 'AI管理',
            dsc: 'AI插件管理功能',
            event: 'message',
            priority: 1140,
            rule: [
                { reg: /^#gemini模型列表$/i, fnc: 'listModels', permission: 'master' },
                { reg: /^#gemini模型测试$/i, fnc: 'testAllModels', permission: 'master' },
                { reg: /^#gemini模型全部启用$/i, fnc: 'enableAllModels', permission: 'master' },
                { reg: /^#gemini模型禁用(.*)$/i, fnc: 'disableModel', permission: 'master' },
                { reg: /^#gemini模型启用(.*)$/i, fnc: 'enableModel', permission: 'master' },
                { reg: /^#gemini禁用列表$/i, fnc: 'listDisabledModels', permission: 'master' },
                { reg: /^#gemini重载$/i, fnc: 'reloadPlugin', permission: 'master' },
                { reg: /^#gemini设置白名单$/i, fnc: 'setWhitelist', permission: 'master' },
                { reg: /^#gemini设置黑名单$/i, fnc: 'setBlacklist', permission: 'master' },
                { reg: /^#gemini添加白名单用户(.*)$/i, fnc: 'addWhitelistUser', permission: 'master' },
                { reg: /^#gemini删除白名单用户(.*)$/i, fnc: 'removeWhitelistUser', permission: 'master' },
                { reg: /^#gemini添加白名单群(.*)$/i, fnc: 'addWhitelistGroup', permission: 'master' },
                { reg: /^#gemini删除白名单群(.*)$/i, fnc: 'removeWhitelistGroup', permission: 'master' },
                { reg: /^#gemini添加黑名单用户(.*)$/i, fnc: 'addBlacklistUser', permission: 'master' },
                { reg: /^#gemini删除黑名单用户(.*)$/i, fnc: 'removeBlacklistUser', permission: 'master' },
                { reg: /^#gemini添加黑名单群(.*)$/i, fnc: 'addBlacklistGroup', permission: 'master' },
                { reg: /^#gemini删除黑名单群(.*)$/i, fnc: 'removeBlacklistGroup', permission: 'master' },
                { reg: /^#gemini查看权限配置$/i, fnc: 'viewAccessConfig', permission: 'master' },
                { reg: /^#gemini权限列表$/i, fnc: 'listAccessControl', permission: 'master' },
                { reg: /^#gemini状态$/i, fnc: 'showStatus', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
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

    async listAccessControl(e) {
        const config = getAccessConfig()
        let msg = `--- 诺亚权限配置 ---\n`
        msg += `当前模式: ${config.mode.toUpperCase()} (主人不受限)\n\n`

        msg += `✅ 白名单群聊 (${config.whitelist_groups.length}个):\n`
        msg += config.whitelist_groups.length > 0 ? config.whitelist_groups.join('\n') : '暂无'
        msg += `\n\n✅ 白名单用户 (${config.whitelist_users.length}个):\n`
        msg += config.whitelist_users.length > 0 ? config.whitelist_users.join('\n') : '暂无'
        
        msg += `\n\n- - - - - - - - - - - - -\n`

        msg += `\n🚫 黑名单群聊 (${config.blacklist_groups.length}个):\n`
        msg += config.blacklist_groups.length > 0 ? config.blacklist_groups.join('\n') : '暂无'
        msg += `\n\n🚫 黑名单用户 (${config.blacklist_users.length}个):\n`
        msg += config.blacklist_users.length > 0 ? config.blacklist_users.join('\n') : '暂无'

        await e.reply(msg)
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

    async listModels(e) {
        if (!this.client.modelsConfig || this.client.modelsConfig.length === 0) {
            return e.reply("尚未在 models_config.yaml 中配置任何模型。")
        }
        
        const forwardMsg = await this._buildModelListForwardMsg()
        await e.reply(forwardMsg)
        
        return true
    }

    async _buildModelListForwardMsg() {
        const config = getAccessConfig()
        const thinkingStatus = config.show_thinking ? "✅ 开启 (显示思考过程)" : "🚫 关闭 (自动过滤思考)"
        
        const forwardMsgNodes = [{ 
            user_id: Bot.uin, 
            nickname: "诺亚", 
            message: `🧠 思考过程显示: ${thinkingStatus}`
        }]
        
        const showProviderName = this.client.modelsConfig.length > 1

        const allGroups = new Set()
        this.client.modelsConfig.forEach(p => Object.keys(p.model_groups).forEach(g => allGroups.add(g)))

        for (const groupName of Array.from(allGroups).sort()) {
            let groupMsg = `\n--- 模型组: [${groupName}] ---\n`
            let chatMsg = `\n💬 对话模型 (按优先级)`
            let drawMsg = `\n🎨 绘图模型 (按优先级)`
            let chatCount = 0
            let drawCount = 0

            for (const provider of this.client.modelsConfig) {
                const group = provider.model_groups[groupName]
                if (!group) continue

                const prefix = showProviderName ? `[${provider.name}] ` : ''

                const buildStatusText = (status, statusKey) => {
                    if (this.client.disabledModels.has(statusKey)) {
                        return " (⚪️ 已禁用)"
                    }

                    if (!status) return " (未测试)"

                    const icon = status.status === 'ok' ? '✅' : '❌'
                    const time = status.responseTime ? `${status.responseTime}ms` : 'N/A'
                    
                    let tokenInfo = ''
                    if (status.status === 'ok' && status.usage) {
                        if (status.usage.prompt_tokens !== undefined && status.usage.completion_tokens !== undefined) {
                            tokenInfo = ` | In: ${status.usage.prompt_tokens} | Out: ${status.usage.completion_tokens}`
                        } else if (status.usage.total_tokens) {
                            tokenInfo = ` | Total: ${status.usage.total_tokens} Tokens`
                        }
                    }
                    return ` ${icon} ${time}${tokenInfo}`
                }

                if (group.chat_models) {
                    for (const modelId of group.chat_models) {
                        chatCount++
                        const statusKey = `${provider.id}-${modelId}`
                        const status = this.client.modelStatus[statusKey]
                        chatMsg += `\n${chatCount}. ${prefix}${modelId}${buildStatusText(status, statusKey)}`
                    }
                }
                if (group.draw_models) {
                    for (const modelId of group.draw_models) {
                        drawCount++
                        const statusKey = `${provider.id}-${modelId}`
                        const status = this.client.modelStatus[statusKey]
                        drawMsg += `\n${drawCount}. ${prefix}${modelId}${buildStatusText(status, statusKey)}`
                    }
                }
            }
            
            if (chatCount > 0) groupMsg += chatMsg
            if (drawCount > 0) groupMsg += drawMsg
            
            if (chatCount > 0 || drawCount > 0) {
                forwardMsgNodes.push({ user_id: Bot.uin, nickname: "诺亚", message: groupMsg })
            }
        }

        return await Bot.makeForwardMsg(forwardMsgNodes)
    }

    async listDisabledModels(e) {
        if (this.client.disabledModels.size === 0) {
            return e.reply("当前没有被禁用的模型。")
        }

        let msg = '--- ⚪️ 当前禁用的模型列表 ---\n'
        msg += Array.from(this.client.disabledModels).join('\n')
        await e.reply(msg)
    }

    async showStatus(e) {
        try {
            const providerCount = this.client.modelsConfig.length
            const presetCount = Config.presets.length

            let activeChatModels = 0
            let activeImageModels = 0
            for (const groupName in this.client.activeModelPools) {
                activeChatModels += this.client.activeModelPools[groupName].chat.length
                activeImageModels += this.client.activeModelPools[groupName].image.length
            }

            const accessConfig = getAccessConfig()
            const accessMode = accessConfig.mode === 'whitelist' ? '白名单模式' : '黑名单模式'
            const thinkingMode = accessConfig.show_thinking ? '✅ 开启 (Raw模式)' : '🚫 关闭 (自动清洗)'

            const statusPanel = [
                '====== 🐾 诺亚状态面板 🐾 ======',
                '🔧 核心配置',
                `  - API供应商: ${providerCount} 个`,
                `  - 作图预设: ${presetCount} 个`,
                '',
                '🔮 可用模型池',
                `  - 对话模型: ${activeChatModels} 个可用`,
                `  - 绘图模型: ${activeImageModels} 个可用`,
                '  (提示: 可用模型池基于上次 #gemini模型测试 结果)',
                '',
                '🔑 权限与模式',
                `  - 权限控制: ${accessMode}`,
                `  - AI思考过程: ${thinkingMode}`,
                '=============================='
            ].join('\n')

            await e.reply(statusPanel)

        } catch (err) {
            logger.error(`[AI-Plugin] 显示状态面板时出错:`, err)
            await e.reply(`❌ 获取状态失败: ${err.message}`)
        }
        return true
    }
}
