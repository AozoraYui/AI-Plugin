import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'

export class HelpHandler extends plugin {
    constructor() {
        super({
            name: 'AI帮助',
            dsc: '显示AI插件帮助信息',
            event: 'message',
            priority: 1148,
            rule: [
                { reg: /^#ai帮助$/i, fnc: 'showHelp' },
            ]
        })
    }

    async showHelp(e) {
        const aiName = Config.AI_NAME
        const chatCmd = Config.CHAT_COMMAND
        const drawCmd = Config.DRAW_COMMAND
        const msg1_header = `
你好，欢迎使用 AI 插件
这里是${aiName}，你的多模型智能助手`

        const msg2_chat = `
- - - - - - - - - - - - - - - - -
💬 智能对话 (${aiName})
- - - - - - - - - - - - - - - - -
✨ 三档模型组，随心切换 ✨
> #${chatCmd} [内容]
  使用 Flash 模型组，速度快，适合日常聊天。
> #p${chatCmd} [内容] / #pro${chatCmd} [内容]
  使用 Pro 模型组，更聪明，适合复杂问题。
> #u${chatCmd} [内容] / #ultra${chatCmd} [内容]
  使用 Ultra 模型组，旗舰性能！

> #s${chatCmd} [内容]
  单次对话模式（Flash），不保存历史记录。
> #ps${chatCmd} [内容] / #pros${chatCmd} [内容]
  单次对话模式（Pro），不保存历史记录。
> #us${chatCmd} [内容] / #ultras${chatCmd} [内容]
  单次对话模式（Ultra），不保存历史记录。

> 💡 所有对话指令都支持发送图片哦！
  > 示例: #${chatCmd} 你好呀！
  > 示例: #p${chatCmd} 这张图里是什么？ [图片]

> 🌐 临时功能开关（默认关闭，按需启用）
> #${chatCmd}v [内容]
  临时启用图文转述（Vision Relay），强制用 Vision 模型描述图片。
> #${chatCmd}n [内容]
  临时启用联网搜索，AI 自动判断是否搜索并注入结果。
> #${chatCmd}w [URL]
  临时启用网页抓取，自动提取消息中的 URL 并抓取网页内容。
> #${chatCmd}f [路径]
  临时启用本地文件读取，强制读取指定路径的文件/目录内容。
  目录会递归读取所有子目录（跳过 .git 和 node_modules）。
> 开关可组合，如 #pv${chatCmd}、#us${chatCmd}n、#s${chatCmd}wf、#${chatCmd}vnwf 等。

> #导出${aiName}记忆
  导出该用户的对话记忆。
> #导出${aiName}记忆 [日期]
  导出指定日期的记忆。
  例如：#导出${aiName}记忆 2025-05-05`

        const msg3_drawing = `
- - - - - - - - - - - - - - - - -
🎨 创意作图工坊
- - - - - - - - - - - - - - - - -
✨ 三档模型组，随心切换 ✨

--- 预设作图 ---
> #画图预设列表
  查看所有可用指令，如 #手办化, #二次元化 等。
> 💡 在指令前加模型组前缀切换模型：
  #手办化        → Flash 模型组
  #p手办化       → Pro 模型组
  #u手办化       → Ultra 模型组
> 示例: #二次元 帮我画一只猫

--- 自定义作图 ---
> #${drawCmd} [...]
  使用 Flash 模型组，性价比高。
> #p${drawCmd} [...] / #pro${drawCmd} [...]
  使用 Pro 模型组。
> #u${drawCmd} [...] / #ultra${drawCmd} [...]
  使用 Ultra 模型组，效果更佳！
  > 示例: #u${drawCmd} 一个女孩在星空下看书

--- 预设管理 (主人专用) ---
> #画图预设列表pro
  查看详细预设列表（含Prompt内容）
> #画图预设重载
  重载预设配置
> #画图预设添加 [指令] [名称]
  添加新预设
> #画图预设删除 [指令]
  删除预设
> #添加预设别名 [指令]
  为预设添加别名
> #删除预设别名 [指令]
  删除预设别名`

        const msg4_memory = `
- - - - - - - - - - - - - - - - -
📚 记忆归档与总结
- - - - - - - - - - - - - - - - -
> #ai记忆列表
  查看你的"人生档案"目录。
  (☁️=未总结, 🔗=增量总结, 💾=全量总结, 📝=今日记录)
> #ai读取记忆 [日期]
  读取指定日期的记忆记录（优先全量总结）。
  例如：#ai读取记忆 2025-05-05
> #ai读取全量总结 [日期]
  读取指定日期的全量总结。
  例如：#ai读取全量总结 2025-05-05
> #ai读取增量总结 [日期]
  读取指定日期的增量总结。
  例如：#ai读取增量总结 2025-05-05
> #ai增量总结
  [接力模式] 基于上一个总结的接力存档。
  读取【上一个总结】+【新增日期的摘要】，生成最新的记忆存档。
  ✨ 速度极快，Token消耗低，适合日常使用。
  ⏰ 每8轮对话自动触发 + 每天23:50定时覆盖。
> #ai增量总结 [日期]
  为指定日期创建增量总结。
  例如：#ai增量总结 2026-05-05
  适合补做过去遗漏的某一天总结。
> #ai全量总结
  [里程碑模式] 包含所有核心记忆的完整存档。
  忽略旧存档，强制从第一天开始重新阅读所有摘要。
  📦 支持分块总结（128条/块）+ 合并，避免超长上下文失败。
  🐢 消耗较高，适合每隔一段时间进行一次"记忆净化"。
> #ai批量增量总结
  [批量处理] 将所有"未总结"的日期逐个处理为增量总结。
  适合清理历史积压的未总结日期。
> 💡 总结命令也支持模型组前缀：
  #pai全量总结 → Pro 模型组
  #uai增量总结 2026-05-05 → Ultra 模型组`

        const msg5_master = `
- - - - - - - - - - - - - - - - -
🔑 主人专用指令
- - - - - - - - - - - - - - - - -
【 模型管理 】
> #ai模型列表
  查看当前所有模型配置及状态。
> #ai模型测试
  测试所有模型的连通性和响应时间。
> #ai启用全部模型
  启用配置文件中的所有模型。
> #ai禁用 [模型ID]
  禁用指定模型。
> #ai启用 [模型ID]
  启用已禁用的模型。

【 权限管理 】
> #ai权限列表
  查看当前权限配置详情。
> #ai权限模式 whitelist/blacklist
  切换权限模式（白名单/黑名单）。
> #ai权限添加/删除 白名单用户 [用户ID]
> #ai权限添加/删除 黑名单用户 [用户ID]
> #ai权限添加/删除 白名单群 [群号]
> #ai权限添加/删除 黑名单群 [群号]

【 聊天环境管理 】
> #ai信任群添加 [群号]
  将指定群聊添加到信任列表，该群内AI可更自由交流。
> #ai信任群删除 [群号]
  从信任列表移除指定群聊。
> #ai信任群列表
  查看当前所有信任的群聊。

【 其他 】
> #ai状态
  查看插件运行状态。
> #ai思考开启/关闭
  切换是否显示AI的思考过程。
> #ai插件更新
  检查并更新插件（git pull）。
> #ai插件强制更新
  强制更新插件（git reset + pull）。
> #导出${aiName}全部记忆
  导出所有用户的对话记忆。
> #导出${aiName}全部记忆 [日期]
  导出指定日期所有用户的记忆。
  例如：#导出${aiName}全部记忆 2025-05-05`

        const msg6_tips = `
- - - - - - - - - - - - - - - - -
💡 使用小贴士
- - - - - - - - - - - - - - - - -
> 📷 图片支持
  所有对话指令都支持发送图片，支持引用消息、合并转发展开。
> 🌐 临时开关
  默认关闭联网搜索、网页抓取和文件读取，避免无意义的 Token 消耗。
  需要时添加 v (Vision)、n (Net)、w (Web)、f (File) 开关临时启用：
  #cv 你好 → 启用图文转述
  #cn 查天气 → 启用联网搜索
  #cf /root/Yunzai/plugins/AI-Plugin → 读取本地文件/目录
  #cvn 这是个啥 → 同时启用两者

> 🎨 作图技巧
  - 预设命令加模型组前缀切换模型（#p手办化 / #u手办化）
  - 使用 @某人 可获取其头像进行作图
  - 支持多张图片同时输入（最多100张，含引用/回复/合并转发中的所有图片）

> 🧠 记忆小贴士
  - 每8轮对话自动触发增量总结 + 每天23:50定时覆盖
  - 增量总结 = 快速存档，消耗低，推荐日常使用
  - 全量总结 = 完整重玩，支持分块合并，适合定期整理记忆

> 📊 Token 统计
  - 对话回复底部显示 Token 消耗与耗时
  - 全量/增量总结在日志中记录 Token 消耗详情`

        const forwardMsgArr = [
            msg1_header,
            msg2_chat,
            msg3_drawing,
            msg4_memory,
            msg5_master,
            msg6_tips
        ]

        try {
            const forwardMsg = await Bot.makeForwardMsg(forwardMsgArr.map(msg => ({
                user_id: Bot.uin,
                nickname: `${aiName}AI助手`,
                message: msg.trim()
            })))
            await e.reply(forwardMsg, false)
        } catch (error) {
            logger.error('[AI-Plugin] 创建帮助列表合并转发消息失败:', error)
            await e.reply("❌ 帮助信息发送失败，请稍后重试")
        }
    }
}
