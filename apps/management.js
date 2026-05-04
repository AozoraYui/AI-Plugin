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
                { reg: /^#gemini启用全部模型$/i, fnc: 'enableAllModels', permission: 'master' },
                { reg: /^#gemini(禁用|启用)\s*(.+)$/i, fnc: 'toggleModelDisabledState', permission: 'master' },
                { reg: /^#gemini权限模式\s*(whitelist|blacklist)$/i, fnc: 'switchAccessMode', permission: 'master' },
                { reg: /^#gemini权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*(\d+)$/i, fnc: 'modifyAccess', permission: 'master' },
                { reg: /^#gemini权限列表$/i, fnc: 'listAccessControl', permission: 'master' },
                { reg: /^#gemini信任群(添加|删除)\s*(\d+)$/i, fnc: 'modifyTrustedGroup', permission: 'master' },
                { reg: /^#gemini信任群列表$/i, fnc: 'listTrustedGroups', permission: 'master' },
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

    async toggleModelDisabledState(e) {
        const match = e.msg.match(/^#gemini(禁用|启用)\s*(.+)$/i)
        if (!match) return
        const action = match[1]
        const modelId = match[2].trim()
        if (!modelId) return e.reply(`请提供要${action}的模型ID`)
        const result = this.client.toggleModelDisabled(action, modelId)
        await e.reply(result.message)
    }

    async listAccessControl(e) {
        const config = getAccessConfig()
        let msg = `--- ${Config.AI_NAME}权限配置 ---\n`
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

    async modifyAccess(e) {
        const match = e.msg.match(/^#gemini权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*(\d+)$/i)
        if (!match) return

        const action = match[1]
        const typeKeyword = match[2]
        const id = match[3]

        // 输入验证
        if (!/^\d{5,15}$/.test(id)) {
            const entityType = typeKeyword.includes('群') ? '群号' : '用户ID'
            return e.reply(`❌ ${entityType}格式不正确，请输入有效的${entityType}`)
        }

        let targetListKey
        let entityType

        switch (typeKeyword) {
            case '白名单群': targetListKey = 'whitelist_groups'; entityType = '群'; break
            case '黑名单群': targetListKey = 'blacklist_groups'; entityType = '群'; break
            case '白名单用户': targetListKey = 'whitelist_users'; entityType = '用户'; break
            case '黑名单用户': targetListKey = 'blacklist_users'; entityType = '用户'; break
        }

        const config = getAccessConfig()

        if (action === '添加') {
            if (!config[targetListKey].includes(id)) {
                config[targetListKey].push(id)
                saveAccessConfig(config)
                await e.reply(`✅ 已将${entityType} ${id} 添加到${typeKeyword}。`)
            } else {
                await e.reply(`⚠️ ${entityType} ${id} 已在${typeKeyword}中。`)
            }
        } else {
            const index = config[targetListKey].indexOf(id)
            if (index !== -1) {
                config[targetListKey].splice(index, 1)
                saveAccessConfig(config)
                await e.reply(`✅ 已将${entityType} ${id} 从${typeKeyword}中删除。`)
            } else {
                await e.reply(`⚠️ ${entityType} ${id} 不在${typeKeyword}中。`)
            }
        }
    }

    async switchAccessMode(e) {
        const match = e.msg.match(/^#gemini权限模式\s*(whitelist|blacklist)$/i)
        if (!match) return

        const newMode = match[1].toLowerCase()
        const config = getAccessConfig()
        config.mode = newMode
        saveAccessConfig(config)
        await e.reply(`✅ 权限模式已切换为: ${newMode === 'whitelist' ? '白名单模式' : '黑名单模式'}`)
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
            nickname: Config.AI_NAME, 
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
                forwardMsgNodes.push({ user_id: Bot.uin, nickname: Config.AI_NAME, message: groupMsg })
            }
        }

        return await Bot.makeForwardMsg(forwardMsgNodes)
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

            const trustedGroups = Config.trustedGroups
            const trustedGroupCount = trustedGroups.length

            const statusPanel = [
                `====== 🐾 ${Config.AI_NAME}状态面板 🐾 ======`,
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
                `  - 信任群聊: ${trustedGroupCount} 个`,
                '=============================='
            ].join('\n')

            await e.reply(statusPanel)

        } catch (err) {
            logger.error(`[AI-Plugin] 显示状态面板时出错:`, err)
            await e.reply(`❌ 获取状态失败: ${err.message}`)
        }
        return true
    }

    async modifyTrustedGroup(e) {
        const match = e.msg.match(/^#gemini信任群(添加|删除)\s*(\d+)$/i)
        if (!match) return

        const action = match[1]
        const groupId = match[2]

        // 输入验证
        if (!/^\d{5,15}$/.test(groupId)) {
            return e.reply(`❌ 群号格式不正确，请输入有效的群号`)
        }

        let trustedGroups = Config.trustedGroups

        if (action === '添加') {
            if (!trustedGroups.includes(groupId)) {
                trustedGroups.push(groupId)
                Config.trustedGroups = trustedGroups
                await e.reply(`✅ 已将群 ${groupId} 添加到信任群列表`)
            } else {
                await e.reply(`⚠️ 群 ${groupId} 已在信任群列表中`)
            }
        } else {
            const index = trustedGroups.indexOf(groupId)
            if (index !== -1) {
                trustedGroups.splice(index, 1)
                Config.trustedGroups = trustedGroups
                await e.reply(`✅ 已从信任群列表删除群 ${groupId}`)
            } else {
                await e.reply(`⚠️ 群 ${groupId} 不在信任群列表中`)
            }
        }
    }

    async listTrustedGroups(e) {
        const trustedGroups = Config.trustedGroups
        if (trustedGroups.length === 0) {
            await e.reply('当前没有信任的群聊')
        } else {
            let msg = `--- 信任群聊列表 (${trustedGroups.length}个) ---\n`
            msg += trustedGroups.join('\n')
            await e.reply(msg)
        }
    }
}
