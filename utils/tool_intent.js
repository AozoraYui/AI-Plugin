const DELEGATE_WORDS = '(?:帮我|替我|代我|帮忙|麻烦你?|拜托你?|请你?|劳烦你?)'
const SEND_VERBS = '(?:说(?:一下|一声|一句)?|发(?:一下|一条|一句|个消息|消息)?|发送|群发|代发|转达)'
const TARGET_SUFFIX = '(?:群聊|群里|群内|群|那边|里面|里)?'
const BOT_CALL_PREFIX = '(?:(?:诺亚|noa|喏亚|诺娅)[,，。!！~～\\s]*)?'
const FORBIDDEN_GROUP_SET_PATTERN = /(?:所有|全部|全体|每个|各个|不友好(?:的)?(?:那些|这些)?|有问题(?:的)?(?:那些|这些)?)/i

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
        .replace(/^(?:在|去|到|往|给|从)\s*/i, '')
        .replace(/(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)$/i, '')
        .replace(/(?:群聊|群里|群内|那边|里面|里|群)$/i, '')
        .trim()
}

function isTargetSafe(target = '') {
    const value = cleanTarget(target)
    if (!value) return false
    if (/^(?:我|你|他|她|它|ta|大家|他们|她们|某个|某群|那个|这个|这些|這些|那些|这几个|這几个|那几个|这|那|刚才那个|上面那个)$/i.test(value)) return false
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
    return new RegExp(DELEGATE_WORDS, 'i').test(fullText) || /(?:代发|转达|群发)/i.test(verb)
}

function splitGroupTargets(raw = '') {
    const value = String(raw || '').trim()
    if (!value) return { targets: [], forbidden: false }
    if (FORBIDDEN_GROUP_SET_PATTERN.test(value)) return { targets: [], forbidden: true }

    const normalized = value
        .replace(/(?:群号(?:分别)?是|目标(?:群)?(?:分别)?是|这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|批量)/g, '')
        .replace(/(?:群聊|群)\s*(?:和|与|及|跟|以及)\s*/g, '群、')
        .replace(/[、/|；;，,\n]+/g, '、')
        .replace(/\s+(?:和|与|及|跟|以及)\s+/g, '、')
        .replace(/(?:和|与|及|跟|以及)(?=\d{5,15}\b)/g, '、')
        .replace(/(?<=\d{5,15})(?:和|与|及|跟|以及)/g, '、')
    const numericSpaceSeparated = /^\s*\d{5,15}(?:\s+\d{5,15})+\s*$/.test(normalized)
    const parts = numericSpaceSeparated ? normalized.trim().split(/\s+/) : normalized.split('、')
    const seen = new Set()
    const targets = []
    for (const part of parts) {
        const target = cleanTarget(part)
        if (!target || seen.has(target)) continue
        seen.add(target)
        targets.push(target)
    }
    return { targets, forbidden: false }
}

function assignGroupTargets(args, rawTarget = '') {
    const parsed = splitGroupTargets(rawTarget)
    if (parsed.forbidden) {
        args.forbidden_set = true
        return args
    }
    const safeTargets = parsed.targets.filter(isTargetSafe)
    if (safeTargets.length === 0) return args
    const numeric = safeTargets.filter(target => /^\d{5,15}$/.test(target))
    const named = safeTargets.filter(target => !/^\d{5,15}$/.test(target))
    if (numeric.length + named.length > 1) {
        if (numeric.length) args.group_ids = numeric
        if (named.length) args.targets = named
    } else if (numeric.length === 1) {
        args.group_id = numeric[0]
    } else if (named.length === 1) {
        args.target = named[0]
    }
    return args
}

export function parseGroupSendRequest(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return null

    const explicitListPatterns = [
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?:在|去|到|往|给)?\\s*(?:这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|群号|目标群)\\s*[：:]\\s*(?<target>[\\s\\S]{1,200}?)\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000})$`, 'i'),
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?<verb>${SEND_VERBS})\\s*(?:到|给|在)?\\s*(?:这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|群号|目标群)?\\s*[：:]\\s*(?<target>[\\s\\S]{1,200}?)\\s*(?:内容|消息|说|发|发送)\\s*[：:]\\s*(?<message>[\\s\\S]{1,1000})$`, 'i')
    ]
    for (const pattern of explicitListPatterns) {
        const match = value.match(pattern)
        const target = match?.groups?.target?.trim()
        const message = match?.groups?.message?.trim()
        const verb = match?.groups?.verb || ''
        if (!target || !message) continue
        if (!hasExplicitDelegation(value, verb) && !/(?:群发|代发|转达)/i.test(value)) continue
        if (!isMessageSafe(message)) continue
        const args = assignGroupTargets({ message }, target)
        if (args.forbidden_set || (!args.group_id && !args.target && !args.group_ids && !args.targets)) continue
        if (/(?:原样发送|原文发送|不要前缀|不加前缀|直接发原文|直接发送原文)/i.test(value)) args.as_is = true
        return args
    }

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
        if (!isMessageSafe(message)) continue

        const args = assignGroupTargets({ message }, target)
        if (args.forbidden_set || (!args.group_id && !args.target && !args.group_ids && !args.targets)) continue
        if (/(?:原样发送|原文发送|不要前缀|不加前缀|直接发原文|直接发送原文)/i.test(value)) args.as_is = true
        return args
    }
    return null
}

export function isExplicitGroupSendRequest(text) {
    return Boolean(parseGroupSendRequest(text))
}

export function parseGroupLeaveRequest(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return null
    if (/(?:所有|全部|全体|每个|各个).{0,16}(?:群|退群|退出|离开)|(?:退|退出|离开).{0,16}(?:所有|全部|全体|每个|各个)/i.test(value)) {
        return null
    }

    const currentGroupPattern = /(?:退(?:出)?(?:本群|当前群|这个群|這個群|这群|这里)?|退群|退出(?:本群|当前群|这个群|這個群|这群)?|离开(?:本群|当前群|这个群|這個群|这群)|从(?:本群|当前群|这个群|這個群|这群)退(?:出来|出)?)/i
    const explicitCurrent = /(?:本群|当前群|这个群|這個群|这群|这里|這裡)/i.test(value) && currentGroupPattern.test(value)
    if (explicitCurrent || /^\s*(?:诺亚|noa)?[,，。!！~～\s]*(?:退群|退出群聊|离开群聊)(?:吧|了|啦|呀|啊|喵|捏)?\s*$/i.test(value)) {
        return { target: '当前群' }
    }

    const explicitListMatch = value.match(/(?:退(?:了|掉|出)?|退出|离开|撤出).{0,20}(?:这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|群号|目标群)?\s*[：:]\s*(?<target>[\s\S]{1,200})$/i)
    if (explicitListMatch?.groups?.target) {
        const args = assignGroupTargets({}, explicitListMatch.groups.target)
        if (args.forbidden_set || (!args.group_id && !args.target && !args.group_ids && !args.targets)) return null
        return args
    }

    const patterns = [
        /(?:退(?:了|掉|出)?|退出|离开|撤出)\s*(?<target>[^，,。；;：:\n]{1,80}?)(?:群聊|群里|群内|那边|里面|里|群)?(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)?$/i,
        /(?:把|将|让|叫)?\s*(?<target>[^，,。；;：:\n]{1,80}?)(?:群聊|群里|群内|那边|里面|里|群)?\s*(?:退(?:了|掉|出)?|退出|离开|撤出)(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)?$/i,
        /(?:从)\s*(?<target>[^，,。；;：:\n]{1,80}?)(?:群聊|群里|群内|那边|里面|里|群)?\s*(?:退(?:出来|出)?|退出|离开|撤出)(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)?$/i
    ]
    for (const pattern of patterns) {
        const match = value.match(pattern)
        let target = match?.groups?.target?.trim()
        if (!target) continue
        target = cleanTarget(target)
        if (!target || /^(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)$/i.test(target)) continue
        if (/^(?:群|群聊|这个|这个群|本群|当前群|这里|这边)$/i.test(target)) return { target: '当前群' }
        if (/^(?:它|他|她|ta|那个|那个群|这个|这个群|上面那个|刚才那个|不友好那个)$/i.test(target)) return null
        const args = assignGroupTargets({}, target)
        if (args.forbidden_set || (!args.group_id && !args.target && !args.group_ids && !args.targets)) continue
        return args
    }
    return null
}

export function isExplicitGroupLeaveRequest(text) {
    return Boolean(parseGroupLeaveRequest(text))
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
    return hasUrl && (/\bfetch\b|(?:抓一下|爬一下|扒一下)/i.test(value)
        || /(?:试试|再试试|重试|重新试|换(?:成|用)?这个|用这个|这个呢|这个可以吗|这个能行吗|能打开吗|能抓吗|能不能打开|能不能抓)/i.test(value)
        || /(?:看|看看|打开|读取|抓取|总结|分析|解释|概括).{0,20}(?:链接|网页|网址|页面|内容|这个|这条|上面)/i.test(value)
        || /(?:这个|这条|上面).{0,8}(?:链接|网页|网址).{0,12}(?:讲|说|内容|总结|看看|分析)/i.test(value)
        || /^(?:帮我|给我|请|麻烦你?)?\s*(?:fetch|看|看看|看一下|打开|读取|抓取|抓一下|爬一下|扒一下|总结|总结一下|概括|分析|解释|试试|再试试|重试)(?:一下|下)?[。！!？?\s]*$/i.test(value))
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
    if (hasGroupChatContextQuestion(value)) return true

    const action = '(?:读取|读一下|查看|看看|查询|查一下|检索|搜索|拉一下|调出|翻一下|总结|整理|回顾|概括)'
    const object = '(?:群聊|群消息|聊天记录|群聊记录|消息记录|消息流水|畅聊记录|群上下文|聊天上下文|前情|所有群|全部群|其他群|其它群|别的群|跨群)'
    return new RegExp(`${action}.{0,20}${object}|${object}.{0,20}${action}`, 'i').test(value)
}

export function hasExplicitUserProfileUpdateIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|能不能|可以|能).{0,20}(?:写|更新|维护|记).{0,20}(?:个人档案|用户档案|用户画像|档案|画像|长期记忆).{0,10}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦|现在|直接).{0,16}(?:写|更新|维护|记|提炼)/i.test(value)) {
        return false
    }
    const object = '(?:个人档案|用户档案|用户画像|个人画像|我的档案|我的画像|长期档案|长期记忆|稳定画像)'
    const action = '(?:记到|记进|写到|写进|存到|存进|加入|更新|维护|整理|提炼|抽取|总结)'
    const memoryAction = '(?:记住|记一下|记下来|帮我记|给我记|以后记得|长期记住|别忘了)'
    const personalSignal = '(?:我|我的|叫我|称呼|名字|昵称|喜欢|不喜欢|偏好|习惯|常用|住在|来自|职业|身份|项目|性格|雷点|忌口)'
    return new RegExp(`${action}.{0,24}${object}|${object}.{0,24}${action}`, 'i').test(value)
        || /(?:把|将).{1,120}(?:记到|记进|写到|写进|存到|存进).{0,16}(?:档案|画像|长期记忆)/i.test(value)
        || /(?:从|根据).{0,20}(?:刚才|上面|前面|最近|历史|聊天|对话).{0,30}(?:提炼|抽取|整理|总结).{0,20}(?:档案|画像|长期记忆)/i.test(value)
        || new RegExp(`${memoryAction}.{0,100}${personalSignal}|${personalSignal}.{0,100}${memoryAction}`, 'i').test(value)
}

export function hasGroupChatContextQuestion(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false

    const contextVerbs = '(?:聊(?:了|过)?(?:啥|什么|些啥|些什么)?|在聊(?:啥|什么)|说(?:了|过)?(?:啥|什么|些啥|些什么)?|在说(?:啥|什么)|发(?:了|过)?(?:啥|什么|些啥|些什么)?|发生(?:了)?(?:啥|什么|什么事)?|什么情况|啥情况|咋了|怎么了|在干嘛|在干什么|前情|前情提要|总结|概括|回顾|消息|记录|流水)'
    const timeWords = '(?:刚才|刚刚|之前|前面|最近|这会儿|刚才那会儿|我不在的时候|我没看的时候)'
    const currentGroupWords = '(?:他们|她们|大家|群里|群内|这群|这个群|这里|刚才|刚刚|之前|前面|最近)'
    const crossGroupWords = '(?:所有群|全部群|跨群|各群|别的群|其他群|其它群|别群|那边群|别处群)'

    return new RegExp(`${currentGroupWords}.{0,28}${contextVerbs}|${contextVerbs}.{0,20}(?:${timeWords}|群里|大家|他们|她们)`, 'i').test(value)
        || new RegExp(`${crossGroupWords}.{0,28}${contextVerbs}|${contextVerbs}.{0,20}${crossGroupWords}`, 'i').test(value)
        || /(?:我不在|没看群|漏看).{0,24}(?:聊|说|发|发生|总结|前情)/i.test(value)
}

export function hasExplicitShellIntent(text, toolName = '') {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const commandKeywords = 'git|npm|pnpm|node|python3?|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip|tmux|sqlite3|sqlite|curl|wget|jq|sed|awk'
    const shellKeywords = `${commandKeywords}|shell|命令|终端`
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|会|能不能|可以|能).{0,16}(?:执行|运行|调用).{0,16}(?:shell|命令|终端|命令行).{0,20}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦)/i.test(value)) {
        return false
    }
    if (isQuestionAboutTool(value, shellKeywords)
        && !new RegExp(`(?:帮我|给我|请|麻烦|执行|运行|调用|用|拿|通过).{0,20}(?:${shellKeywords})`, 'i').test(value)) {
        return false
    }
    if (toolName === 'shell_session' && /(?:tmux|ai-shell|shell\s*session|shell会话|shell窗口|独立shell|终端会话)/i.test(value)) return true
    if (/(?:执行|运行|调用).{0,12}(?:shell|命令|终端|命令行|脚本)|(?:shell|命令)[:：]/i.test(value)) return true
    if (new RegExp(`(?:执行|运行|调用).{0,8}(?:${commandKeywords})\\b`, 'i').test(value)) return true
    if (new RegExp(`^(?:sudo\\s+)?(?:${commandKeywords})\\b`, 'i').test(value)) return true
    if (/\b(?:git\s+(?:pull|status|diff|log|show|fetch)|tmux\s+ls|nmap\s+-|ip\s+(?:route|addr)|pnpm\s+|npm\s+|node\s+|python3?\s+|docker\s+|systemctl\s+|sqlite3\s+|curl\s+|wget\s+|jq\s+)/i.test(value)) return true
    if (new RegExp(`(?:用|拿|通过).{0,12}(?:${commandKeywords}).{0,12}(?:命令|工具)`, 'i').test(value)) return true
    if (new RegExp(`(?:${commandKeywords}).{0,10}(?:命令).{0,16}(?:查|看|读取|查询|检查|列出)`, 'i').test(value)) return true
    if (/(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看).{0,16}(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机)/i.test(value)) return true
    if (/(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机).{0,16}(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看)/i.test(value)) return true
    return false
}

export function isContinuationToolInstruction(text) {
    const value = getPrimaryUserInstruction(text)
        .replace(/^#\S+\s*/i, '')
        .trim()
    if (!value) return false

    const prefix = '(?:咳咳|嗯+|呃+|那个|那|现在|这次|刚才|前面|上面|之前|好了|可以了|行了|ok|OK)?'
    const action = '(?:继续|接着|看看|看一下|帮我看看|给我看看|处理|弄一下|执行|跑一下|查一下|读一下)'
    return new RegExp(`^\\s*${prefix}[,，。!！\\s]*(?:现在)?(?:能不能|能|可以|可不可以)?(?:帮我|给我|麻烦你?)?${action}(?:了吗|了没|吗|嘛|么|吧|一下|下)?[?？!！。,.，\\s]*$`, 'i').test(value)
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

function hasModelPlannedLowRiskEvidence(call = {}, instruction = '', options = {}) {
    if (options.allowModelPlannedLowRisk !== true) return false
    if (call.name === 'web_fetch') {
        const urls = [
            ...extractUrls(instruction),
            ...(Array.isArray(options.candidateUrls) ? options.candidateUrls : [])
        ].filter(Boolean)
        if (urls.length === 0) return false
        const requestedUrl = String(call.args?.url || call.params?.url || '').trim()
        if (!requestedUrl) return true
        return urls.some(url => requestedUrl === url || requestedUrl.includes(url) || url.includes(requestedUrl))
    }
    return false
}

export function isExplicitToolIntent(toolName, text, options = {}) {
    switch (toolName) {
        case 'group_send_message':
            return isExplicitGroupSendRequest(text)
        case 'group_leave':
            return isExplicitGroupLeaveRequest(text)
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
        case 'user_profile_update':
            return hasExplicitUserProfileUpdateIntent(text)
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
    const allowContinuation = options.allowContinuation === true && isContinuationToolInstruction(instruction)
    const continuationTools = new Set(Array.isArray(options.continuationTools) ? options.continuationTools : [])
    for (const call of toolCalls || []) {
        if (!call?.name) continue
        if (!isExplicitToolIntent(call.name, instruction, options)) {
            if (allowContinuation && continuationTools.has(call.name)) {
                filtered.push(call)
                continue
            }
            if (hasModelPlannedLowRiskEvidence(call, instruction, options)) {
                filtered.push(call)
                continue
            }
            blocked.push(call)
            continue
        }
        filtered.push(call)
    }
    return { tools: filtered, blocked }
}
