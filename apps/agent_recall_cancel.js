import plugin from '../../../lib/plugins/plugin.js'
import { cancelAgentExecutionsByRecalledMessage } from '../utils/agent_cancellation.js'

async function handleRecall(e) {
    const noticeType = String(e?.notice_type || '')
    if (noticeType !== 'group_recall' && noticeType !== 'friend_recall') return false

    const messageId = e?.message_id || e?.seq || ''
    const groupId = noticeType === 'group_recall' ? e?.group_id || '' : ''
    const userId = e?.user_id || ''
    const operatorId = noticeType === 'group_recall' ? e?.operator_id || '' : userId
    const cancelled = cancelAgentExecutionsByRecalledMessage({
        messageId,
        groupId,
        userId,
        operatorId
    })

    const taskIds = [...new Set(cancelled.map(item => item.taskId).filter(Boolean))]
    const db = global.AIPluginConversationManager?.db
    let persistedCount = 0
    if (db?.cancelAgentTask) {
        for (const taskId of taskIds) {
            try {
                if (await db.cancelAgentTask(taskId, '触发任务的消息已撤回')) persistedCount++
            } catch (err) {
                logger.warn(`[AI-Plugin] 撤回取消 Agent 任务持久化失败: ${taskId}: ${err.message}`)
            }
        }
    }

    if (cancelled.length > 0) {
        logger.info(`[AI-Plugin] 检测到触发消息撤回，已取消 ${cancelled.length} 个活动执行，持久化任务 ${persistedCount} 个：message_id=${messageId}`)
    }
    return false
}

export class AIAgentGroupRecallCancel extends plugin {
    constructor() {
        super({
            name: '[AI插件]撤回取消AI任务',
            dsc: '触发 AI 任务的消息被作者撤回时取消对应任务',
            event: 'notice.group_recall',
            priority: -10000
        })
    }

    async accept(e) {
        return handleRecall(e)
    }
}

export class AIAgentFriendRecallCancel extends plugin {
    constructor() {
        super({
            name: '[AI插件]撤回取消AI任务',
            dsc: '触发 AI 任务的消息被作者撤回时取消对应任务',
            event: 'notice.friend_recall',
            priority: -10000
        })
    }

    async accept(e) {
        return handleRecall(e)
    }
}
