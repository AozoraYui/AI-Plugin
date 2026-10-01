import plugin from '../../../lib/plugins/plugin.js'
import {
    GROUP_INCREASE_KEY,
    GROUP_INCREASE_TTL_SECONDS
} from '../tools/group_admin.js'

export class AIGroupIncrease extends plugin {
    constructor() {
        super({
            name: '[AI插件]AI群成员入群记录',
            dsc: '记录群成员实际入群事件供 AI 查询最近新成员',
            event: 'notice.group.increase',
            priority: 5000
        })
    }

    async accept(e) {
        try {
            if (e.notice_type !== 'group_increase' || !e.group_id || !e.user_id) return false
            if (typeof redis === 'undefined' || !redis.set) return false

            const joinTime = Number(e.time) > 0 ? Number(e.time) : Math.floor(Date.now() / 1000)
            let nickname = e.nickname || ''
            if (!nickname) {
                try {
                    const info = await (e.bot ?? Bot).pickUser?.(e.user_id)?.getInfo?.()
                    nickname = info?.nickname || ''
                } catch {}
            }

            const record = {
                group_id: String(e.group_id),
                user_id: String(e.user_id),
                operator_id: e.operator_id ? String(e.operator_id) : '',
                sub_type: e.sub_type || '',
                nickname,
                join_time: joinTime,
                recorded_at: Date.now()
            }
            const key = GROUP_INCREASE_KEY(e.group_id, e.user_id, joinTime)
            await redis.set(key, JSON.stringify(record), { EX: GROUP_INCREASE_TTL_SECONDS })
            logger.info(`[AI-Plugin] 已记录成员入群事件：群 ${e.group_id} 用户 ${e.user_id}`)
        } catch (err) {
            logger.warn(`[AI-Plugin] 记录成员入群事件失败: ${err.message}`)
        }
        return false
    }
}
