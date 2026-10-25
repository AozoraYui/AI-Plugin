import { pluginLogger as logger } from '../utils/plugin_logger.js'
import plugin from '../../../lib/plugins/plugin.js'
import { cancelAgentExecutionsByRecalledMessage, parseRecallNotice } from '../utils/agent_cancellation.js'

async function handleRecall(e) {
    const recall = parseRecallNotice(e)
    if (!recall) return false
    const { messageId, groupId, userId, operatorId } = recall
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
    } else {
        logger.debug(`[AI-Plugin] 收到撤回事件，但没有匹配到活动执行：message_id=${messageId}, group_id=${groupId}, user_id=${userId}`)
    }
    return false
}

export class AIAgentRecallCancel extends plugin {
    constructor() {
        super({
            name: '[AI插件]撤回取消AI任务',
            dsc: '触发 AI 任务的消息被作者撤回时取消对应任务',
            event: 'notice',
            priority: -10000
        })
    }

    async accept(e) {
        return handleRecall(e)
    }
}
