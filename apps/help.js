import plugin from '../../../lib/plugins/plugin.js'

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
        const msg1_header = `
喵~ 欢迎使用~
这里是诺亚的万能口袋哦~ (ฅ'ω'ฅ)`

        const msg2_chat = `
- - - - - - - - - - - - - - - - -
💬 智能对话 (诺亚)
- - - - - - - - - - - - - - - - -
✨ 三档模型，随心切换 ✨
> #gm [内容]
  使用默认 Flash 模型，速度快，适合日常聊天。
> #progm [内容]
  启用 Pro 模型，更聪明，适合复杂问题 (#Progm 也可以哦)。
> #3gm [内容]
  召唤 Gemini 3 旗舰模型，性能最强！

> 💡 所有对话指令都支持发送图片哦！
  > 示例: #gm 你好呀！
  > 示例: #progm 这张图里是什么？ [图片]

> #结束gemini对话
  清空你和诺亚的短期对话记忆，开始新话题。`

        const msg3_drawing = `
- - - - - - - - - - - - - - - - -
🎨 创意作图工坊
- - - - - - - - - - - - - - - - -
✨ 绘图分为「默认」和「Gemini 3」两档 ✨

--- 预设作图 ---
> #画图预设列表
  查看所有可用指令，如 #手办化, #二次元化 等。
> 💡 在指令前加 "3" 可调用旗舰模型 (例如: #3手办化)。

--- 自定义作图 ---
> #bnn [...]
  使用默认 Flash 模型，性价比高。
> #3bnn [...]
  使用 Gemini 3 旗舰绘图模型，效果更佳！
  > 示例: #3bnn 一个女孩在星空下看书

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
  🐢 消耗较高，适合每隔几个月进行一次"记忆净化"。`

        const msg5_master = `
- - - - - - - - - - - - - - - - -
🔑 主人专用指令
- - - - - - - - - - - - - - - - -
【 模型与权限 (主人专用) 】
> #gemini模型测试
  测试所有模型的连通性和响应时间。
> #gemini模型全部启用
  启用所有模型
> #gemini模型禁用 [模型ID]
  禁用指定模型
> #gemini模型启用 [模型ID]
  启用指定模型
> #gemini重载
  重载插件配置
> #gemini设置白名单
  切换到白名单模式
> #gemini设置黑名单
  切换到黑名单模式
> #gemini添加/删除白名单用户 [用户ID]
> #gemini添加/删除白名单群 [群号]
> #gemini添加/删除黑名单用户 [用户ID]
> #gemini添加/删除黑名单群 [群号]
> #gemini查看权限配置
  查看当前权限配置
> #gemini思考开启/关闭
  切换是否显示AI的思考过程
> #导出诺亚全部记忆
  导出所有用户的对话记忆`

        const forwardMsgArr = [
            msg1_header,
            msg2_chat,
            msg3_drawing,
            msg4_memory,
            msg5_master
        ]

        try {
            const forwardMsg = await Bot.makeForwardMsg(forwardMsgArr.map(msg => ({
                user_id: Bot.uin,
                nickname: "诺亚AI助手",
                message: msg.trim()
            })))
            await e.reply(forwardMsg, false)
        } catch (error) {
            logger.error('[AI-Plugin] 创建帮助列表合并转发消息失败:', error)
            const helpMsg = `
🤖 诺亚AI助手 使用帮助

📝 对话功能:
  #gm [内容] - 与诺亚对话
  #progm [内容] - 使用Pro模型对话
  #3gm [内容] - 使用Gemini3模型对话
  #结束gemini对话 - 重置对话历史
  #导出诺亚记忆 - 导出你的对话记忆
  #导出诺亚全部记忆 - 导出所有用户记忆(管理员)

🎨 作图功能:
  #bnn [内容] - 自定义作图
  #3bnn [内容] - 使用Gemini3模型作图
  #画图预设列表 - 查看作图预设列表
  #画图预设列表pro - 查看详细预设列表
  #画图预设重载 - 重载预设配置
  #画图预设添加 [指令] [名称] - 添加新预设
  #画图预设删除 [指令] - 删除预设
  #添加预设别名 [指令] - 为预设添加别名
  #删除预设别名 [指令] - 删除预设别名

📚 记忆管理:
  #gemini创建全量锚点 - 创建完整记忆锚点
  #gemini创建增量锚点 - 创建增量记忆锚点
  #gemini总结记忆列表 - 查看记忆总结列表

⚙️ 管理功能(管理员):
  #gemini模型列表 - 查看当前模型配置
  #gemini模型测试 - 测试所有模型
  #gemini模型全部启用 - 启用所有模型
  #gemini模型禁用[模型ID] - 禁用指定模型
  #gemini模型启用[模型ID] - 启用指定模型
  #gemini禁用列表 - 查看已禁用的模型
  #gemini状态 - 查看插件运行状态
  #gemini重载 - 重载插件配置
  #gemini设置白名单 - 切换到白名单模式
  #gemini设置黑名单 - 切换到黑名单模式
  #gemini添加/删除白名单用户[用户ID]
  #gemini添加/删除白名单群[群号]
  #gemini添加/删除黑名单用户[用户ID]
  #gemini添加/删除黑名单群[群号]
  #gemini查看权限配置 - 查看当前权限配置
  #gemini思考开启/关闭 - 开启/关闭思考过程显示

💡 提示:
  - 回复图片消息或附带图片进行对话
  - 使用@某人可以获取其头像进行作图
  - 支持合并转发消息展开
            `.trim()
            await e.reply(helpMsg)
        }
    }
}
