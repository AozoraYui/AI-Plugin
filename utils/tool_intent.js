const DELEGATE_WORDS = '(?:帮我|替我|代我|帮忙|麻烦你?|拜托你?|请你?|劳烦你?)'
const SEND_VERBS = '(?:说(?:一下|一声|一句)?|发(?:一下|一条|一句|个消息|消息)?|发送|代发|转达)'
const TARGET_SUFFIX = '(?:群聊|群里|群内|群|那边|里面|里)?'
const BOT_CALL_PREFIX = '(?:(?:诺亚|noa|喏亚|诺娅)[,，。!！~～\\s]*)?'

export function getPrimaryUserInstruction(text) {
    const value = String(text || '').trim()
    if (!value) return ''
    const index = value.search(/\n===\s*引用/)
    return (index >= 0 ? value.slice(0, index) : value).trim()
}

function cleanTarget(target = '') {
    return String(target || '')
        .trim()
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        .replace(/(?:群聊|群里|群内|那边|里面|里|群)$/i, '')
        .trim()
}

function isTargetSafe(target = '') {
    const value = cleanTarget(target)
    if (!value) return false
    if (/^(?:我|你|他|她|它|ta|大家|他们|她们|某个|某群|那个|这个|这|那|刚才那个|上面那个)$/i.test(value)) return false
    return true
}

function isMessageSafe(message = '') {
    const value = String(message || '').trim()
    if (!value) return false
    if (/^(?:了)?(?:什么|啥|哪些|什么事|什么内容|了什么|了啥|过什么|过啥|什么情况|啥情况|多少|几)(?:[?？。！!，,\s]|$)/i.test(value)) return false
    if (/^(?:吗|呢|么|嘛|不|有没有|能不能|可不可以)(?:[?？。！!，,\s]|$)/i.test(value)) return false
    return true
}

function hasExplicitDelegation(fullText = '', verb = '') {
    return new RegExp(DELEGATE_WORDS, 'i').test(fullText) || /(?:代发|转达)/i.test(verb)
}

export function parseGroupSendRequest(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return null

    const patterns = [
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?:在|去|到|往)\\s*(?<target>[^，,。；;：:\\n]{1,60}?)${TARGET_SUFFIX}\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000})$`, 'i'),
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000}?)\\s*(?:到|去|在|给)\\s*(?<target>[^，,。；;：:\\n]{1,60}?)${TARGET_SUFFIX}$`, 'i')
    ]

    for (const pattern of patterns) {
        const match = value.match(pattern)
        const target = match?.groups?.target?.trim()
        const message = match?.groups?.message?.trim()
        const verb = match?.groups?.verb || ''
        if (!target || !message) continue
        const hasDirectionalSend = /(?:^|[，,。；;\s])(?:在|去|到|往)\s*[^，,。；;：:\n]{1,60}/i.test(value)
            || new RegExp(`${SEND_VERBS}[\\s\\S]{1,1000}?(?:到|去|在|给)\\s*[^，,。；;：:\\n]{1,60}`, 'i').test(value)
        if (!hasExplicitDelegation(value, verb) && !hasDirectionalSend) continue
        if (!isTargetSafe(target) || !isMessageSafe(message)) continue

        const args = { target: cleanTarget(target), message }
        if (/^\d{5,}$/.test(args.target)) {
            args.group_id = args.target
            delete args.target
        }
        if (/(?:原样发送|原文发送|不要前缀|不加前缀|直接发原文|直接发送原文)/i.test(value)) args.as_is = true
        return args
    }
    return null
}

export function isExplicitGroupSendRequest(text) {
    return Boolean(parseGroupSendRequest(text))
}

export function hasNegatedDrawIntent(text) {
    const value = String(text || '')
    return /(?:不是|并不是|不是要|不是让你|别|不要|不用|无需|别给我|别再|别急着|先别).{0,18}(?:画图|画画|画|绘制|生成图|生成图片|作图|做图|创作图片)/i.test(value)
}

function isQuestionAboutTool(text = '', keywordPattern = '') {
    const value = String(text || '')
    if (!keywordPattern) return false
    return new RegExp(`(?:什么是|是什么意思|为啥|为什么|怎么|如何|教程|会不会|能不能).{0,40}(?:${keywordPattern})|(?:${keywordPattern}).{0,30}(?:是什么|什么意思|吗|嘛|么|？|\\?)`, 'i').test(value)
}

export function hasExplicitDrawIntent(text, options = {}) {
    const value = getPrimaryUserInstruction(text)
    if (!value || hasNegatedDrawIntent(value)) return false
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|会|能不能|可以|能).{0,16}(?:画|绘制).{0,40}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦)/i.test(value)) {
        return false
    }
    if (isQuestionAboutTool(value, '画图|画画|绘图|生图|作图|做图')) {
        if (!/(?:帮我|给我|请|麻烦).{0,12}(?:画|绘制|生成|创作|做)/i.test(value)) return false
    }

    const hasImageContext = options.hasImages === true || options.hasRecentImages === true
    const generationIntent = /(?:帮我|给我|请|麻烦你?)?\s*(?:画|绘制|生成|创作|做)(?:个|一张|一下|张)?[\s\S]{0,100}(?:图|图片|画|插画|头像|壁纸|表情包|设定图|立绘|你自己|你本人|AI本人|自画像|你长什么样|你的样子|诺亚|noa)/i.test(value)
        || /(?:帮我|给我|请|麻烦你?)?\s*(?:画|绘制)(?:个|一张|一下|张)?\s*[\s\S]{1,80}$/i.test(value)
        || /(?:看看|给我看看)(?:你长什么样|你的样子)/i.test(value)
    const imageEditIntent = hasImageContext
        && /(?:去掉|去除|移除|擦除|消除|抹掉|清理|删掉|去水印|水印|二维码|改成|变成|转成|风格化|手办化|inpaint|inpainting|修图|处理图片|p图|P图)/i.test(value)
        && /(?:图片|照片|图|原图|参考图|这张|那张|刚才|刚刚|水印|二维码|手办化|风格化|修图|p图|P图)/i.test(value)
    return generationIntent || imageEditIntent
}

export function hasExplicitWebSearchIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    return /(?:搜索|搜一下|查一下|查询|联网|上网|最新|新闻|官网|资料|百科|价格|汇率|实时|今天|明天|现在).{0,80}/i.test(value)
        || /(?:帮我|给我|请|麻烦).{0,12}(?:搜|查|检索)/i.test(value)
}

export function hasExplicitWebFetchIntent(text, candidateUrls = []) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const hasUrl = extractUrls(value).length > 0 || (Array.isArray(candidateUrls) && candidateUrls.length > 0)
    return hasUrl && (/(?:看|看看|打开|读取|抓取|总结|分析|解释|概括).{0,20}(?:链接|网页|网址|页面|内容|这个|这条|上面)/i.test(value)
        || /(?:这个|这条|上面).{0,8}(?:链接|网页|网址).{0,12}(?:讲|说|内容|总结|看看|分析)/i.test(value)
        || /^(?:帮我|给我|请|麻烦你?)?\s*(?:看|看看|看一下|打开|读取|抓取|总结|总结一下|概括|分析|解释)(?:一下|下)?[。！!？?\s]*$/i.test(value))
}

export function hasExplicitFileDownloadIntent(text, options = {}) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const hasImages = options.hasImages === true
    const mediaWords = '(?:图片|照片|图|视频|语音|文件|这些|这个|引用|消息|媒体)'
    const actionWords = '(?:下载|保存|存储|存到|下载到|保存到|存起来)'
    return new RegExp(`${actionWords}.{0,30}${mediaWords}|${mediaWords}.{0,30}${actionWords}`, 'i').test(value)
        || (hasImages && /(?:下载|保存|存储|存到|下载到|保存到|存起来)/i.test(value))
}

export function hasExplicitFileSendIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const sendIntent = /(?:发给我|发我|发送|发出来|发到(?:群里|这里)?|传给我|上传到(?:群里|这里)?)/i.test(value)
    const targetHint = /\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)\b|[\w.-]+\.(?:png|jpe?g|webp|gif|mp4|mov|avi|mkv|mp3|wav|ogg|flac|zip|7z|rar|gz|pdf|txt|log|md|json|ya?ml|js|ts|db|sqlite|bin)\b|(?:日志|配置|脚本|文件|目录|压缩包|这个|刚才|上面)/i.test(value)
    return sendIntent && targetHint
}

export function hasExplicitGroupChatContextIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false

    if (/(加了哪些群|加入了哪些群|在哪些群|能看到哪些群|可见群|群列表|所有群列表|有哪些群|有什么群|机器人.*群|你.*群)/i.test(value)) return true
    if (/(我|俺|咱).{0,18}(别的群|其他群|其它群|别群|跨群).{0,24}(发|说|聊|消息|看到|看见|记录|记得|知道)/i.test(value)) return true
    if (/(别的群|其他群|其它群|别群|跨群).{0,18}(我|俺|咱).{0,24}(发|说|聊|消息|看到|看见|记录|记得|知道)/i.test(value)) return true

    const action = '(?:读取|读一下|查看|看看|查询|查一下|检索|搜索|拉一下|调出|翻一下|总结|整理|回顾|概括)'
    const object = '(?:群聊|群消息|聊天记录|群聊记录|消息记录|消息流水|畅聊记录|群上下文|聊天上下文|前情|所有群|全部群|其他群|其它群|别的群|跨群)'
    return new RegExp(`${action}.{0,20}${object}|${object}.{0,20}${action}`, 'i').test(value)
}

export function hasExplicitShellIntent(text, toolName = '') {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|会|能不能|可以|能).{0,16}(?:执行|运行|调用).{0,16}(?:shell|命令|终端|命令行).{0,20}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦)/i.test(value)) {
        return false
    }
    const commandKeywords = 'git|npm|pnpm|node|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip|tmux|shell|命令|终端'
    if (isQuestionAboutTool(value, commandKeywords)
        && !/(?:帮我|给我|请|麻烦|执行|运行|调用|用|拿|通过).{0,20}(?:git|npm|pnpm|node|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip|tmux|shell|命令|终端)/i.test(value)) {
        return false
    }
    if (toolName === 'shell_session' && /(?:tmux|ai-shell|shell\s*session|shell会话|shell窗口|独立shell|终端会话)/i.test(value)) return true
    if (/(?:执行|运行|调用).{0,12}(?:shell|命令|终端|命令行|脚本)|(?:shell|命令)[:：]/i.test(value)) return true
    if (/(?:执行|运行|调用).{0,8}(?:git|npm|pnpm|node|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip)\b/i.test(value)) return true
    if (/^(?:sudo\s+)?(?:git|npm|pnpm|node|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip)\b/i.test(value)) return true
    if (/\b(?:git\s+(?:pull|status|diff|log|show|fetch)|tmux\s+ls|nmap\s+-|ip\s+(?:route|addr)|pnpm\s+|npm\s+|node\s+|docker\s+|systemctl\s+)/i.test(value)) return true
    if (/(?:用|拿|通过).{0,8}(?:nmap|git|npm|pnpm|node|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|ip).{0,8}(?:命令|工具)/i.test(value)) return true
    if (/(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看).{0,16}(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机)/i.test(value)) return true
    if (/(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机).{0,16}(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看)/i.test(value)) return true
    return false
}

export function hasExplicitGroupAdminIntent(toolName, text) {
    const value = getPrimaryUserInstruction(text)
    const patterns = {
        group_mute: /(禁言|解禁|闭嘴|解除.{0,8}禁言)/i,
        group_whole_mute: /(全员禁言|全体禁言|全群禁言|解除.{0,8}全员禁言|关闭.{0,8}全员禁言)/i,
        group_kick: /(踢出|踢了|踢人|移出群|移出.{0,8}群聊|拉黑)/i,
        group_set_card: /(群名片|群昵称|改名片|改.{0,8}昵称|设置.{0,8}名片)/i,
        group_set_title: /(头衔|专属头衔|设置.{0,8}头衔|取消.{0,8}头衔)/i,
        group_essence: /(精华|加精|设为精华|取消精华)/i,
        group_request_handle: /(通过|同意|批准|允许|拒绝|放.{0,16}进来|让.{0,16}进来|准.{0,8}进).{0,24}(申请|入群|进群|加群|进来)?|(?:申请|入群|进群|加群).{0,24}(通过|同意|批准|允许|拒绝)/i
    }
    const pattern = patterns[toolName]
    return pattern ? pattern.test(value) : true
}

function extractUrls(text) {
    return String(text || '').match(/https?:\/\/[^\s<>'"，。！？、]+/gi) || []
}

export function isExplicitToolIntent(toolName, text, options = {}) {
    switch (toolName) {
        case 'group_send_message':
            return isExplicitGroupSendRequest(text)
        case 'draw_image':
            return hasExplicitDrawIntent(text, options)
        case 'shell_exec':
        case 'shell_session':
            return hasExplicitShellIntent(text, toolName)
        case 'file_download':
            return hasExplicitFileDownloadIntent(text, options)
        case 'file_send':
            return hasExplicitFileSendIntent(text)
        case 'web_fetch':
            return hasExplicitWebFetchIntent(text, options.candidateUrls || [])
        case 'web_search':
            return options.strictWebSearch === true ? hasExplicitWebSearchIntent(text) : true
        case 'group_chat_context':
            return hasExplicitGroupChatContextIntent(text)
        case 'group_mute':
        case 'group_whole_mute':
        case 'group_kick':
        case 'group_set_card':
        case 'group_set_title':
        case 'group_essence':
        case 'group_request_handle':
            return hasExplicitGroupAdminIntent(toolName, text)
        default:
            return true
    }
}

export function filterToolCallsByIntent(toolCalls = [], text = '', options = {}) {
    const filtered = []
    const blocked = []
    const instruction = getPrimaryUserInstruction(text)
    for (const call of toolCalls || []) {
        if (!call?.name) continue
        if (!isExplicitToolIntent(call.name, instruction, options)) {
            blocked.push(call)
            continue
        }
        filtered.push(call)
    }
    return { tools: filtered, blocked }
}
