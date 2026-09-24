import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { getAccessConfig } from '../utils/access.js'
import { getDBTimestamp } from '../utils/common.js'
import { extractMessageIds, normalizeOutboundMessage } from '../utils/outbound_message.js'

const REPLY_WRAPPED = Symbol('aiPluginOutboundReplyWrapped')
let syntheticMessageSequence = 0

function getBotUserId(e) {
    return String(e?.self_id || e?.bot?.uin || e?.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : '') || 'bot')
}

function getReplyMessageIds(response) {
    const ids = extractMessageIds(response)
    if (ids.length > 0) return ids
    syntheticMessageSequence = (syntheticMessageSequence + 1) % 1000000
    return [`outbound_${Date.now()}_${syntheticMessageSequence}`]
}

function replyFailed(response) {
    return response === false || Boolean(response?.error) || response?.status === 'failed'
}

function captureAllowed(e) {
    const accessConfig = getAccessConfig()
    const userId = String(e?.user_id || '')
    const groupId = String(e?.group_id || '')
    return !accessConfig.blacklist_users?.includes(userId) && !accessConfig.blacklist_groups?.includes(groupId)
}

async function persistInboundCommand(e) {
    if (!e?.group_id || !String(e.msg || '').trim().startsWith('#') || !captureAllowed(e)) return
    const enabled = global.AIPluginClient?.enableFastChat || Config.enable_fast_chat === true
    if (!enabled) return
    const db = global.AIPluginConversationManager?.db
    if (!db?.saveGroupMessageLog) return
    const normalized = normalizeOutboundMessage(e.message?.length ? e.message : e.msg)
    if (!normalized.normalizedText && normalized.imageMeta.length === 0) return
    await db.saveGroupMessageLog({
        groupId: String(e.group_id),
        messageId: String(e.message_id || e.seq || `command_${Date.now()}_${e.user_id || 'unknown'}`),
        seq: e.seq || '',
        userId: String(e.user_id || ''),
        nickname: e.sender?.card || e.sender?.nickname || e.member?.card || e.member?.nickname || `用户${e.user_id}`,
        normalizedText: normalized.normalizedText,
        imageMeta: normalized.imageMeta,
        createdAt: getDBTimestamp(),
        isCommand: true,
        isBot: String(e.user_id || '') === getBotUserId(e)
    })
}

async function persistOutboundMessage(e, message, response) {
    if (!e?.group_id || replyFailed(response)) return
    const db = global.AIPluginConversationManager?.db
    if (!db?.saveGroupMessageLog) return

    const normalized = normalizeOutboundMessage(message)
    if (!normalized.normalizedText && normalized.imageMeta.length === 0 && normalized.forwardNodes.length === 0) return

    const createdAt = getDBTimestamp()
    const messageIds = getReplyMessageIds(response)
    const messageId = messageIds[0]
    const userId = getBotUserId(e)
    await db.saveGroupMessageLog({
        groupId: String(e.group_id),
        messageId,
        userId,
        nickname: Config.AI_NAME,
        normalizedText: normalized.normalizedText,
        imageMeta: normalized.imageMeta,
        createdAt,
        isCommand: false,
        isBot: true
    })

    if (normalized.forwardNodes.length > 0 && db.saveOutboundForwardMessage) {
        for (const forwardMessageId of messageIds) {
            await db.saveOutboundForwardMessage({
                groupId: String(e.group_id),
                messageId: forwardMessageId,
                nodes: normalized.forwardNodes,
                normalizedText: normalized.normalizedText,
                imageMeta: normalized.imageMeta,
                createdAt
            })
        }
        logger.info(`[AI-Plugin] 已缓存机器人合并转发: 群=${e.group_id}, message_id=${messageIds.join(',')}, 节点=${normalized.forwardNodes.length}`)
    } else if (normalized.forwardNodes.length === 0 && isForwardMessage(message)) {
        logger.warn(`[AI-Plugin] 机器人合并转发未提取到节点: 群=${e.group_id}, 返回ID=${messageIds.join(',') || '无'}`)
    }
}

function isForwardMessage(message) {
    const parts = Array.isArray(message) ? message : [message]
    return parts.some(part => ['node', 'forward'].includes(String(part?.type || '').toLowerCase()))
}

export class OutboundMessageCapture extends plugin {
    constructor() {
        super({
            name: 'AI出站消息记录',
            dsc: '记录机器人发送的群消息并缓存合并转发原文',
            event: 'message',
            priority: -10000,
            rule: [
                { reg: /^.*$/s, fnc: 'captureReply', log: false }
            ]
        })
    }

    async captureReply(e) {
        if (!e?.reply || e[REPLY_WRAPPED]) return false

        try {
            await persistInboundCommand(e)
        } catch (err) {
            logger.warn(`[AI-Plugin] 命令消息提前入库失败: ${err.message}`)
        }

        const originalReply = e.reply
        e[REPLY_WRAPPED] = true
        e.reply = async (...args) => {
            const outgoingMessage = args[0]
            let response
            try {
                response = await originalReply(...args)
            } catch (err) {
                throw err
            }

            try {
                await persistOutboundMessage(e, outgoingMessage, response)
            } catch (err) {
                logger.warn(`[AI-Plugin] 出站群消息记录失败: ${err.message}`)
            }
            return response
        }
        return false
    }
}
