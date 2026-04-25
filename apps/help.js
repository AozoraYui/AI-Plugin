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
        const helpMsg = `
🤖 诺亚AI助手 使用帮助

📝 对话功能:
  #gm [内容] - 与诺亚对话
  #progm [内容] - 使用Pro模型对话
  #3gm [内容] - 使用Gemini3模型对话
  #结束gemini对话 - 重置对话历史
  #记住我[信息] - 让诺亚记住你的信息
  #忘记我 - 删除诺亚对你的记忆
  #我是谁 - 查看诺亚对你的记忆
  #导出诺亚记忆 - 导出你的对话记忆
  #导出诺亚全部记忆 - 导出所有用户记忆(管理员)

🎨 作图功能:
  #bnn [内容] - 自定义作图
  #probnn [内容] - 使用Pro模型作图
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
  #gemini模型测试 - 测试所有模型
  #gemini模型全部启用 - 启用所有模型
  #gemini模型禁用[模型ID] - 禁用指定模型
  #gemini模型启用[模型ID] - 启用指定模型
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
