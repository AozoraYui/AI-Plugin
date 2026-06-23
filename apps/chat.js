import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config, expandPrompt } from '../utils/config.js'
import { AiClient } from '../client/AiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess, getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, getBeijingTimeStr, getTodayDateStr, resolveModelGroup, resolveModelDisplay, resolveProviderPriority } from '../utils/common.js'
import { processImagesInBatches } from '../utils/image.js'
import { toolRegistry } from '../tools/index.js'
import { relayImagesToVision } from '../tools/index.js'

function extractCardInfo(data) {
    const lines = []
    const meta = data.meta || data.detail || data.appmsg || data.app || {}
    const news = meta.news || meta.detail || meta.appmsg || meta.app || {}
    const title = news.title || news.desc || data.prompt || ''
    const desc = news.desc || news.brief || news.summary || ''
    const source = news.source || news.tag || news.appname || data.app || ''
    const url = news.jumpUrl || news.url || news.link || ''
    if (title) lines.push(`标题: ${title}`)
    if (desc) lines.push(`描述: ${desc}`)
    if (source) lines.push(`来源: ${source}`)
    if (url) lines.push(`链接: ${url}`)
    if (lines.length === 0) {
        const fallbackFields = ['prompt', 'title', 'desc', 'content', 'summary', 'text', 'brief', 'source']
        for (const field of fallbackFields) {
            if (data[field] && typeof data[field] === 'string' && data[field].trim()) {
                lines.push(data[field].trim())
            }
        }
    }
    return lines.length > 0 ? lines.join('\n') : ''
}

async function expandForwardMsg(bot, resid, depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '【嵌套层级过深，停止展开】', images: [] }
    }

    try {
        const res = await bot.sendApi('get_forward_msg', { message_id: resid })
        const details = res?.messages || res?.data?.messages || res

        if (!Array.isArray(details) || details.length === 0) {
            return { text: '', images: [] }
        }

        const layerTag = depth > 0 ? `第${depth}层` : ''
        textParts.push(`【合并转发消息${layerTag} 开始】`)

        for (const subMsg of details.slice(0, Config.FORWARD_MSG_MAX_COUNT)) {
            const sender = subMsg.nickname || subMsg.sender?.nickname || "未知用户"
            const msgArray = subMsg.content || subMsg.message

            if (Array.isArray(msgArray)) {
                const expanded = await expandInlineContent(bot, msgArray, sender, depth, maxDepth)
                textParts.push(expanded.text)
                images.push(...expanded.images)
            } else if (typeof msgArray === 'string') {
                if (msgArray.trim()) {
                    textParts.push(`[${sender}]: ${msgArray}`)
                }
            } else {
                logger.info(`[AI-Plugin] msgArray 类型异常: ${typeof msgArray}, 内容: ${JSON.stringify(msgArray).slice(0, 300)}`)
            }
        }

        textParts.push(`【合并转发消息${layerTag} 结束】`)
    } catch (err) {
        logger.warn(`[AI-Plugin] 展开合并转发失败 (深度${depth}):`, err)
        return { text: `【展开失败: ${err.message}】`, images: [] }
    }

    return { text: textParts.join('\n'), images }
}

async function expandInlineContent(bot, msgArray, sender = "发送者", depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '【嵌套层级过深，停止展开】', images: [] }
    }

    let subText = ""
    for (const seg of msgArray) {
        if (seg.type === 'text') {
            subText += seg.data?.text || seg.text || ''
        } else if (seg.type === 'image') {
            const imgUrl = seg.data?.url || seg.url
            if (imgUrl) {
                images.push(imgUrl)
                subText += " [图片] "
            }
        } else if (seg.type === 'forward') {
            const nestedId = seg.id || seg.data?.id
            const nestedContent = seg.data?.content || seg.content
            if (Array.isArray(nestedContent)) {
                logger.info(`[AI-Plugin] 发现内联合并消息 (type=forward, 内联content)，开始递归展开 (深度${depth + 1})`)
                const layerTag = `第${depth + 1}层`
                textParts.push(`【${layerTag}嵌套消息 开始】`)
                for (const nestedMsg of nestedContent) {
                    const nestedSender = nestedMsg.nickname || nestedMsg.sender?.nickname || "未知用户"
                    const nestedMsgArray = nestedMsg.content || nestedMsg.message
                    if (Array.isArray(nestedMsgArray)) {
                        const nested = await expandInlineContent(bot, nestedMsgArray, nestedSender, depth + 1, maxDepth)
                        textParts.push(nested.text)
                        images.push(...nested.images)
                    }
                }
                textParts.push(`【${layerTag}嵌套消息 结束】`)
                if (subText.trim()) {
                    textParts.push(`[${sender}]: ${subText}`)
                    subText = ""
                }
            } else if (nestedId) {
                logger.info(`[AI-Plugin] 发现嵌套合并消息 (type=forward, id=${nestedId})，开始递归展开 (深度${depth + 1})`)
                const nested = await expandForwardMsg(bot, nestedId, depth + 1, maxDepth)
                if (subText.trim()) {
                    textParts.push(`[${sender}]: ${subText}`)
                    subText = ""
                }
                textParts.push(nested.text)
                images.push(...nested.images)
            }
        } else if ((seg.type === 'json' || seg.type === 'xml') && seg.data) {
            let cardData = seg.data
            if (typeof cardData === 'object' && typeof cardData.data === 'string') {
                try {
                    cardData = JSON.parse(cardData.data)
                } catch (err) {
                    logger.warn(`[AI-Plugin] expandInlineContent JSON data 解析失败:`, err)
                }
            }
            if (typeof cardData === 'string') {
                const residMatch = cardData.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                if (residMatch) {
                    const nestedResid = residMatch[1]
                    logger.info(`[AI-Plugin] 从 JSON/XML 中发现嵌套 resid: ${nestedResid}，开始递归展开 (深度${depth + 1})`)
                    const nested = await expandForwardMsg(bot, nestedResid, depth + 1, maxDepth)
                    if (subText.trim()) {
                        textParts.push(`[${sender}]: ${subText}`)
                        subText = ""
                    }
                    textParts.push(nested.text)
                    images.push(...nested.images)
                }
            } else if (typeof cardData === 'object') {
                const cardInfo = extractCardInfo(cardData)
                if (cardInfo) {
                    subText += `\n[卡片消息]\n${cardInfo}\n`
                }
            }
        } else {
            logger.info(`[AI-Plugin] 消息段类型: ${seg.type}, 内容预览: ${JSON.stringify(seg).slice(0, 300)}`)
        }
    }

    if (subText.trim()) {
        textParts.push(`[${sender}]: ${subText}`)
    }

    return { text: textParts.join('\n'), images }
}

const CHAT_PREFIX_PATTERN = '((?:[1-9])?(?:pro|p|ultra|u)?[vnwf]*)'
const DRAW_COMMAND_PREFIX_PATTERN = '(?:[1-9])?(?:pro|p|ultra|u)?'

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getImagePresetCommandExclusion() {
    const commands = (Config.presets || [])
        .flatMap(p => [p.command, ...(p.aliases || [])])
        .filter(Boolean)
        .map(escapeRegex)

    if (commands.length === 0) return ''
    return `(?!${DRAW_COMMAND_PREFIX_PATTERN}(?:${commands.join('|')})(?:\\s|$))`
}

function buildChatRegex(chatCmd) {
    return new RegExp(`^#${getImagePresetCommandExclusion()}${CHAT_PREFIX_PATTERN}${escapeRegex(chatCmd)}([vnwf]*)([\\s\\S]*)$`, 'i')
}

function buildSingleChatRegex(chatCmd) {
    return new RegExp(`^#${getImagePresetCommandExclusion()}${CHAT_PREFIX_PATTERN}s${CHAT_PREFIX_PATTERN}${escapeRegex(chatCmd)}([vnwf]*)([\\s\\S]*)$`, 'i')
}

function detectMasterOnlyToolRequest(message, flags = {}) {
    const text = String(message || '').trim()
    if (!text) return null

    if (flags.fileReadFlag) return '本地文件读取'
    if (flags.webFetchFlag) return '网页抓取'

    if (/(服务器|系统|主机|机器).{0,12}(状态|信息|资源|负载|CPU|内存|磁盘|温度|运行情况)|状态.{0,8}(服务器|系统|主机)|fastfetch|neofetch|uname\b|df\s+-h|free\s+-h|\btop\b|\bhtop\b/i.test(text)) {
        return '服务器状态查询'
    }

    if (/\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)\b/.test(text) && /(看|查看|读取|打开|列出|浏览|检查|找|搜索|配置|日志|文件|目录)/.test(text)) {
        return '本地文件读取'
    }

    if (/(执行|运行|调用).{0,12}(shell|命令|终端|命令行|脚本)|\b(?:cat|tail|head|ls|find|grep|rg|bash|sh|zsh|systemctl|docker|pm2|git)\b/i.test(text)) {
        return 'Shell执行'
    }

    return null
}

function extractUrlsFromText(text, limit = 10) {
    if (!text || typeof text !== 'string') return []

    const urls = []
    const seen = new Set()
    const urlRegex = /https?:\/\/[^\s<>'"，。！？、]+/gi
    let match
    while ((match = urlRegex.exec(text)) !== null && urls.length < limit) {
        const url = match[0].replace(/[)\]}.,，。!?！？;；:：]+$/g, '')
        if (!seen.has(url)) {
            seen.add(url)
            urls.push(url)
        }
    }
    return urls
}

function truncateForPrompt(text, maxChars) {
    const value = String(text || '')
    if (value.length <= maxChars) return value
    const head = Math.floor(maxChars * 0.65)
    const tail = maxChars - head
    return `${value.slice(0, head)}\n\n...【上下文过长，已截断 ${value.length - maxChars} 字符】...\n\n${value.slice(-tail)}`
}

function parseJsonObject(text) {
    const value = String(text || '').trim()
    const match = value.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
        return JSON.parse(match[0])
    } catch {
        return null
    }
}

function normalizeShellCommand(command) {
    return String(command || '').replace(/\s+/g, ' ').trim()
}

async function askMainModelForNextShellCommand(client, modelGroupKey, providerFilter, userMessage, executedCommands, round) {
    const prompt = `你是服务器 Shell 补查决策器。请根据用户原始需求和已经执行过的工具结果，判断是否还需要再执行一条 Shell 命令来补充信息。

规则：
- 只有在现有结果不足以回答用户问题时，才返回 need_shell=true。
- 每轮最多返回一条命令。
- 禁止交互式、长期运行、无限输出命令。
- 优先使用只读/查询命令，例如 pwd、ls、find、rg、grep、cat、tail、git status、git diff、df、free、ps。
- 【精确取数】数据量大时，优先用 jq/grep/awk/sed 只提取需要的字段或行，不要直接 cat 整个大文件，以减少数据量、避免浪费。
- 【翻页续读】如果上一条命令的结果提示"输出未读完"并给出了 offset_chars，且你确实需要后续完整内容，可返回相同的 command 并带上提示的 offset_chars 继续读取下一页（这种翻页不算重复命令）。
- 除翻页外，不要重复已执行的相同命令。
- 只有用户明确要求修改、删除、安装、重启等操作时，才允许返回有副作用命令。
- cwd 可省略；如果知道合适工作目录再填写。
- max_output_chars 不要超过 ${Config.SHELL_EXEC_MAX_OUTPUT_CHARS}。

已执行命令：
${executedCommands.length > 0 ? executedCommands.map((cmd, i) => `${i + 1}. ${cmd}`).join('\n') : '无'}

请严格输出 JSON，不要输出其他内容：
{"need_shell": false, "reason": "信息已经足够"}
或
{"need_shell": true, "reason": "还需要查看xxx", "command": "要执行的命令", "cwd": "可选工作目录", "timeout_ms": ${Config.SHELL_EXEC_TIMEOUT_MS}, "max_output_chars": ${Config.SHELL_EXEC_MAX_OUTPUT_CHARS}, "offset_chars": 0}

当前轮次：${round}

用户请求和已有工具结果：
${truncateForPrompt(userMessage, Config.SHELL_EXEC_FOLLOWUP_CONTEXT_CHARS)}`

    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
    const result = await client.makeRequest('chat', payload, modelGroupKey, 1024, providerFilter)
    if (!result.success || !result.data) {
        logger.warn(`[AI-Plugin] Shell 补查决策失败: ${result.error || '无返回'}`)
        return null
    }

    const parsed = parseJsonObject(result.data)
    if (!parsed) {
        logger.warn(`[AI-Plugin] Shell 补查决策 JSON 解析失败: ${String(result.data).slice(0, 200)}`)
        return null
    }
    return parsed
}

export class ChatHandler extends plugin {
    constructor() {
        const chatCmd = Config.CHAT_COMMAND
        super({
            name: 'AI对话',
            dsc: '与AI进行智能对话',
            event: 'message',
            priority: -9101,
            rule: [
                { reg: buildSingleChatRegex(chatCmd), fnc: 'handleSingleChat' },
                { reg: buildChatRegex(chatCmd), fnc: 'handleChat' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}记忆$`, 'i'), fnc: 'exportMyMemory' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'), fnc: 'exportMemoryByDate' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}全部记忆$`, 'i'), fnc: 'exportAllMemory', permission: 'master' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}全部记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'), fnc: 'exportAllMemoryByDate', permission: 'master' },
                { reg: /^#ai思考(开启|关闭)$/i, fnc: 'switchThinkingMode', permission: 'master' },
                { reg: /^#?ai(开启|关闭)思考提示$/i, fnc: 'switchThinkingNotice', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async handleSingleChat(e) {
        if (!await checkAccess(e)) return true

        const chatCmd = Config.CHAT_COMMAND
        const match = e.msg.match(buildSingleChatRegex(chatCmd))
        if (!match) return

        e._singleMode = true

        const prefix1 = match[1].toLowerCase()
        const prefix2 = match[2].toLowerCase()
        const flags = match[3].toLowerCase()
        let content = match[4]

        // 从所有位置提取 v/n/w flag（可能在 prefix1, prefix2, 或 flags group 中）
        const allFlags = prefix1 + prefix2 + flags
        e._visionFlag = allFlags.includes('v')
        e._netFlag = allFlags.includes('n')
        e._webFetchFlag = allFlags.includes('w')
        e._fileReadFlag = allFlags.includes('f')

        // 剥离 v/n/w/f 后再解析模型组
        const clean1 = prefix1.replace(/[vnwf]/gi, '')
        const clean2 = prefix2.replace(/[vnwf]/gi, '')

        // 从 prefix1 和 prefix2 解析数字优先匹配（临时指定供应商）
        const numericPriority = resolveProviderPriority(clean1) || resolveProviderPriority(clean2)
        if (numericPriority) {
            e._providerPriority = numericPriority
        }

        let modelPrefix = ''
        if (resolveModelGroup(clean1) !== 'flash') modelPrefix = clean1
        if (resolveModelGroup(clean2) !== 'flash') modelPrefix = clean2

        e.msg = `#${modelPrefix}${chatCmd}${content}`
        return this.handleChat(e)
    }

    async handleChat(e) {
        if (!await checkAccess(e)) return true

        const chatCmd = Config.CHAT_COMMAND
        const match = e.msg.match(buildChatRegex(chatCmd))
        if (!match) return

        const prefix = match[1].toLowerCase()
        const flags = match[2].toLowerCase()
        let userMessage = match[3].trim()

        // 从 prefix 和 flags 中提取 v/n/w/f flag（handleSingleChat 可能已设置）
        const allFlags = prefix + flags
        if (e._visionFlag === undefined) e._visionFlag = /v/i.test(allFlags)
        if (e._netFlag === undefined) e._netFlag = /n/i.test(allFlags)
        if (e._webFetchFlag === undefined) e._webFetchFlag = /w/i.test(allFlags)
        if (e._fileReadFlag === undefined) e._fileReadFlag = /f/i.test(allFlags)

        // 剥离 v/n/w/f 后再解析模型组
        const cleanPrefix = prefix.replace(/[vnwf]/gi, '')
        const modelGroupKey = resolveModelGroup(cleanPrefix)
        const modelDisplay = resolveModelDisplay(modelGroupKey)

        // 数字优先匹配：临时指定供应商（优先级高于 handleSingleChat 传递的）
        const providerFilter = resolveProviderPriority(cleanPrefix) || e._providerPriority || null

        const startTime = Date.now()
        let allImages = []

        try {
            const sourceMsg = await takeSourceMsg(e)

            if (sourceMsg) {
                if (sourceMsg.message) {
                    let replyText = ""
                    let forwardContent = ""
                    let forwardImages = []

                    for (const m of sourceMsg.message) {
                        let resid = null
                        if (m.type === 'forward' && m.id) {
                            const forwardContentArr = m.content || m.data?.content
                            if (Array.isArray(forwardContentArr)) {
                                logger.info(`[AI-Plugin] sourceMsg 中发现内联合并消息 (type=forward, 内联content)，开始递归展开`)
                                for (const nestedMsg of forwardContentArr) {
                                    const nestedSender = nestedMsg.nickname || nestedMsg.sender?.nickname || "未知用户"
                                    const nestedMsgArray = nestedMsg.content || nestedMsg.message
                                    if (Array.isArray(nestedMsgArray)) {
                                        const nested = await expandInlineContent(e.bot, nestedMsgArray, nestedSender)
                                        if (nested.text) {
                                            replyText += "\n" + nested.text + "\n"
                                        }
                                        forwardImages.push(...nested.images)
                                    }
                                }
                            } else {
                                resid = m.id
                            }
                        } else if ((m.type === 'json' || m.type === 'xml') && m.data) {
                            let cardData = m.data
                            if (typeof cardData === 'string') {
                                try {
                                    cardData = JSON.parse(cardData)
                                } catch (err) {
                                    logger.warn(`[AI-Plugin] JSON/XML data 解析失败:`, err)
                                }
                            }
                            if (typeof cardData === 'object') {
                                const residMatch = cardData.resid || (typeof m.data === 'string' && m.data.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)?.[1])
                                if (residMatch) {
                                    resid = typeof residMatch === 'string' ? residMatch : residMatch[1]
                                }
                                if (!resid) {
                                    const cardInfo = extractCardInfo(cardData)
                                    if (cardInfo) {
                                        replyText += `\n[卡片消息]\n${cardInfo}\n`
                                    }
                                }
                            }
                        }

                        if (resid) {
                            const expanded = await expandForwardMsg(e.bot, resid)
                            if (expanded.text) {
                                forwardContent += "\n" + expanded.text + "\n"
                            }
                            if (expanded.images.length > 0) {
                                forwardImages.push(...expanded.images)
                            }
                        }

                        if (m.type === 'text') {
                            replyText += m.text || ''
                        } else if (m.type === 'image') {
                            const imgUrl = m.data?.url || m.url
                            if (imgUrl) {
                                allImages.push(imgUrl)
                            }
                        } else if (m.type === 'file') {
                            // 引用的是群文件：把文件名写入上下文，并缓存到 redis，供后续"刚才那个文件/这个文件"下载
                            const fileName = m.name || m.file_name || m.fileName || m.data?.name || m.data?.file_name || m.file || m.data?.file || ''
                            if (fileName) {
                                replyText += `\n[群文件：${fileName}]\n`
                                if (e.group_id) {
                                    try {
                                        await redis.set(
                                            `AI-Plugin:lastQuotedFile:${e.group_id}:${e.user_id}`,
                                            String(fileName).trim(),
                                            { EX: 3600 }
                                        )
                                        logger.info(`[AI-Plugin] 已缓存引用群文件名「${fileName}」到上下文`)
                                    } catch (err) {
                                        logger.warn(`[AI-Plugin] 缓存引用群文件名失败: ${err.message}`)
                                    }
                                }
                            }
                        }
                    }

                    if (forwardContent) {
                        replyText += forwardContent
                    }

                    if (forwardImages.length > 0) {
                        allImages = allImages.concat(forwardImages)
                    }

                    if (replyText.trim()) {
                        const sourceSender = sourceMsg.nickname || sourceMsg.sender?.nickname || "未知用户"
                        const separator = `\n=== 引用${sourceSender}的消息 ===\n`
                        if (!userMessage) {
                            userMessage = replyText.trim()
                        } else {
                            userMessage = `${userMessage}\n${separator}${replyText.trim()}\n=======================\n`
                        }
                    }
                }
            }

            const currentImages = e.message.filter(m => m.type === "image").map(m => m.data?.url || m.url).filter(url => url)
            if (currentImages.length > 0) allImages = allImages.concat(currentImages)

            if (!userMessage && allImages.length === 0) return e.reply('请输入内容或发送图片呀', true)

            if (!e.isMaster) {
                const deniedTool = detectMasterOnlyToolRequest(userMessage, {
                    fileReadFlag: e._fileReadFlag,
                    webFetchFlag: e._webFetchFlag
                })
                if (deniedTool) {
                    logger.warn(`[AI-Plugin] 非主人尝试请求主人专用能力: ${deniedTool}`)
                    await setMsgEmojiLike(e, 10)
                    return e.reply(`权限不足：${deniedTool} 仅限机器人主人使用。`, true)
                }
            }

            // 工具调用：LLM 统一路由（deepseek-v4-flash 分析意图，决定调用哪些工具）
            const enabledTools = []
            // drawImageAttempted：本轮是否调用过画图工具（无论成败，工具内已发过"🎨正在生成"进度提示），
            // 用于跳过后续"思考中"占位，避免重复刷屏。
            let drawImageAttempted = false
            if (e._netFlag || this.client.enableWebSearch) {
                enabledTools.push('web_search')
                if (e.isMaster) enabledTools.push('web_fetch') // 搜索时主人允许抓取
            }
            if (e.isMaster && (e._webFetchFlag || this.client.enableWebFetch)) {
                if (!enabledTools.includes('web_fetch')) enabledTools.push('web_fetch')
            }
            if (e.isMaster) {
                enabledTools.push('system_info')
            }
            enabledTools.push('weather') // 天气查询，所有用户可用
            // 文件读取：主人开启 enable_file_read 或带 f flag
            const fileReadEnabled = e.isMaster && (e._fileReadFlag || this.client.enableFileRead)
            // Shell 执行：主人开启 enable_shell_exec（独立于 file_read），开启即默认具备文件读取能力
            const shellEnabled = e.isMaster && this.client.enableShellExec
            if (fileReadEnabled || shellEnabled) {
                enabledTools.push('file_read')
                enabledTools.push('dir_read')
            }
            if (shellEnabled) {
                enabledTools.push('shell_exec')
            }
            // 文件收发：主人开启 enable_file_transfer 后可上传白名单文件到会话 / 下载会话媒体到白名单目录
            if (e.isMaster && this.client.enableFileTransfer) {
                enabledTools.push('file_send')
                enabledTools.push('file_download')
                // 群文件浏览/下载（仅群聊有意义，但工具内部已做群聊校验）
                if (e.group_id) {
                    enabledTools.push('group_file_list')
                    enabledTools.push('group_file_download')
                }
            }
            // AI 对话画图：开启 enable_ai_draw 后，所有人可在对话中按意图触发画图
            if (this.client.enableAiDraw) {
                enabledTools.push('draw_image')
            }
            // 群管理：开启 enable_group_admin 后，群聊中由「主人」或「当前群管理员/群主」触发
            if (e.group_id && this.client.enableGroupAdmin) {
                const senderRole = e.sender?.role || e.member?.role
                const isGroupAdmin = senderRole === 'owner' || senderRole === 'admin' || e.member?.is_admin || e.member?.is_owner
                if (e.isMaster || isGroupAdmin) {
                    enabledTools.push('group_mute')
                    enabledTools.push('group_whole_mute')
                    enabledTools.push('group_kick')
                    enabledTools.push('group_set_card')
                    enabledTools.push('group_set_title')
                    enabledTools.push('group_essence')
                    enabledTools.push('group_request_list')
                    enabledTools.push('group_request_handle')
                }
            }

            if (enabledTools.length > 0) {
                // 为意图分析提供最近对话上下文（最多8轮 + 增量总结，仅非单次模式）
                let recentHistory = []
                let memorySummary = ''
                if (!e._singleMode) {
                    try {
                        const memData = await this.conversationManager.getUserHistoryWithCheckpoint(e.user_id)
                        recentHistory = (memData.history || []).slice(-8)
                        memorySummary = memData.incrementalCheckpoint || ''
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 加载意图分析上下文失败: ${err.message}`)
                    }
                }
                const candidateUrls = extractUrlsFromText(userMessage, 10)
                const toolAnalysis = await toolRegistry.analyzeToolIntent(userMessage, this.client, enabledTools, recentHistory, memorySummary, candidateUrls, {
                    hasImages: allImages.length > 0
                })
                const intent = toolAnalysis?.intent || ''
                const toolCalls = Array.isArray(toolAnalysis?.tools) ? toolAnalysis.tools : []
                const executedShellCommands = []
                // 意图分析注入
                if (intent) {
                    userMessage = userMessage + `\n\n【意图分析】${intent}`
                    logger.info(`[AI-Plugin] 意图分析: ${intent}`)
                }
                for (const call of toolCalls) {
                    const toolContext = { userId: e.user_id, groupId: e.group_id, event: e }
                    const result = await toolRegistry.execute(call.name, call.args, e.isMaster, toolContext)
                    if (result.success) {
                        if (call.name === 'draw_image') {
                            // 无论成败，画图工具内部都已发过"🎨正在生成"进度提示，
                            // 故标记 attempted 以跳过后续"思考中"占位，避免重复刷屏。
                            drawImageAttempted = true
                            // 画图工具成功时返回对象 {ok:true,...}；失败/模型返回文本时返回字符串。
                            // 只有真正成功（已发出图片）才让主模型说"画好啦"，
                            // 否则如实告知失败，避免明明没画出来却谎称已发送。
                            const drawSucceeded = result.data && typeof result.data === 'object' && result.data.ok === true
                            if (drawSucceeded) {
                                // 画图工具已把图片直接发到会话并显示了"🎨正在生成"进度，无需再发"思考中"占位；
                                // 但仍让主模型用人设口吻收尾回复（如"画好啦~"）
                                const formattedResult = toolRegistry.formatToolResult('draw_image', result.data)
                                userMessage = userMessage + '\n\n【重要指令】画图工具已执行并把图片直接发送到会话。' + formattedResult + '请用一句简短自然的话回应用户（如"画好啦~"），不要重复描述图片细节，也不要声称自己不能画图。'
                                logger.info('[AI-Plugin] draw_image 完成，图片已直接发送，结果已注入')
                            } else {
                                // 画图失败（如上游超时/返回文本）：如实把失败信息交给主模型，不要谎称已发送
                                const failText = toolRegistry.formatToolResult('draw_image', result.data)
                                userMessage = userMessage + '\n\n【重要指令】画图工具本次执行未成功，没有生成图片：' + failText + '请用人设口吻如实、简短地告诉用户这次没画成（可能是超时或服务繁忙），建议稍后再试，不要声称图片已经画好或已经发送。'
                                logger.warn(`[AI-Plugin] draw_image 未成功，已如实注入失败信息`)
                            }
                        } else if (call.name === 'web_search') {
                            // 搜索：将结果注入提示词
                            const results = result.data || []
                            if (results.length > 0) {
                                const seenUrls = new Set()
                                const uniqueResults = results.filter(item => {
                                    if (seenUrls.has(item.url)) return false
                                    seenUrls.add(item.url)
                                    return true
                                }).slice(0, 10)
                                const formattedResult = toolRegistry.formatToolResult('web_search', uniqueResults)
                                userMessage = userMessage + formattedResult
                                logger.info(`[AI-Plugin] 搜索完成，${uniqueResults.length} 条结果已注入`)

                                // 主人自动抓取搜索结果中第一名网页
                                if (e.isMaster) {
                                    try {
                                        const topUrl = uniqueResults[0].url
                                        logger.info(`[AI-Plugin] 自动抓取搜索结果首条: ${topUrl}`)
                                        const fetchResult = await toolRegistry.execute('web_fetch', { url: topUrl, max_chars: 12000 }, e.isMaster)
                                        if (fetchResult.success) {
                                            userMessage = userMessage + fetchResult.data
                                        }
                                    } catch (err) {
                                        logger.warn(`[AI-Plugin] 自动抓取失败: ${err.message}`)
                                    }
                                }
                            }
                        } else if (call.name === 'file_read' || call.name === 'dir_read') {
                            userMessage = userMessage + '\n\n【重要指令】以上为服务器实际文件内容。请严格按照实际内容回答，不要总结、不要遗漏、不要编造。列出所有文件和目录，包括隐藏文件（如.git、.gitignore）和数据库文件（如.db、.db-shm、.db-wal）。' + result.data
                            logger.info(`[AI-Plugin] ${call.name} 完成，结果已注入`)
                        } else if (call.name === 'shell_exec') {
                            const formattedResult = toolRegistry.formatToolResult('shell_exec', result.data)
                            userMessage = userMessage + '\n\n【重要指令】以上为服务器 Shell 命令的实际执行结果。请严格基于 stdout/stderr/退出码回答，不要编造未执行的结果。' + formattedResult
                            executedShellCommands.push(normalizeShellCommand(result.data?.command || call.args?.command))
                            logger.warn(`[AI-Plugin] shell_exec 完成，结果已注入`)
                        } else if (call.name === 'file_send' || call.name === 'file_download') {
                            const formattedResult = toolRegistry.formatToolResult(call.name, result.data)
                            userMessage = userMessage + '\n\n【重要指令】以上为文件收发工具的实际执行结果，请如实告知主人操作结果，不要编造。' + formattedResult
                            logger.info(`[AI-Plugin] ${call.name} 完成，结果已注入`)
                        } else if (call.name === 'group_file_list' || call.name === 'group_file_download') {
                            const formattedResult = toolRegistry.formatToolResult(call.name, result.data)
                            userMessage = userMessage + '\n\n【重要指令】以上为群文件工具的实际执行结果，请如实、完整地告知主人，逐条列出每一个文件，不要只挑部分/代表文件，不要编造文件名或结果。' + formattedResult
                            logger.info(`[AI-Plugin] ${call.name} 完成，结果已注入`)
                        } else if (['group_mute', 'group_whole_mute', 'group_kick', 'group_set_card', 'group_set_title', 'group_essence', 'group_request_list', 'group_request_handle'].includes(call.name)) {
                            const formattedResult = toolRegistry.formatToolResult(call.name, result.data)
                            userMessage = userMessage + '\n\n【重要指令】以上为群管理工具的实际执行结果，请如实转告操作者，不要编造结果。' + formattedResult
                            logger.info(`[AI-Plugin] ${call.name} 完成，结果已注入`)
                        } else {
                            userMessage = userMessage + result.data
                            logger.info(`[AI-Plugin] ${call.name} 完成，结果已注入`)
                        }
                    } else {
                        logger.warn(`[AI-Plugin] ${call.name} 失败: ${result.error}`)
                    }
                }

                if (e.isMaster && enabledTools.includes('shell_exec') && executedShellCommands.length > 0) {
                    const toolContext = { userId: e.user_id, groupId: e.group_id, event: e }
                    const seenCommands = new Set(executedShellCommands.filter(Boolean))
                    // 翻页续读使用 "命令@offset" 作为去重键，允许同命令不同分页继续
                    const seenPagedKeys = new Set()
                    for (let round = 1; round <= Config.SHELL_EXEC_FOLLOWUP_MAX_ROUNDS; round++) {
                        const decision = await askMainModelForNextShellCommand(this.client, modelGroupKey, providerFilter, userMessage, [...seenCommands], round)
                        if (!decision?.need_shell) {
                            logger.info(`[AI-Plugin] Shell 补查结束: ${decision?.reason || '无需补查'}`)
                            break
                        }

                        const command = normalizeShellCommand(decision.command)
                        if (!command) {
                            logger.warn('[AI-Plugin] Shell 补查跳过：未返回 command')
                            break
                        }
                        const offsetChars = Math.max(Number(decision.offset_chars) || 0, 0)
                        const isPaging = offsetChars > 0
                        const pagedKey = `${command}@${offsetChars}`
                        // 非翻页的重复命令直接停止；翻页命令只要 offset 不同就允许继续
                        if (isPaging) {
                            if (seenPagedKeys.has(pagedKey)) {
                                logger.warn(`[AI-Plugin] Shell 补查跳过重复翻页: ${pagedKey}`)
                                break
                            }
                        } else if (seenCommands.has(command)) {
                            logger.warn(`[AI-Plugin] Shell 补查跳过重复命令: ${command}`)
                            break
                        }

                        const args = {
                            command,
                            cwd: decision.cwd,
                            timeout_ms: decision.timeout_ms,
                            max_output_chars: decision.max_output_chars,
                            offset_chars: offsetChars
                        }
                        logger.warn(`[AI-Plugin] Shell 补查第 ${round} 轮: ${command}${isPaging ? ` (offset=${offsetChars})` : ''}`)
                        const result = await toolRegistry.execute('shell_exec', args, e.isMaster, toolContext)
                        if (!result.success) {
                            logger.warn(`[AI-Plugin] Shell 补查失败: ${result.error}`)
                            userMessage += `\n\n【Shell补查失败】命令: ${command}\n错误: ${result.error}\n`
                            break
                        }

                        const formattedResult = toolRegistry.formatToolResult('shell_exec', result.data)
                        const pagingNote = result.data?.paging?.hasMore ? '（注意：本页仍未读完，如需完整数据可继续翻页）' : ''
                        userMessage += `\n\n【Shell补查第${round}轮】主模型判断需要继续补充服务器信息。请同样严格基于实际执行结果回答，不要编造未执行的结果。${pagingNote}${formattedResult}`
                        seenPagedKeys.add(pagedKey)
                        if (!isPaging) seenCommands.add(command)
                    }
                }
            }

            // Vision Relay：flag v 强制启用，否则按全局配置 + 模型是否需要转述
            const useVisionRelay = e._visionFlag || (this.client.enableVisionRelay && this.client._checkModelGroupNeedsVisionRelay(modelGroupKey, providerFilter))
            if (allImages.length > 0) {
                // 图片编号替换：将文本中的 [图片] 替换为 [图片#N]，让AI能对应图片和发送者
                let imgIndex = 0
                userMessage = userMessage.replace(/\[图片\]/g, () => {
                    imgIndex++
                    return `[图片#${imgIndex}]`
                })
            }
            if (allImages.length > 0 && useVisionRelay) {
                const visionModels = this.client.visionModels
                logger.info(`[AI-Plugin] Vision Relay: 检测到 ${allImages.length} 张图片，开始转述，共 ${visionModels.length} 个 Vision 模型`)
                let description = ''
                for (const visionConf of visionModels) {
                    description = await relayImagesToVision(allImages, userMessage, this.client, visionConf)
                    if (description) break
                    logger.warn(`[AI-Plugin] Vision Relay: ${visionConf.provider_id}/${visionConf.model_id} 转述失败，尝试下一个`)
                }
                if (description) {
                    const relayHeader = '\n\n【以下是对用户发送图片的详细描述，请基于此描述理解图片内容：】\n'
                    userMessage = (userMessage || '') + relayHeader + description + '\n【图片描述结束】\n'
                    allImages = []
                    logger.info(`[AI-Plugin] Vision Relay: 转述完成，图片已替换为文本描述`)
                } else {
                    logger.warn('[AI-Plugin] Vision Relay: 所有 Vision 模型转述均失败，保留原始图片发送给主模型')
                }
            }

            const isSingleMode = e._singleMode === true
            const userId = e.user_id

            // 画图场景工具已发过"🎨正在生成"进度提示（无论成败），跳过"思考中"占位避免重复；
            // 普通思考占位由主人命令「#ai开启/关闭思考提示」控制，默认关闭。
            if (getAccessConfig().show_thinking_notice === true && !drawImageAttempted) {
                if (!isSingleMode) {
                    await e.reply(`${Config.AI_NAME}思考中 (使用 ${modelDisplay} 模型组)…`, true)
                } else {
                    await e.reply(`${Config.AI_NAME}思考中 (单次对话模式，使用 ${modelDisplay} 模型组)…`, true)
                }
            }
            await setMsgEmojiLike(e, 282)

            let history = []
            let incrementalCheckpoint = null

            if (!isSingleMode) {
                const memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(userId)
                history = memoryData.history
                incrementalCheckpoint = memoryData.incrementalCheckpoint

                if (incrementalCheckpoint) {
                    logger.debug(`[AI-Plugin] 用户 ${userId} 加载增量总结记忆`)
                }

                const MAX_HISTORY_LENGTH = Config.MAX_HISTORY_LENGTH
                if (history.length > MAX_HISTORY_LENGTH) {
                    history = history.slice(-MAX_HISTORY_LENGTH)
                    logger.debug(`[AI-Plugin] 用户 ${userId} 的历史过长，已截断至最近 ${MAX_HISTORY_LENGTH} 条`)
                }
            }

            const currentUserTurnParts = []

            if (allImages.length > 0) {
                const validImages = await processImagesInBatches(allImages)
                currentUserTurnParts.push(...validImages)
            }

            if (userMessage) {
                currentUserTurnParts.push({ "text": userMessage })
            }

            let contents = [...Config.personaPrimer]

            // 添加当前服务器时间（放在最前面，确保不被旧记忆干扰）
            const timeStr = getBeijingTimeStr()
            contents.push({
                "role": "user",
                "parts": [{ "text": `【服务器时间 - 最高优先级】以下时间是当前真实时间，请忽略记忆中的任何旧时间信息：${timeStr}。当用户询问时间或需要判断时间时，必须使用这个时间！` }]
            })
            contents.push({
                "role": "model",
                "parts": [{ "text": "好的，我已经知道现在的准确时间了，会以此为准！" }]
            })

            if (incrementalCheckpoint) {
                contents.push({
                    "role": "user",
                    "parts": [{ "text": `【记忆总结】这是关于你与用户之前对话的记忆总结，包含了重要的上下文信息，请基于这些记忆继续对话：\n${incrementalCheckpoint}` }]
                })
                contents.push({
                    "role": "model",
                    "parts": [{ "text": "好的，我已经想起了之前的记忆！" }]
                })
            }

            contents.push(...history)

            // 添加聊天环境提示（放在历史之后，用户消息之前，确保最高优先级）
            const trustedGroups = Config.trustedGroups
            const prompts = Config.Prompts
            let environmentHint = ""
            if (e.isGroup) {
                const groupId = String(e.group_id)
                if (trustedGroups.includes(groupId)) {
                    environmentHint = expandPrompt(prompts?.environment?.trusted_group, { group_id: groupId }) || `【当前聊天环境】这是一个受信任的群聊环境（群号：${groupId}）。你可以正常交流，但仍需遵守基本的隐私保护规则。`
                } else {
                    environmentHint = expandPrompt(prompts?.environment?.public_group, { group_id: groupId }) || `【当前聊天环境】这是一个公开的 QQ 群聊（群号：${groupId}），属于公开场合。请严格遵守隐私保护规则，不要在与用户相关的对话中透露任何个人信息或敏感内容。`
                }
            } else {
                environmentHint = prompts?.environment?.private_chat || `【当前聊天环境】这是与用户的私聊对话，属于安全环境。可以正常交流。`
            }
            logger.info(`[AI-Plugin] 环境提示: ${environmentHint}`)
            contents.push({
                "role": "user",
                "parts": [{ "text": environmentHint }]
            })
            contents.push({
                "role": "model",
                "parts": [{ "text": "好的，我已经了解当前的聊天环境，会根据环境调整我的行为！" }]
            })

            contents.push({ "role": "user", "parts": currentUserTurnParts })

            // 估算请求体大小，防止 413 错误（请求体过大导致 API 拒绝）
            let currentPayload = { "contents": contents }
            let currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
            
            // 请求体超过警告阈值时，开始裁剪历史对话
            if (currentSizeMB > Config.REQUEST_SIZE_WARNING_MB) {
                logger.warn(`[AI-Plugin] 请求体过大 (${currentSizeMB.toFixed(2)}MB)，正在裁剪历史...`)

                // 缓存前缀部分（personaPrimer + 时间注入 + 记忆总结 + 环境提示），避免循环内重复构建
                const prefixParts = contents.slice(0, contents.length - history.length - 1)

                // 循环裁剪历史，直到请求体低于限制或达到最少保留条数
                while (currentSizeMB > Config.REQUEST_SIZE_LIMIT_MB && history.length > Config.MIN_HISTORY_FOR_TRUNCATION) {
                    // 每次裁剪 5 条历史，但保证至少保留 MIN_HISTORY_FOR_TRUNCATION 条
                    history = history.slice(-Math.max(Config.MIN_HISTORY_FOR_TRUNCATION, history.length - 5))
                    const trimmedContents = [...prefixParts, ...history, { "role": "user", "parts": currentUserTurnParts }]
                    currentPayload = { "contents": trimmedContents }
                    currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
                }
                // 更新最终的 contents 为裁剪后的结果
                contents = [...prefixParts, ...history, { "role": "user", "parts": currentUserTurnParts }]
                logger.info(`[AI-Plugin] 请求体已裁剪至 ${currentSizeMB.toFixed(2)}MB`)
            }
            
            const result = await this.client.makeRequest('chat', currentPayload, modelGroupKey, 8192, providerFilter)

            if (result.success) {
                let rawResponseText = result.data.trim()
                let finalResponseText = rawResponseText
                const config = getAccessConfig()
                if (!config.show_thinking) {
                    const blocks = rawResponseText.split('\n\n')
                    let startContentIndex = 0
                    let foundContent = false
                    for (let i = 0; i < blocks.length; i++) {
                        const currentBlock = blocks[i].trim()
                        const isThinkingBlock = currentBlock.startsWith('*Thinking') || currentBlock.startsWith('>')
                        if (!isThinkingBlock) {
                            startContentIndex = i
                            foundContent = true
                            break
                        }
                    }
                    if (foundContent) {
                        finalResponseText = blocks.slice(startContentIndex).join('\n\n').trim()
                        finalResponseText = finalResponseText.replace(/^>\s*/, '').trim()
                    }
                    if (!finalResponseText) {
                        finalResponseText = rawResponseText
                    }
                }
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

                let tokenInfo = ''
                if (result.usage) {
                    if (result.usage.prompt_tokens !== undefined && result.usage.completion_tokens !== undefined) {
                        tokenInfo = ` | 输入Tokens: ${result.usage.prompt_tokens} | 输出Tokens: ${result.usage.completion_tokens}`
                    } else if (result.usage.total_tokens) {
                        tokenInfo = ` | 消耗Token: ${result.usage.total_tokens}`
                    }
                }

                // 分段处理：如果回复内容过长，使用合并消息发送
                const MAX_LENGTH = Config.CHECKPOINT_DISPLAY_MAX_LENGTH
                const footerSuffix = isSingleMode ? ' (单次对话)' : ''
                const footerInfo = `⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform}${footerSuffix}`

                if (finalResponseText.length <= MAX_LENGTH) {
                    await e.reply(`${finalResponseText}\n\n${footerInfo}`, true)
                } else {
                    const forwardMsgNodes = []
                    let content = finalResponseText
                    let part = 1

                    // 第一段包含回复内容
                    while (content.length > 0) {
                        let splitIndex = MAX_LENGTH
                        if (content.length > MAX_LENGTH) {
                            const lastNewLine = content.lastIndexOf('\n', MAX_LENGTH)
                            if (lastNewLine > MAX_LENGTH * 0.8) splitIndex = lastNewLine + 1
                        }
                        const chunk = content.slice(0, splitIndex)
                        content = content.slice(splitIndex)

                        if (content.length === 0) {
                            // 最后一段，加上耗时信息
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `${Config.AI_NAME} (Part ${part})`,
                                message: `${chunk}\n\n${footerInfo}`
                            })
                        } else {
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `${Config.AI_NAME} (Part ${part})`,
                                message: chunk
                            })
                        }
                        part++
                    }

                    const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                    await e.reply(forwardMsg)
                }

                await setMsgEmojiLike(e, 144)

                if (!isSingleMode) {
                    const updatedHistory = [...history, { "role": "user", "parts": currentUserTurnParts }, { "role": "model", "parts": [{ "text": finalResponseText }] }]
                    await this.conversationManager.saveUserHistory(userId, updatedHistory)

                    if (updatedHistory.length >= Config.AUTO_SUMMARY_THRESHOLD) {
                        logger.info(`[AI-Plugin] 用户 ${userId} 对话已达 ${updatedHistory.length} 轮，自动触发增量总结`)
                        const todayStr = getTodayDateStr()
                        try {
                            await this.conversationManager.createIncrementalCheckpoint(userId, todayStr, 0, modelGroupKey)
                            logger.info(`[AI-Plugin] 用户 ${userId} 增量总结完成，保留对话历史`)
                        } catch (summaryErr) {
                            logger.error(`[AI-Plugin] 自动增量总结失败:`, summaryErr)
                        }
                    }
                }
            } else {
                await setMsgEmojiLike(e, 10)
                await e.reply(`❌ 请求失败\n错误: ${result.error}`, true)
            }
        } catch (err) {
            await setMsgEmojiLike(e, 10)
            logger.error(`[AI-Plugin] 对话处理异常:`, err)
            await e.reply(`❌ 处理异常: ${err.message}`, true)
        }
    }

    async exportMyMemory(e) {
        await e.reply("收到指令，正在打包你的专属记忆… 请稍等片刻喵~ ⏳")
        try {
            const userId = String(e.user_id)
            const result = await this.conversationManager.exportMemory(e, userId, 'single')
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, '你的专属记忆')
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出个人记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportMemoryByDate(e) {
        const dateMatch = e.msg.match(new RegExp(`^#导出${Config.AI_NAME}记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'))
        const targetDate = dateMatch[1]
        await e.reply(`收到指令，正在打包 ${targetDate} 的记忆… 请稍等片刻喵~ ⏳`)
        try {
            const userId = String(e.user_id)
            const result = await this.conversationManager.exportMemory(e, userId, 'single', targetDate)
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, `${targetDate} 的记忆`)
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出指定日期记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportAllMemory(e) {
        await e.reply(`收到最高权限指令，开始导出${Config.AI_NAME}的全部记忆… 这可能需要一点时间喵~ ⏳`)
        try {
            const result = await this.conversationManager.exportMemory(e, null, 'all')
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, '全部记忆')
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出全部记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportAllMemoryByDate(e) {
        const dateMatch = e.msg.match(new RegExp(`^#导出${Config.AI_NAME}全部记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'))
        const targetDate = dateMatch[1]
        await e.reply(`收到最高权限指令，开始导出 ${targetDate} 的全部记忆… 这可能需要一点时间喵~ ⏳`)
        try {
            const result = await this.conversationManager.exportMemory(e, null, 'all', targetDate)
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, `${targetDate} 的全部记忆`)
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出全部指定日期记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async _sendMemoryFile(e, filePath, memoryType) {
        if (e.isGroup) {
            try {
                await e.reply(`✅ 成功导出${memoryType}！正在上传到本群...`, true)
                await e.group.sendFile(filePath)
            } catch (uploadErr) {
                logger.error(`[AI-Plugin] 记忆文件群聊上传失败:`, uploadErr)
                await e.reply(`呜...文件上传失败了！\n但别担心，文件已经成功保存在服务器上了哦：\n${filePath}`, true)
            }
        } else {
            try {
                await e.reply(`✅ 成功导出${memoryType}！正在发送给你...`, true)
                await e.friend.sendFile(filePath)
            } catch (uploadErr) {
                logger.error(`[AI-Plugin] 记忆文件私聊发送失败:`, uploadErr)
                await e.reply(`呜...文件发送失败了！\n但别担心，文件已经成功保存在服务器上了哦：\n${filePath}`, true)
            }
        }
    }

    async switchThinkingMode(e) {
        const isTurnOn = e.msg.includes("开启")
        const config = getAccessConfig()

        config.show_thinking = isTurnOn
        saveAccessConfig(config)

        if (isTurnOn) {
            await e.reply("✅ 设置成功：已开启思考过程显示 (Raw模式)。")
        } else {
            await e.reply("🚫 设置成功：已关闭思考过程显示 (自动清洗模式)。")
        }
    }

    async switchThinkingNotice(e) {
        const isTurnOn = e.msg.includes("开启")
        const config = getAccessConfig()

        config.show_thinking_notice = isTurnOn
        saveAccessConfig(config)

        if (isTurnOn) {
            await e.reply(`✅ 设置成功：已开启${Config.AI_NAME}思考提示。普通对话会发送“${Config.AI_NAME}思考中…”占位提示。`)
        } else {
            await e.reply(`🚫 设置成功：已关闭${Config.AI_NAME}思考提示。普通对话将不再发送“${Config.AI_NAME}思考中…”占位提示。`)
        }
    }
}
