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
                { reg: /^#(gemini|ai)帮助$/i, fnc: 'showHelp' },
            ]
        })
    }

    async showHelp(e) {
        const aiName = Config.AI_NAME
        const msg1_header = `
喵~ 欢迎使用~
这里是${aiName}的万能口袋哦~ (ฅ'ω'ฅ)`

        const msg2_chat = `
- - - - - - - - - - - - - - - - -
💬 智能对话 (${aiName})
- - - - - - - - - - - - - - - - -
✨ 三档模型，随心切换 ✨
> #gm [内容]
  使用默认 Flash 模型，速度快，适合日常聊天。
> #progm [内容]
  启用 Pro 模型，更聪明，适合复杂问题 (#Progm 也可以哦)。
> #3gm [内容]
  召唤 Gemini 3 旗舰模型，性能最强！

> #sgm [内容] / #singlegm [内容]
  单次对话模式，不保存历史记录。

> 💡 所有对话指令都支持发送图片哦！
  > 示例: #gm 你好呀！
  > 示例: #progm 这张图里是什么？ [图片]

> #导出${aiName}记忆
  导出该用户的对话记忆。`

        const msg3_drawing = `
- - - - - - - - - - - - - - - - -
🎨 创意作图工坊
- - - - - - - - - - - - - - - - -
✨ 绘图分为「默认」和「Gemini 3」两档 ✨

--- 预设作图 ---
> #画图预设列表
  查看所有可用指令，如 #手办化, #二次元化 等。
> 💡 在指令前加 "3" 可调用旗舰模型 (例如: #3手办化)。
> 示例: #二次元 帮我画一只猫

--- 自定义作图 ---
> #bnn [...]
  使用默认 Flash 模型，性价比高。
> #3bnn [...]
  使用 Gemini 3 旗舰绘图模型，效果更佳！
  > 示例: #3bnn 一个女孩在星空下看书

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
> #gemini总结记忆列表
  查看你的"人生档案"目录。
  (☁️=未读, ✅=已生成摘要缓存, 📝=今日记录)
> #gemini创建增量锚点
  [接力模式] 类似于游戏的"快速存档"。
  读取【上一个锚点】+【新增日期的摘要】，生成最新的记忆存档。
  ✨ 速度极快，Token消耗低，适合日常使用。
> #gemini创建全量锚点
  [二周目模式] 类似于游戏的"完整重玩"。
  忽略旧存档，强制从第一天开始重新阅读所有摘要。
  🐢 消耗较高，适合每隔几个月进行一次"记忆净化"。
> 💡 锚点命令也支持模型前缀 (如 #3gemini创建全量锚点)`

        const msg5_master = `
- - - - - - - - - - - - - - - - -
🔑 主人专用指令
- - - - - - - - - - - - - - - - -
【 模型管理 】
> #gemini模型列表
  查看当前所有模型配置及状态。
> #gemini模型测试
  测试所有模型的连通性和响应时间。
> #gemini启用全部模型
  启用配置文件中的所有模型。
> #gemini禁用 [模型ID]
  禁用指定模型。
> #gemini启用 [模型ID]
  启用已禁用的模型。

【 权限管理 】
> #gemini权限列表
  查看当前权限配置详情。
> #gemini权限模式 whitelist/blacklist
  切换权限模式（白名单/黑名单）。
> #gemini权限添加/删除 白名单用户 [用户ID]
> #gemini权限添加/删除 黑名单用户 [用户ID]
> #gemini权限添加/删除 白名单群 [群号]
> #gemini权限添加/删除 黑名单群 [群号]

【 其他 】
> #gemini状态
  查看插件运行状态。
> #gemini思考开启/关闭
  切换是否显示AI的思考过程。
> #导出${aiName}全部记忆
  导出所有用户的对话记忆。`

        const msg6_tips = `
- - - - - - - - - - - - - - - - -
💡 使用小贴士
- - - - - - - - - - - - - - - - -
> 📷 图片支持
  所有对话指令都支持发送图片，支持引用消息、合并转发展开。

> 🎨 作图技巧
  - 在预设指令前加 "3" 调用 Gemini 3 模型
  - 使用 @某人 可获取其头像进行作图
  - 支持多张图片同时输入（最多16张）

> 🧠 记忆小贴士
  - 每天 23:50 会自动生成当日摘要
  - 增量锚点 = 快速存档，消耗低，推荐日常使用
  - 全量锚点 = 完整重玩，消耗高，适合定期整理记忆`

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
