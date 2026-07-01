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
        const noaAutoImageLimit = Config.NOA_CHAT_AUTO_READ_IMAGE_LIMIT
        const noaMaxImages = Config.NOA_CHAT_MAX_CONTEXT_IMAGES
        const noaMaxImagesText = noaMaxImages === Infinity ? '不限制' : `${noaMaxImages} 张图`
        const noaImageBatchSize = Config.NOA_CHAT_IMAGE_BATCH_SIZE
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

> 🏷️ 数字前缀临时指定供应商
  在 # 后直接加数字（1-9），临时使用对应优先级的供应商。
  格式: #[数字][模型组前缀][命令] [内容]
  > 示例: #3${chatCmd} 你好 → 使用 priority=3 的供应商
  > 示例: #3p${chatCmd} 复杂问题 → priority=3 + Pro 模型组
  > 示例: #3s${chatCmd} 临时提问 → priority=3 + 单次对话

> 💡 所有对话指令都支持发送图片哦！
  > 示例: #${chatCmd} 你好呀！
  > 示例: #p${chatCmd} 这张图里是什么？ [图片]

> 🌐 临时功能开关（默认关闭，按需启用）
> #${chatCmd}v [内容]
  临时启用图文转述（Vision Relay），强制用 Vision 模型描述图片。
  全局开启后，仅当前模型组/指定供应商没有可用多模态模型时自动启用；有图请求会优先使用多模态模型。
> #${chatCmd}n [内容]
  临时启用联网搜索，AI 自动判断是否搜索并注入结果。
> #${chatCmd}w [URL]
  临时启用网页抓取，自动提取消息中的 URL 并抓取网页内容。
> #${chatCmd}f [路径]
  临时启用本地文件读取，强制读取指定路径的文件/目录内容。
  支持“日志/配置/模型配置/插件目录/data目录”等别名、相对路径、文件名片段和“上次那个目录”。
  目录会递归读取所有子目录（跳过 .git 和 node_modules）。
> 🖥️ Shell 执行（主人专用）
  需在 models_config.yaml 开启 enable_shell_exec: true（独立开关，无需 enable_file_read）。
  开启后 AI 可根据你的意图执行服务器 Shell 命令，例如 grep/rg 查文件、查看日志、诊断服务状态。
  注意：Shell 具备完整服务器权限，不会被 #f 临时开关单独启用。
> 🖥️ 持久 Shell 会话（主人专用）
  需在 models_config.yaml 开启 enable_shell_session: true（独立开关）。
  开启后使用 tmux 会话 ai-shell；机器人启动时若不存在会自动创建。
  明确说“在 ai-shell 执行...”“看看 shell会话输出”“中断 tmux”时触发。
  发送命令后最多等待 64 秒直到窗口出现新输出，再把窗口快照交给 AI。
  执行会改动状态的命令前会检查目录语义；目录不对会停止执行并反问你下一步。
> 📤 文件收发（主人专用）
  需在 models_config.yaml 开启 enable_file_transfer: true（独立开关）。
  上传：让 AI 把白名单目录内的文件/文件夹发到当前会话（文件夹自动打包为 tar.gz）。
  下载：让 AI 把当前消息或引用消息里的图片/视频/语音/文件保存到白名单目录。
  群文件：让 AI 浏览当前群的群文件区，或按文件名把群文件下载到白名单目录（仅群聊）。
  路径受 file_roots.yaml 白名单约束，仅主人可用。
> 🗣️ 代发群消息（主人专用）
  需在 models_config.yaml 开启 enable_group_send: true（独立开关），也可用 #ai开启代发 / #ai关闭代发 运行时切换。
  可让 AI 代你向指定群发送纯文本，例如“帮我在测试群说一下今晚不测了”。
  目标群必须唯一，默认会加“【主人转达】”前缀；不支持 CQ 码。
> 🎨 AI 对话画图
  需在 models_config.yaml 开启 enable_ai_draw: true（独立开关）。
  开启后所有人可在对话中用自然语言让 AI 画图（等同 #draw）。
  支持参考图（带图/引用图/@成员头像）与预设风格名，生成图直接发送到会话。
> 🛡️ 群管理（主人/群管理员）
  需在 models_config.yaml 开启 enable_group_admin: true（独立开关）。
  群聊中由主人或当前群管理员/群主用自然语言触发：禁言/解禁、全员禁言、踢人（可拉黑）、
  改群名片、设专属头衔、精华消息、入群审核（查看/通过/拒绝加群申请）。
  前提：机器人需为该群管理员（设头衔需群主）。
> 💬 畅聊模式（主人开关）
  #ai开启畅聊 / #ai关闭畅聊
  开启后群消息会被捕获；有人在当前消息里提到诺亚/noa 或 @机器人时，AI 会基于最近群上下文自然接话。
  捕获会覆盖所有非黑名单群；自然回复仍需当前群/用户有访问权限。合并/嵌套合并消息会展开，过长会分段入库。
  畅聊记录会同步到普通对话记忆，并可在安全范围内调用已开启的工具（高危工具仍按权限鉴权）。
  #c 问“他们刚才聊了啥/群里刚刚发生了什么”会自动读取当前群监听流水；跨群/所有群流水仍仅主人可查。
  可询问“我刚在别的群说了什么”来检索自己的跨群消息；主人可查询所有已捕获群流水。
  主人在私聊中也可以问“你加了哪些群/能看到哪些群”，查看机器人可见或已捕获群列表。
  图片只存元信息不存本体；触发消息最多自动读 ${noaAutoImageLimit} 张图，超过阈值默认不读，除非明确要求“读图/看图/分析图片”。
  每轮最多临时读取 ${noaMaxImagesText}；超过 ${noaImageBatchSize} 张会先分批读图摘要再回复。
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
> 🏷️ 数字前缀临时指定供应商
  在指令前加数字（1-9），临时使用对应优先级的供应商。
  格式: #[数字][模型组前缀][命令] [额外描述]
  如 #3手办化、#3p手办化、#3u手办化
> 示例: #3手办化 → Flash + priority=3 的供应商
> 示例: #3p手办化 → Pro + priority=3 的供应商

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
> 💡 自定义作图同样支持数字前缀：如 #3${drawCmd}、#3p${drawCmd}、#3u${drawCmd}

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
  查看当前所有模型配置及状态（基于实际使用数据）。
  标 💰按次 的为按次扣费模型，调度时会尽量避开，按量模型全部不可用时才降级使用。
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
> #ai开启代发 / #ai关闭代发
  切换代发群消息工具（主人专用，高风险跨群发言，默认关闭）。
> #ai开启畅聊 / #ai关闭畅聊
  切换畅聊模式。

【 其他 】
> #ai状态
  查看插件运行状态。
> #ai思考开启/关闭
  切换是否显示AI的思考过程。
> #ai开启思考提示 / #ai关闭思考提示
  切换普通对话是否发送“AI思考中…”占位提示（默认关闭）。
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
  畅聊模式也能临时读图：单条触发消息不超过 ${noaAutoImageLimit} 张图会自动读取，更多图片需明确说“诺亚读图/看图”；多图会按批读取。
> 🌐 临时开关
  默认关闭联网搜索、网页抓取和文件读取，避免无意义的 Token 消耗。
  需要时添加 v (Vision)、n (Net)、w (Web)、f (File) 开关临时启用：
  #cv 你好 → 启用图文转述
  #cn 查天气 → 启用联网搜索
  #cf /root/Yunzai/plugins/AI-Plugin → 读取本地文件/目录
  #cvn 这是个啥 → 同时启用两者
  Shell 执行需 enable_shell_exec 开启（独立开关），且仅主人可用，不会被 #cf 临时启用
  持久 Shell 会话需 enable_shell_session 开启，默认使用 tmux 会话 ai-shell，发送命令后会等待新输出并自动回读快照

> 🎨 作图技巧
  - 预设命令加模型组前缀切换模型（#p手办化 / #u手办化）
  - 使用 @某人 可获取其头像进行作图
  - 支持多张图片同时输入（最多100张，含引用/回复/合并转发中的所有图片）
  - chat/completions 不支持图片时会自动重试 /images/edits（保留参考图）

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
