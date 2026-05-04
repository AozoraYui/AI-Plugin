import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { sessionManager } from '../utils/session.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType } from '../utils/common.js'
import fs from 'node:fs'
import yaml from 'yaml'
import sharp from 'sharp'
import { PRESETS_FILE } from '../utils/config.js'

export class ImageHandler extends plugin {
    constructor() {
        super({
            name: 'AI作图',
            dsc: '使用AI生成图片',
            event: 'message',
            priority: 1142,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)bnn([\s\S]*)$/i, fnc: 'generateImage', key: 'bnnCommand' },
                { reg: /^#画图预设(列表|list)$/i, fnc: 'listPresets' },
                { reg: /^#画图预设列表(pro|Pro)$/i, fnc: 'listPresetsPro' },
                { reg: /^#画图预设重载$/i, fnc: 'reloadPresets', permission: 'master' },
                { reg: /^#画图预设添加\s*(\S+)\s+(.*)$/i, fnc: 'startAddPresetSession', permission: 'master' },
                { reg: /^#画图预设删除\s*(\S+)$/i, fnc: 'deletePreset', permission: 'master' },
                { reg: /^#添加预设别名\s*(\S+)$/i, fnc: 'startAddAliasSession', permission: 'master' },
                { reg: /^#删除预设别名\s*(\S+)$/i, fnc: 'startDeleteAliasSession', permission: 'master' },
                { reg: /.*/, fnc: 'sessionHandler', priority: 9200, log: false },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
        this.updateDynamicRule()
    }

    generateCommandRegex(presets) {
        const allCommands = presets.flatMap(p => [p.command, ...(p.aliases || [])]).filter(Boolean)
        return allCommands.length > 0 ? `^#([a-zA-Z0-9]*)(${allCommands.join('|')})(?:@(\\d+)|(\\d+))?$` : `^#无任何作图预设$`
    }

    updateDynamicRule() {
        try {
            const ruleToUpdate = this.rule.find(r => r.key === 'dynamicImageCommand')
            if (ruleToUpdate) {
                ruleToUpdate.reg = this.generateCommandRegex(Config.presets)
                logger.info('[AI-Plugin] 动态指令规则已成功更新。')
            } else {
                this.rule.push({
                    reg: this.generateCommandRegex(Config.presets),
                    fnc: 'generateImage',
                    key: 'dynamicImageCommand'
                })
            }
        } catch (error) {
            logger.error('[AI-Plugin] 更新动态指令规则时出错:', error)
        }
    }

    async generateImage(e) {
        if (!await checkAccess(e)) return true

        let modelGroupKey = 'default'
        let isCustomCommand = false
        let instruction = ''
        let command = ''
        let match

        const bnnMatch = e.msg.match(/^#([a-zA-Z0-9]*)bnn([\s\S]*)/i)
        if (bnnMatch) {
            match = bnnMatch
            isCustomCommand = true
            const prefix = match[1].toLowerCase()
            instruction = match[2].trim()
            if (prefix === 'pro') modelGroupKey = 'pro'
            else if (prefix === '3') modelGroupKey = 'gemini3'
        } else {
            const dynamicRule = this.rule.find(r => r.key === 'dynamicImageCommand')
            if (dynamicRule) {
                const regex = new RegExp(dynamicRule.reg)
                const presetMatch = regex.exec(e.msg)
                if (presetMatch) {
                    match = presetMatch
                    isCustomCommand = false
                    const prefix = match[1].toLowerCase()
                    command = match[2]
                    if (prefix === 'pro') modelGroupKey = 'pro'
                    else if (prefix === '3') modelGroupKey = 'gemini3'
                }
            }
        }

        if (!match) return

        const startTime = Date.now()

        let allImages = []
        const replyImages = await takeSourceMsg(e, { img: true })
        if (replyImages) allImages = allImages.concat(replyImages)
        const currentImages = e.message.filter(m => m.type === "image").map(m => m.url)
        if (currentImages.length > 0) allImages = allImages.concat(currentImages)

        await setMsgEmojiLike(e, 282)
        await e.reply(`🎨 正在生成 (使用 ${modelGroupKey} 模型组)，请稍候…`)

        let parts = []
        let presetName = '自定义'

        try {
            if (allImages.length === 0 && !isCustomCommand) {
                const atSeg = e.message.find(m => m.type === "at")
                if (atSeg?.qq) {
                    allImages.push(await getAvatarUrl(atSeg.qq))
                } else {
                    allImages.push(await getAvatarUrl(e.user_id))
                }
            }

            if (isCustomCommand) {
                const atSegments = e.message.filter(m => m.type === "at" && m.qq)
                for (const atSeg of atSegments) {
                    allImages.push(await getAvatarUrl(atSeg.qq))
                }
            }

            const imagesToProcess = allImages.slice(0, Config.MAX_IMAGES_PER_MESSAGE)

            if (imagesToProcess.length === 0 && !isCustomCommand) {
                await setMsgEmojiLike(e, 10)
                return e.reply("❌ 该功能需要附带图片才能使用哦！(可以回复图片或@某人)")
            }

            for (const imageUrl of imagesToProcess) {
                const imageBuffer = await urlToBuffer(imageUrl)
                let mimeType = getImageMimeType(imageBuffer)
                let finalBuffer = imageBuffer
                if (mimeType === 'image/gif') {
                    finalBuffer = await sharp(imageBuffer).toFormat('png').toBuffer()
                    mimeType = 'image/png'
                }
                parts.push({ "inline_data": { "mime_type": mimeType || 'image/png', "data": finalBuffer.toString('base64') } })
            }

            if (isCustomCommand) {
                if (!instruction && imagesToProcess.length === 0) {
                    await setMsgEmojiLike(e, 10)
                    return e.reply("请输入内容或发送图片呀！")
                }
                parts.push({ "text": instruction })
            } else {
                const preset = Config.presets.find(p => p.command.toLowerCase() === command.toLowerCase() || (p.aliases && p.aliases.map(a => a.toLowerCase()).includes(command.toLowerCase())))
                if (!preset) {
                    await setMsgEmojiLike(e, 10)
                    return e.reply(`❌ 未找到指令 #${command} 对应的预设。`)
                }
                parts.push({ "text": preset.prompt })
                presetName = preset.name
            }

            const payload = { "contents": [{ "parts": parts }] }
            const result = await this.client.makeRequest('image', payload, modelGroupKey)

            if (result.success && result.data) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

                let tokenInfo = ''
                if (result.usage) {
                    if (result.usage.prompt_tokens !== undefined && result.usage.completion_tokens !== undefined) {
                        tokenInfo = ` | 输入Tokens: ${result.usage.prompt_tokens} | 输出Tokens: ${result.usage.completion_tokens}`
                    } else if (result.usage.total_tokens) {
                        tokenInfo = ` | Token: ${result.usage.total_tokens}`
                    }
                }

                if (typeof result.data === 'string' && (result.data.startsWith('data:image/') || result.data.startsWith('http'))) {
                    await setMsgEmojiLike(e, 60)

                    const replyMsg = isCustomCommand
                        ? `✅ 创作完成 (${elapsed}s${tokenInfo}) @${result.platform}`
                        : `✅ 生成完成 (${elapsed}s${tokenInfo})｜预设：${presetName} @${result.platform}`

                    let imageToSend = result.data
                    if (result.data.startsWith('data:image/')) {
                        imageToSend = `base64://${result.data.split(',')[1]}`
                    } else if (result.data.startsWith('http')) {
                        try {
                            const imageBuffer = await urlToBuffer(result.data)
                            imageToSend = `base64://${imageBuffer.toString('base64')}`
                        } catch (downloadErr) { }
                    }
                    await e.reply([segment.image(imageToSend), replyMsg], true)
                    await setMsgEmojiLike(e, 144)

                } else {
                    const cleanResponseText = result.data.trim()
                    await e.reply(`${cleanResponseText}\n\n⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform}`, true)
                    await setMsgEmojiLike(e, 144)
                }
            } else {
                await setMsgEmojiLike(e, 10)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
                await e.reply(`❌ 请求失败 (${elapsed}s)\n错误: ${result.error || '未知错误'}`, true)
            }
        } catch (err) {
            await setMsgEmojiLike(e, 10)
            logger.error(`[AI-Plugin] 作图异常:`, err)
            await e.reply(`❌ 处理异常: ${err.message}`, true)
        }
    }

    async listPresets(e) {
        if (!Config.presets || Config.presets.length === 0) {
            return e.reply("目前没有配置任何作图预设。")
        }
        const batchSize = 15
        const totalPages = Math.ceil(Config.presets.length / batchSize)
        let allForwardMsgs = []

        for (let i = 0; i < Config.presets.length; i += batchSize) {
            const page = Math.floor(i / batchSize) + 1
            const batch = Config.presets.slice(i, i + batchSize)
            let msg = `🎨 AI 作图预设 (第${page}页/共${totalPages}页)\n- - - - - - - - - - - - - - - -\n`

            msg += batch.map((p, index) => {
                let entry = `${i + index + 1}. #${p.command}`
                if (p.aliases && p.aliases.length > 0) {
                    entry += ` (别名: ${p.aliases.join(', ')})`
                }
                entry += `\n   功能: ${p.name}`
                return entry
            }).join('\n\n')

            allForwardMsgs.push(msg)
        }

        const forwardMsg = await Bot.makeForwardMsg(allForwardMsgs.map(msg => ({
            user_id: Bot.uin,
            nickname: Config.AI_NAME,
            message: msg
        })))

        await e.reply(forwardMsg)
        return true
    }

    async listPresetsPro(e) {
        if (!Config.presets || Config.presets.length === 0) {
            return e.reply("目前没有配置任何作图预设。")
        }
        const batchSize = 10
        const totalPages = Math.ceil(Config.presets.length / batchSize)

        try {
            for (let i = 0; i < Config.presets.length; i += batchSize) {
                const page = Math.floor(i / batchSize) + 1
                const batch = Config.presets.slice(i, i + batchSize)

                const forwardMsgNodes = []

                forwardMsgNodes.push({
                    user_id: Bot.uin,
                    nickname: Config.AI_NAME,
                    message: `🎨 AI 作图预设 (Pro - 详细版)\n(第 ${page} 页 / 共 ${totalPages} 页)`
                })

                for (let j = 0; j < batch.length; j++) {
                    const p = batch[j]
                    const currentIndex = i + j

                    let msg = `${currentIndex + 1}. #${p.command}`
                    if (p.aliases && p.aliases.length > 0) {
                        msg += ` (别名: ${p.aliases.join(', ')})`
                    }
                    msg += `\n功能: ${p.name}\n- - - - - - - - - - - - - - -\nPrompt:\n${p.prompt}`

                    forwardMsgNodes.push({
                        user_id: Bot.uin,
                        nickname: Config.AI_NAME,
                        message: msg
                    })
                }

                const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                await e.reply(forwardMsg, false, { recallMsg: 90 })
            }
        } catch (error) {
            logger.error(`[AI-Plugin] 创建详细预设列表失败:`, error)
            await e.reply(`❌ 创建详细预设列表失败，可能是内容过长或账号受限。`)
        }

        return true
    }

    async reloadPresets(e) {
        try {
            Config.reloadPresets()
            this.client.reload()
            this.updateDynamicRule()
            await e.reply(`✅ 预设及模型配置文件已重载，当前共 ${Config.presets.length} 个预设与 ${this.client.modelsConfig.length} 个供应商，所有指令已即时生效。`)
        } catch (err) {
            await e.reply(`❌ 重载失败: ${err.message}`)
        }
        return true
    }

    async deletePreset(e) {
        const commandToDelete = e.msg.replace("#画图预设删除", "").trim()
        const initialLength = Config.presets.length
        const updatedPresets = Config.presets.filter(p => p.command !== commandToDelete)

        if (updatedPresets.length === initialLength) {
            return e.reply(`❌ 删除失败：未找到指令 #${commandToDelete}。`)
        }

        this._savePresets(updatedPresets)
        Config.presets = updatedPresets
        this.updateDynamicRule()
        await e.reply(`✅ 成功删除预设 #${commandToDelete}。\n变更已即时生效。`)
        return true
    }

    async startAddPresetSession(e) {
        const match = e.msg.match(/^#画图预设添加\s*(\S+)\s+(.*)$/)
        const newCommand = match[1]
        const newName = match[2].trim()
        if (!newName) {
            return e.reply("格式错误，请提供预设名称。\n示例：#画图预设添加 新风格 我的新风格")
        }
        if (Config.presets.some(p => p.command === newCommand)) {
            return e.reply(`❌ 添加失败：指令 #${newCommand} 已存在。`)
        }
        sessionManager.set(e.user_id, {
            type: 'addPreset', data: { command: newCommand, name: newName }
        }, () => e.reply("操作超时，已自动取消。"))
        await e.reply(`✅ 已准备添加 #${newCommand} - ${newName}。\n请在3分钟内发送此预设要使用的【提示词(Prompt)内容】，或发送 #取消 以中止。`)
        return true
    }

    async startAddAliasSession(e) {
        const match = e.msg.match(/^#添加预设别名\s*(\S+)$/)
        if (!match) return

        const targetCommand = match[1]
        const presetToModify = Config.presets.find(p => p.command === targetCommand)

        if (!presetToModify) {
            return e.reply(`❌ 未找到主指令为 #${targetCommand} 的预设。`)
        }

        sessionManager.set(e.user_id, {
            type: 'addAlias',
            data: { command: targetCommand }
        }, () => e.reply("操作超时，已自动取消。"))

        await e.reply(`好的，请发送您想为 #${targetCommand} 添加的新别名。\n可以一次发送多个，用空格或逗号隔开。\n发送 #取消 以中止。`)
        return true
    }

    async startDeleteAliasSession(e) {
        const match = e.msg.match(/^#删除预设别名\s*(\S+)$/)
        if (!match) return

        const targetCommand = match[1]
        const presetToModify = Config.presets.find(p => p.command === targetCommand)

        if (!presetToModify) {
            return e.reply(`❌ 未找到主指令为 #${targetCommand} 的预设。`)
        }

        if (!presetToModify.aliases || presetToModify.aliases.length === 0) {
            return e.reply(`- 指令 #${targetCommand} 当前没有任何可供删除的别名。`)
        }

        sessionManager.set(e.user_id, {
            type: 'deleteAlias',
            data: {
                command: targetCommand,
                availableAliases: presetToModify.aliases
            }
        }, () => e.reply("操作超时，已自动取消。"))

        const aliasList = presetToModify.aliases.map((alias, index) => `${index + 1}. ${alias}`).join('\n')
        await e.reply(`请选择要为 #${targetCommand} 删除的别名，输入【编号】或【别名本身】。\n可以一次删除多个，用空格或逗号隔开。\n\n${aliasList}\n\n发送 #取消 以中止。`)
        return true
    }

    async sessionHandler(e) {
        if (!sessionManager.has(e.user_id)) return false
        
        const session = sessionManager.get(e.user_id)
        if (e.msg.trim() === '#取消') {
            sessionManager.delete(e.user_id)
            await e.reply("操作已取消。")
            return true
        }

        try {
            if (session.type === 'addPreset') {
                const newPrompt = e.msg.trim()
                if (!newPrompt) throw new Error("提示词内容不能为空。")
                
                const newPreset = { ...session.data, prompt: newPrompt }
                Config.presets.push(newPreset)
                this._savePresets(Config.presets)
                Config.reloadPresets()
                this.updateDynamicRule()
                
                await e.reply(`✅ 预设 #${session.data.command} 添加成功！新指令已即时生效！`)
            
            } else if (session.type === 'addAlias') {
                const targetCommand = session.data.command
                const newAliases = e.msg.trim().split(/[\s,;，；]+/).filter(Boolean)

                if (newAliases.length === 0) throw new Error("别名内容不能为空。")

                const preset = Config.presets.find(p => p.command === targetCommand)
                if (!preset) throw new Error(`在处理时未找到指令 #${targetCommand}`)

                if (!preset.aliases) preset.aliases = []
                
                let addedCount = 0
                let skippedAliases = []
                const allExistingCommands = new Set(Config.presets.flatMap(p => [p.command, ...(p.aliases || [])]))

                for (const alias of newAliases) {
                    if (allExistingCommands.has(alias)) {
                        skippedAliases.push(alias)
                    } else {
                        preset.aliases.push(alias)
                        addedCount++
                    }
                }

                if (addedCount > 0) {
                    this._savePresets(Config.presets)
                    Config.reloadPresets()
                    this.updateDynamicRule()
                }

                let replyMsg = ''
                if (addedCount > 0) replyMsg += `✅ 成功为 #${targetCommand} 添加了 ${addedCount} 个新别名！新别名已即时生效！`
                if (skippedAliases.length > 0) replyMsg += `\n- 跳过了 ${skippedAliases.length} 个已存在或冲突的别名: ${skippedAliases.join(', ')}`
                
                await e.reply(replyMsg || '🤔 没有添加任何新的别名。')

            } else if (session.type === 'deleteAlias') {
                const { command: targetCommand, availableAliases } = session.data
                const inputs = e.msg.trim().split(/[\s,;，；]+/).filter(Boolean)

                if (inputs.length === 0) throw new Error("输入内容不能为空。")

                const preset = Config.presets.find(p => p.command === targetCommand)
                if (!preset || !preset.aliases) throw new Error(`在处理时未找到指令 #${targetCommand} 或其别名列表。`)

                let deletedAliases = new Set()
                
                for (const input of inputs) {
                    let aliasToDelete = null
                    const index = parseInt(input) - 1
                    if (!isNaN(index) && index >= 0 && index < availableAliases.length) {
                        aliasToDelete = availableAliases[index]
                    } else if (availableAliases.includes(input)) {
                        aliasToDelete = input
                    }

                    if (aliasToDelete) {
                        deletedAliases.add(aliasToDelete)
                    }
                }
                
                if (deletedAliases.size > 0) {
                    preset.aliases = preset.aliases.filter(alias => !deletedAliases.has(alias))
                    this._savePresets(Config.presets)
                    Config.reloadPresets()
                    this.updateDynamicRule()
                    await e.reply(`✅ 成功从 #${targetCommand} 中删除了 ${deletedAliases.size} 个别名: ${Array.from(deletedAliases).join(', ')}\n变更已即时生效。`)
                } else {
                    await e.reply("🤔 没有找到与你输入匹配的可删除别名。")
                }
            }

        } catch (error) {
            await e.reply(`❌ 操作失败：${error.message}`)
        } finally {
            sessionManager.delete(e.user_id)
        }
        return true
    }

    _savePresets(presets) {
        const tmpFile = PRESETS_FILE + '.tmp'
        fs.writeFileSync(tmpFile, yaml.stringify(presets), 'utf8')
        fs.renameSync(tmpFile, PRESETS_FILE)
    }
}
