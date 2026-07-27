import { Config, expandPrompt } from './config.js'

function normalizeParticipantIds(ids = [], actorUserId = '') {
    const actor = String(actorUserId || '').trim()
    return [...new Set((Array.isArray(ids) ? ids : [])
        .map(id => String(id || '').trim())
        .filter(id => id && id !== 'all' && id !== actor))]
}

export function isThirdPartySubjectQuery(text = '', actorUserId = '', mentionedUserIds = []) {
    const mentions = normalizeParticipantIds(mentionedUserIds, actorUserId)
    if (mentions.length === 0) return false
    const value = String(text || '').replace(/\[@\d+\]/g, '@成员').trim()
    if (!value) return false
    return /(?:印象|看法|评价|怎么看|如何看|觉得.{0,8}(?:怎样|怎么样|如何)|是什么样(?:的)?人|性格|人品|了解多少|认识多久|熟悉吗|档案|画像|资料|个人信息|住哪|所在地|城市)/i.test(value)
}

export function resolvePrivateMemorySubject(actorUserId = '', mentionedUserIds = [], options = {}) {
    const actor = String(actorUserId || '').trim()
    const mentions = normalizeParticipantIds(mentionedUserIds, actor)
    const thirdPartyFocused = options.thirdPartyFocused === true
    if (!thirdPartyFocused) {
        return { userId: actor, targetUserId: '', label: '触发者', allowed: Boolean(actor) }
    }
    if (options.isMaster === true && mentions.length === 1) {
        return {
            userId: mentions[0],
            targetUserId: mentions[0],
            label: `被 @ 成员 QQ ${mentions[0]}`,
            allowed: true
        }
    }
    return { userId: '', targetUserId: '', label: '第三方成员', allowed: false }
}

export function buildParticipantIdentityHint(actorUserId = '', mentionedUserIds = [], options = {}) {
    const actor = String(actorUserId || '').trim()
    const mentions = normalizeParticipantIds(mentionedUserIds, actor)
    if (!actor && mentions.length === 0) return ''
    const thirdPartyFocused = options.thirdPartyFocused === true
    const targetPrivateContextAllowed = options.targetPrivateContextAllowed === true
    const lines = [
        '【本轮参与者身份边界 - 高优先级】',
        actor ? `当前发言者是 QQ ${actor}。` : '',
        mentions.length > 0 ? `当前消息明确 @ 的其他成员是：${mentions.map(id => `QQ ${id}`).join('、')}。` : '',
        '任何标注为“触发者/当前用户”的个人历史、记忆摘要或个人档案，都只属于当前发言者，绝不能套用到被 @ 的成员身上。'
    ].filter(Boolean)
    if (thirdPartyFocused) {
        lines.push('当前问题主要询问被 @ 的第三方。不要使用当前发言者的私有记忆来描述对方。')
        if (targetPrivateContextAllowed && mentions.length === 1) {
            lines.push(`系统已允许本轮读取并提供被 @ 成员 QQ ${mentions[0]} 的存储信息；只能使用明确标注归属于该 QQ 的档案、摘要和检索结果，不能混入当前发言者资料。`)
            lines.push('可以据此回答非敏感的印象、偏好和长期特征，但仍不得公开精确住址、联系方式、账号凭据等高敏感字段。')
        } else {
            lines.push('本轮没有提供该成员的私有档案，只能依据可见的公开群聊上下文和明确标注属于该成员的公开记录回答；证据不足时应直接说明不够了解。')
        }
    }
    return lines.join('\n')
}

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
    const selfProfileRule = '【隐私规则解释】禁止主动泄露不等于拒绝当前用户查询自己的信息。当前发言者明确询问自己档案中的特定字段、询问字段值，或要求按自己档案中的所在地查询天气时，可以只回答其请求涉及的字段，不需要再次要求授权；城市级所在地可以直接使用。不要因此展示完整档案，也不要透露其他用户信息、精确住址、联系方式、账号凭据等高敏感信息。'
    let environmentText = ''
    if (e.isGroup || e.group_id) {
        const groupId = String(e.group_id)
        if (trustedGroups.includes(groupId)) {
            environmentText = expandPrompt(prompts?.environment?.trusted_group, { group_id: groupId }) || `【当前聊天环境】这是一个受信任的群聊环境（群号：${groupId}）。你可以正常交流，但仍需遵守基本的隐私保护规则。`
        } else {
            environmentText = expandPrompt(prompts?.environment?.public_group, { group_id: groupId }) || `【当前聊天环境】这是一个公开的 QQ 群聊（群号：${groupId}），属于公开场合。请严格遵守隐私保护规则，不要主动透露与用户相关的个人信息或敏感内容。`
        }
    } else {
        environmentText = prompts?.environment?.private_chat || '【当前聊天环境】这是与用户的私聊对话，属于安全环境。可以正常交流。'
    }
    return `${environmentText}\n${selfProfileRule}`
}
