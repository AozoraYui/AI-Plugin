import { Config, expandPrompt } from './config.js'

export function extractCardInfo(data = {}) {
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

export async function expandForwardMsg(bot, resid, depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
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
            const sender = subMsg.nickname || subMsg.sender?.nickname || '未知用户'
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

export async function expandInlineContent(bot, msgArray, sender = '发送者', depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '【嵌套层级过深，停止展开】', images: [] }
    }

    let subText = ''
    for (const seg of msgArray) {
        if (seg.type === 'text') {
            subText += seg.data?.text || seg.text || ''
        } else if (seg.type === 'image') {
            const imgUrl = seg.data?.url || seg.url
            if (imgUrl) {
                images.push(imgUrl)
                subText += ' [图片] '
            }
        } else if (seg.type === 'forward') {
            const nestedId = seg.id || seg.data?.id
            const nestedContent = seg.data?.content || seg.content
            if (Array.isArray(nestedContent)) {
                logger.info(`[AI-Plugin] 发现内联合并消息 (type=forward, 内联content)，开始递归展开 (深度${depth + 1})`)
                const layerTag = `第${depth + 1}层`
                textParts.push(`【${layerTag}嵌套消息 开始】`)
                for (const nestedMsg of nestedContent) {
                    const nestedSender = nestedMsg.nickname || nestedMsg.sender?.nickname || '未知用户'
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
                    subText = ''
                }
            } else if (nestedId) {
                logger.info(`[AI-Plugin] 发现嵌套合并消息 (type=forward, id=${nestedId})，开始递归展开 (深度${depth + 1})`)
                const nested = await expandForwardMsg(bot, nestedId, depth + 1, maxDepth)
                if (subText.trim()) {
                    textParts.push(`[${sender}]: ${subText}`)
                    subText = ''
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
                    logger.warn('[AI-Plugin] expandInlineContent JSON data 解析失败:', err)
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
                        subText = ''
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

export function buildEnvironmentHint(e = {}) {
    const trustedGroups = Config.trustedGroups
    const prompts = Config.Prompts
    if (e.isGroup || e.group_id) {
        const groupId = String(e.group_id)
        if (trustedGroups.includes(groupId)) {
            return expandPrompt(prompts?.environment?.trusted_group, { group_id: groupId }) || `【当前聊天环境】这是一个受信任的群聊环境（群号：${groupId}）。你可以正常交流，但仍需遵守基本的隐私保护规则。`
        }
        return expandPrompt(prompts?.environment?.public_group, { group_id: groupId }) || `【当前聊天环境】这是一个公开的 QQ 群聊（群号：${groupId}），属于公开场合。请严格遵守隐私保护规则，不要在与用户相关的对话中透露任何个人信息或敏感内容。`
    }
    return prompts?.environment?.private_chat || '【当前聊天环境】这是与用户的私聊对话，属于安全环境。可以正常交流。'
}
