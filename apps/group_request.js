import plugin from '../../../lib/plugins/plugin.js'
import { GROUP_REQUEST_KEY } from '../tools/group_admin.js'

/**
 * 入群申请监听
 * 监听 request 事件中的加群申请（sub_type=add），把待审申请缓存到 redis，
 * 供 AI 的 group_request_list / group_request_handle 工具读取与处理。
 * 仅做记录，不自动同意或拒绝。
 */
export class AIGroupRequest extends plugin {
    constructor() {
        super({
            name: 'AI入群申请监听',
            dsc: '记录加群申请供 AI 审核',
            event: 'request.group.add',
            priority: 5000
        })
    }

    async accept(e) {
        try {
            // 仅处理加群申请
            if (e.request_type !== 'group' || e.sub_type !== 'add') return false
            if (!e.group_id || !e.user_id || !e.flag) return false
            if (typeof redis === 'undefined' || !redis.set) return false

            // 仅在「AI插件已开启群管理功能」时记录，避免无谓占用 redis
            const client = global.AIPluginClient
            if (client && client.enableGroupAdmin === false) return false

            let nickname = e.nickname
            if (!nickname) {
                try {
                    const info = await (e.bot ?? Bot).pickUser?.(e.user_id)?.getInfo?.()
                    nickname = info?.nickname || ''
                } catch { /* 忽略 */ }
            }

            const record = {
                user_id: e.user_id,
                group_id: e.group_id,
                flag: e.flag,
                sub_type: e.sub_type,
                comment: e.comment || '',
                nickname: nickname || '',
                time: Date.now()
            }
            // 申请记录保留 1 小时（与 QQ 申请有效期大致一致）
            await redis.set(GROUP_REQUEST_KEY(e.group_id, e.user_id), JSON.stringify(record), { EX: 3600 })
            logger.info(`[AI-Plugin] 已记录加群申请：群 ${e.group_id} 用户 ${e.user_id}`)
        } catch (err) {
            logger.error('[AI-Plugin] 记录加群申请失败:', err)
        }
        // 不拦截事件，交还给其他插件继续处理
        return false
    }
}
