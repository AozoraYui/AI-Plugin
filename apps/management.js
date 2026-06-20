import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { getAccessConfig, saveAccessConfig } from '../utils/access.js'

export class ManagementHandler extends plugin {
    constructor() {
        super({
            name: 'AI管理',
            dsc: 'AI插件管理功能',
            event: 'message',
            priority: 1140,
            rule: [
                { reg: /^#ai模型列表$/i, fnc: 'listModels', permission: 'master' },
                { reg: /^#ai(禁用|启用)\s*(.+)$/i, fnc: 'toggleModelDisabledState', permission: 'master' },
                { reg: /^#ai权限模式\s*(whitelist|blacklist)$/i, fnc: 'switchAccessMode', permission: 'master' },
                { reg: /^#ai权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*(\d+)$/i, fnc: 'modifyAccess', permission: 'master' },
                { reg: /^#ai权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*$/i, fnc: 'modifyAccess', permission: 'master' },
                { reg: /^#ai权限列表$/i, fnc: 'listAccessControl', permission: 'master' },
                { reg: /^#ai信任群(添加|删除)\s*(\d+)$/i, fnc: 'modifyTrustedGroup', permission: 'master' },
                { reg: /^#ai信任群列表$/i, fnc: 'listTrustedGroups', permission: 'master' },
                { reg: /^#ai状态$/i, fnc: 'showStatus', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async toggleModelDisabledState(e) {
        const match = e.msg.match(/^#ai(禁用|启用)\s*(.+)$/i)
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
        const textMatch = e.msg.match(/^#ai权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*(\d+)$/i)
        let action, typeKeyword, id
        if (!textMatch) {
            const atMatch = e.msg.match(/^#ai权限(添加|删除)\s*(白名单群|黑名单群|白名单用户|黑名单用户)\s*$/i)
            if (!atMatch) return
            const atSeg = e.message?.find(m => m.type === 'at')
            if (!atSeg?.qq) return
            action = atMatch[1]
            typeKeyword = atMatch[2]
            id = String(atSeg.qq)
        } else {
            action = textMatch[1]
            typeKeyword = textMatch[2]
            id = textMatch[3]
        }

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
        const match = e.msg.match(/^#ai权限模式\s*(whitelist|blacklist)$/i)
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
        
        // 按优先级排序供应商
        const sortedProviders = [...this.client.modelsConfig].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))
        
        // 收集所有模型组
        const allGroups = new Set()
        sortedProviders.forEach(p => Object.keys(p.model_groups).forEach(g => allGroups.add(g)))
        const sortedGroups = Array.from(allGroups).sort()
        
        const buildStatusText = (status, statusKey) => {
            if (this.client.disabledModels.has(statusKey)) {
                return " (⚪️ 已禁用)"
            }

            if (!status) return " (🆕 未使用)"
            
            const total = (status.success_count || 0) + (status.fail_count || 0)
            if (total === 0) return " (🆕 未使用)"

            const rate = Math.round((status.success_count || 0) / total * 100)
            let extraInfo = `成功率${rate}%`
            if (status.avg_latency_ms) extraInfo += ` | 延迟${Math.round(status.avg_latency_ms / 1000)}s`
            const inCooldown = this.client._isInCooldown(status)
            if (inCooldown) extraInfo += ` | 🔥熔断`
            
            const icon = inCooldown ? '❌' : (rate >= 50 ? '✅' : '⚠️')
            return ` ${icon} ${extraInfo}`
        }

        const groupDisplay = (groupName) => {
            const key = String(groupName).toLowerCase()
            const map = {
                flash: '⚡ FLASH 快速组',
                pro: '🚀 PRO 专业组',
                ultra: '💎 ULTRA 旗舰组'
            }
            const title = map[key] || `🔧 ${String(groupName).toUpperCase()}`
            return `━━ ${title} ━━`
        }

        for (const provider of sortedProviders) {
            const groupsWithModels = []
            for (const groupName of sortedGroups) {
                const group = provider.model_groups[groupName]
                if (!group) continue
                
                const sections = []
                if (group.chat_models) {
                    const chatModels = group.chat_models.map(modelId => {
                        const statusKey = `${provider.id}-${modelId}`
                        return { modelId, status: this.client.modelStatus[statusKey], statusKey }
                    })
                    if (chatModels.length > 0) sections.push({ type: 'chat', label: '💬 chat', models: chatModels })
                }
                if (group.draw_models) {
                    const drawModels = group.draw_models.map(modelId => {
                        const statusKey = `${provider.id}-${modelId}`
                        return { modelId, status: this.client.modelStatus[statusKey], statusKey }
                    })
                    if (drawModels.length > 0) sections.push({ type: 'draw', label: '🎨 draw', models: drawModels })
                }
                if (sections.length > 0) {
                    groupsWithModels.push({ groupName, sections })
                }
            }
            
            if (groupsWithModels.length === 0) continue

            let providerMsg = `📦 [${provider.name}] ⭐ 优先级 ${provider.priority ?? 1}\n`
            
            for (let gi = 0; gi < groupsWithModels.length; gi++) {
                const { groupName, sections } = groupsWithModels[gi]
                
                if (gi > 0) providerMsg += `\n`
                providerMsg += `${groupDisplay(groupName)}\n`
                
                for (let si = 0; si < sections.length; si++) {
                    const { label, models } = sections[si]
                    
                    providerMsg += `  ${label}\n`
                    
                    for (let mi = 0; mi < models.length; mi++) {
                        const { modelId, status, statusKey } = models[mi]
                        providerMsg += `    • ${modelId}${buildStatusText(status, statusKey)}\n`
                    }
                }
            }
            
            forwardMsgNodes.push({ user_id: Bot.uin, nickname: Config.AI_NAME, message: providerMsg.trimEnd() })
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
                '  (模型配置后直接可用，异常模型由熔断机制自动处理)',
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
        const match = e.msg.match(/^#ai信任群(添加|删除)\s*(\d+)$/i)
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
