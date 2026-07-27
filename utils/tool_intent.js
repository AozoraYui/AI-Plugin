const DELEGATE_WORDS = '(?:帮我|替我|代我|帮忙|麻烦你?|拜托你?|请你?|劳烦你?)'
const SEND_VERBS = '(?:发送|群发|代发|转达|带(?:个|句)?话|捎(?:个|句)?话|传(?:个|句)?话|告诉(?:一下|一声)?|说(?:一下|一声|一句)?|发(?:一下|一条|一句|个消息|消息)?)'
const TARGET_SUFFIX = '(?:(?:那个|这个|该|目标)群|群聊|群里|群内|群|那边|里面|里)?'
const BOT_CALL_PREFIX = '(?:(?:诺亚|noa|喏亚|诺娅)[,，。!！~～\\s]*)?'
const FORBIDDEN_GROUP_SET_PATTERN = /(?:所有|全部|全体|每个|各个|不友好(?:的)?(?:那些|这些)?|有问题(?:的)?(?:那些|这些)?)/i

export function getPrimaryUserInstruction(text) {
    const value = String(text || '').trim()
    if (!value) return ''
    const index = value.search(/\n===\s*引用/)
    return stripChatCommandPrefix(index >= 0 ? value.slice(0, index) : value)
}

function stripChatCommandPrefix(text = '') {
    return String(text || '')
        .replace(/^\s*#(?:uc|c|pc|sc)\b\s*/i, '')
        .replace(/^\s*(?:诺亚|noa|喏亚|诺娅)[,，。!！~～\s]+/i, '')
        .trim()
}

export function normalizeToolInstruction(text = '') {
    const rawText = String(text || '').trim()
    const commandMatch = rawText.match(/^\s*#(uc|c|pc|sc)\b/i)
    const quoteIndex = rawText.search(/\n===\s*引用/)
    const currentText = (quoteIndex >= 0 ? rawText.slice(0, quoteIndex) : rawText).trim()
    return {
        rawText,
        command: commandMatch?.[1]?.toLowerCase() || '',
        instruction: stripChatCommandPrefix(currentText),
        quotedContext: quoteIndex >= 0 ? rawText.slice(quoteIndex).trim() : '',
        urls: extractUrls(currentText)
    }
}

function isCapabilityOrUsageQuestion(text = '', actionPattern = '') {
    const value = getPrimaryUserInstruction(text)
    if (!value || !actionPattern) return false
    const capability = `(?:你|机器人|AI|插件|这个功能|该功能)?\\s*(?:会不会|能不能|能否|能|会|可以不可以|可不可以|可以吗|支持吗|有没有|是否支持)`
    const usage = '(?:怎么用|如何用|怎样用|用法|教程|功能介绍|有什么用|是干嘛的|是什么意思)'
    return new RegExp(`(?:${capability}).{0,36}(?:${actionPattern})|(?:${actionPattern}).{0,36}(?:${usage}|能不能|能否|是否可以|可以吗|支持吗|会吗)`, 'i').test(value)
        && !new RegExp(`(?:帮我|替我|代我|给我|请你?|麻烦你?|现在|立刻|马上).{0,20}(?:${actionPattern})`, 'i').test(value)
}

function cleanTarget(target = '') {
    return String(target || '')
        .trim()
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        .replace(/^(?:在|去|到|往|给|从)\s*/i, '')
        .replace(/(?:吧|呀|啊|呢|嘛|么|啦|了|哈|哦|噢|喵|捏)$/i, '')
        .replace(/(?:(?:那个|这个|该|目标)群|群聊|群里|群内|那边|里面|里|群)$/i, '')
        .trim()
}

function cleanDelegatedMessage(message = '') {
    let value = String(message || '').trim()
    value = value.replace(/^(?:内容|消息|正文)\s*(?:是|为)?\s*[：:，,=]?\s*/i, '').trim()
    const pairedQuotes = [
        ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']
    ]
    for (const [open, close] of pairedQuotes) {
        if (value.startsWith(open) && value.endsWith(close) && value.length >= open.length + close.length) {
            value = value.slice(open.length, value.length - close.length).trim()
            break
        }
    }
    return value
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
    return new RegExp(DELEGATE_WORDS, 'i').test(fullText) || /(?:代发|转达|群发|带(?:个|句)?话|捎(?:个|句)?话|传(?:个|句)?话)/i.test(verb)
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
    const value = stripChatCommandPrefix(getPrimaryUserInstruction(text))
    if (!value) return null

    const explicitListPatterns = [
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?:在|去|到|往|给)?\\s*(?:这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|群号|目标群)\\s*[：:]\\s*(?<target>[\\s\\S]{1,200}?)\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000})$`, 'i'),
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?<verb>${SEND_VERBS})\\s*(?:到|给|在)?\\s*(?:这些群|這些群|那些群|这几个群|這几个群|那几个群|以下群|如下群|群号|目标群)?\\s*[：:]\\s*(?<target>[\\s\\S]{1,200}?)\\s*(?:内容|消息|说|发|发送)\\s*[：:]\\s*(?<message>[\\s\\S]{1,1000})$`, 'i')
    ]
    for (const pattern of explicitListPatterns) {
        const match = value.match(pattern)
        const target = match?.groups?.target?.trim()
        const message = cleanDelegatedMessage(match?.groups?.message)
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
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?:在|去|到|往|给)\\s*(?<target>[^，,。；;：:\\n]{1,60}?)${TARGET_SUFFIX}\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000})$`, 'i'),
        new RegExp(`^\\s*${BOT_CALL_PREFIX}(?<delegate>${DELEGATE_WORDS})?\\s*(?<verb>${SEND_VERBS})\\s*[：:，,\\s]*(?<message>[\\s\\S]{1,1000}?)\\s*(?:到|去|在|给)\\s*(?<target>[^，,。；;：:\\n]{1,60}?)${TARGET_SUFFIX}$`, 'i')
    ]

    for (const pattern of patterns) {
        const match = value.match(pattern)
        const target = match?.groups?.target?.trim()
        const message = cleanDelegatedMessage(match?.groups?.message)
        const verb = match?.groups?.verb || ''
        if (!target || !message) continue
        const hasDirectionalSend = /(?:^|[，,。；;\s])(?:在|去|到|往|给)\s*[^，,。；;：:\n]{1,60}/i.test(value)
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

    const colloquialLeave = value.match(/(?:别|不要|不用).{0,8}(?:在|待在|留在)\s*(?<target>[^，,。；;：:\n]{1,60}?)(?:群聊|群里|群内|那边|里面|里|群)?(?:待|待着|留着|呆着)?(?:了|啦)?[，,。；;\s]*(?:退(?:掉|了|出)?|退出|离开|撤出)/i)
    if (colloquialLeave?.groups?.target) {
        const args = assignGroupTargets({}, colloquialLeave.groups.target)
        if (!args.forbidden_set && (args.group_id || args.target || args.group_ids || args.targets)) return args
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
    const drawCue = '(?:^|[，,。；;！？!?\\s]|帮我|给我|请|麻烦你?|想让你|让你|要你|你来|你能不能|能不能|可以帮我)'
    const generationIntent = new RegExp(`${drawCue}\\s*(?:再|重新)?\\s*(?:画|绘制|生成|创作|整|搞|做)(?:个|一张|一下|张)?[\\s\\S]{0,100}(?:图|图片|插画|头像|壁纸|表情包|设定图|立绘|你自己|你本人|AI本人|自画像|你长什么样|你的样子|诺亚|noa)`, 'i').test(value)
        || new RegExp(`${drawCue}\\s*(?:再|重新)?\\s*(?:画|绘制)(?:个|一张|一下|张)?\\s*[\\s\\S]{1,80}$`, 'i').test(value)
        || /(?:帮我|给我|请|麻烦你?|想让你|让你|要你|你来|你能不能|能不能|可以帮我).{0,12}做(?:个|一个|一张|一下)?[\s\S]{0,80}(?:图|图片|插画|头像|壁纸|表情包|设定图|立绘)/i.test(value)
        || /(?:^|[，,。；;！？!?\s])做(?:个|一个|一张)[\s\S]{0,80}(?:图|图片|插画|头像|壁纸|表情包|设定图|立绘)[。！!？?\s]*$/i.test(value)
        || /(?:看看|给我看看)(?:你长什么样|你的样子)/i.test(value)
    const imageEditIntent = hasImageContext
        && /(?:去掉|去除|移除|擦除|消除|抹掉|清理|删掉|去水印|水印|二维码|改成|变成|转成|风格化|手办化|inpaint|inpainting|修图|处理图片|p图|P图)/i.test(value)
        && /(?:图片|照片|图|原图|参考图|这张|那张|刚才|刚刚|水印|二维码|手办化|风格化|修图|p图|P图)/i.test(value)
    return generationIntent || imageEditIntent
}

export function hasExplicitWebSearchIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (isCapabilityOrUsageQuestion(value, '搜索|联网|上网|web[_ -]?search')) return false
    return /(?:搜索|搜一下|查一下|查询|检索|联网查|上网查).{0,80}/i.test(value)
        || /(?:帮我|给我|请|麻烦).{0,12}(?:搜|查|检索)/i.test(value)
        || /(?:最新|今天|明天|实时|当前|现在).{0,20}(?:新闻|价格|汇率|版本|政策|公告|比赛|赛程|航班|列车|数据|资料|信息|情况)/i.test(value)
}

export function hasExplicitWebFetchIntent(text, candidateUrls = []) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const hasUrl = extractUrls(value).length > 0 || (Array.isArray(candidateUrls) && candidateUrls.length > 0)
    return hasUrl && (/\bfetch\b|(?:抓一下|爬一下|扒一下)/i.test(value)
        || /(?:试试|再试试|重试|重新试|换(?:成|用)?这个|用这个|这个呢|这个可以吗|这个能行吗|能打开吗|能抓吗|能不能打开|能不能抓)/i.test(value)
        || /(?:看|看看|打开|读|读取|抓取|总结|分析|解释|概括).{0,20}(?:链接|网页|网址|页面|内容|这个|这条|上面)/i.test(value)
        || /(?:这个|这条|上面).{0,8}(?:链接|网页|网址).{0,12}(?:讲|说|内容|总结|看看|分析)/i.test(value)
        || /^(?:帮我|给我|请|麻烦你?)?\s*(?:fetch|看|看看|看一下|打开|读取|抓取|抓一下|爬一下|扒一下|总结|总结一下|概括|分析|解释|试试|再试试|重试)(?:一下|下)?[。！!？?\s]*$/i.test(value))
}

export function hasExplicitFileDownloadIntent(text, options = {}) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (isCapabilityOrUsageQuestion(value, '文件下载|下载文件|保存文件|落盘')) return false
    if (/(?:群文件|群文件区|群里的文件|群内文件)/i.test(value)) return false
    const hasImages = options.hasImages === true
    const mediaWords = '(?:图片|照片|图|视频|语音|文件|这些|这个|引用|消息|媒体)'
    const actionWords = '(?:下载|保存|存储|存到|下载到|保存到|存起来|落盘|落到服务器|保存到服务器)'
    return new RegExp(`${actionWords}.{0,30}${mediaWords}|${mediaWords}.{0,30}${actionWords}`, 'i').test(value)
        || (hasImages && /(?:下载|保存|存储|存到|下载到|保存到|存起来)/i.test(value))
}

export function hasExplicitFileSendIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (isCapabilityOrUsageQuestion(value, '文件发送|发送文件|上传文件|发文件')) return false
    if (hasExplicitLocalFileMutationIntent(value)) return false
    const sendIntent = /(?:发给我|发我|发送|发出来|发到(?:群里|这里)?|丢到?(?:群里|这里)|扔到?(?:群里|这里)|传给我|上传(?:到(?:群里|这里)?)?|把.{0,80}(?:上传|发群里|丢群里|扔群里)|试(?:一下|下)?上传)/i.test(value)
    const targetHint = /\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)\b|(?:\.{0,2}\/)?(?:[\w@+.-]+\/)+[\w@+.-]*|[\w.-]+\.(?:png|jpe?g|webp|gif|mp4|mov|avi|mkv|mp3|wav|ogg|flac|zip|7z|rar|gz|pdf|txt|log|md|json|ya?ml|js|ts|db|sqlite|bin)\b|(?:日志|配置|插件|源码|源文件|脚本|文件|目录|压缩包|这个|那个|刚才|上面)/i.test(value)
    return sendIntent && targetHint
}

export function hasExplicitLocalFileDiscoveryIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const relativePath = '(?:\\.{0,2}\\/)?(?:[\\w@+.-]+\\/)+[\\w@+.-]*'
    const discoveryAction = '(?:看|看看|看下|看一下|检查|确认|查|查询|查找|搜索|找)'
    const existenceHint = '(?:有没[有无]|是否有|是不是有|存在|叫|名为|名称|名字|哪个|哪一个|列出|里面|目录下)'
    const localObject = '(?:插件|源码|源文件|脚本|文件|目录|代码)'
    return new RegExp(`${discoveryAction}.{0,60}${relativePath}.{0,80}(?:${existenceHint}|${localObject})`, 'i').test(value)
        || new RegExp(`${relativePath}.{0,80}(?:${discoveryAction}|${existenceHint}).{0,80}${localObject}`, 'i').test(value)
        || new RegExp(`${relativePath}.{0,80}${existenceHint}`, 'i').test(value)
}

export function hasExplicitLocalFileMutationIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const action = '(?:写入|写到|添加到?|加入到?|追加到?|放进|放到|插入|修改|改成|设置成|设为|替换|删除|删掉|移除|清除)'
    const target = '(?:\\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)\\b|[\\w.-]+\\.(?:json|ya?ml|toml|ini|conf|cfg|js|ts|py|sh)|配置文件|群配置|配置(?:项|段|字段)?|disable|enable|白名单|黑名单|列表|字段)'
    const delegated = new RegExp(`(?:帮我|给我|请|麻烦你?|你能不能|能不能|可以帮我|把|将).{0,160}${action}|^\\s*${action}`, 'i').test(value)
    const targetsFile = new RegExp(`${action}.{0,120}${target}|${target}.{0,120}${action}`, 'i').test(value)
    const asksHow = /(?:怎么|如何|怎样).{0,40}(?:写入|写到|添加|加入|追加|修改|替换|删除|移除)/i.test(value)
    return delegated && targetsFile && !(asksHow && !/(?:帮我|给我|请|麻烦)/i.test(value))
}

export function hasExplicitGroupChatContextIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false

    if (parseNamedGroupChatContextRequest(value)) return true
    if (/(加了哪些群|加入了哪些群|在哪些群|能看到哪些群|可见群|群列表|所有群列表|有哪些群|有什么群|机器人.{0,16}(?:加了|加入|在|能看|能看到|可见).{0,12}群|你.{0,8}(?:加了|加入|在|能看|能看到|可见).{0,12}(?:哪些|什么|多少)?群)/i.test(value)) return true
    if (/(我|俺|咱).{0,18}(别的群|其他群|其它群|别群|跨群).{0,24}(发|说|聊|消息|看到|看见|记录|记得|知道)/i.test(value)) return true
    if (/(别的群|其他群|其它群|别群|跨群).{0,18}(我|俺|咱).{0,24}(发|说|聊|消息|看到|看见|记录|记得|知道)/i.test(value)) return true
    if (hasGroupChatContextQuestion(value)) return true

    const action = '(?:读取|读一下|查看|看看|查询|查一下|检索|搜索|拉一下|调出|翻一下|总结|整理|回顾|概括)'
    const object = '(?:群聊|群消息|聊天记录|群聊记录|消息记录|消息流水|畅聊记录|群上下文|聊天上下文|前情|所有群|全部群|其他群|其它群|别的群|跨群)'
    return new RegExp(`${action}.{0,20}${object}|${object}.{0,20}${action}`, 'i').test(value)
}

export function parseNamedGroupChatContextRequest(text) {
    const value = getPrimaryUserInstruction(text).trim()
    if (!value) return null
    const asksForContext = /(?:最近|刚才|刚刚|之前|前面|这会儿|聊天|群聊|消息|记录|流水|前情|聊(?:了|过|啥|什么)|在聊|说(?:了|过|啥|什么)|在说|发言|发(?:了|过|啥|什么)|发生(?:了)?|总结|整理|回顾|概括|看看|看一下|查询|查一下)/i.test(value)
    if (!asksForContext || hasNonChatRecordDomain(value)) return null

    const patterns = [
        /(?:名字叫|名为|叫)\s*[「“"『]([^」”"』\n]{1,60})[」”"』]\s*(?:的)?群/i,
        /[「“"『]([^」”"』\n]{1,60})[」”"』]\s*(?:这个|那个|名字的|的)?群/i,
        /(?:名字叫|名为)\s*([^，,。；;！？!?\n]{1,50}?)\s*(?:的)?群/i
    ]
    let target = ''
    for (const pattern of patterns) {
        const match = value.match(pattern)
        if (match?.[1]) {
            target = match[1].trim()
            break
        }
    }
    if (!target || /^(?:本|当前|这个|那个|这|那|所有|全部|其他|其它|别的|各个?)$/i.test(target)) return null
    const hoursMatch = value.match(/(?:最近|近|过去|这)?\s*(\d{1,3}|[一二两三四五六七八九十两几]+)\s*(?:个)?小时/i)
    let hours
    if (hoursMatch?.[1]) {
        const rawHours = hoursMatch[1]
        const chineseHours = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 几: 3 }
        hours = /^\d+$/.test(rawHours) ? Number(rawHours) : chineseHours[rawHours]
    }
    return {
        scope: 'specific_group',
        query: target,
        limit: hours ? 120 : 40,
        ...(hours ? { hours: Math.min(Math.max(hours, 1), 168) } : {})
    }
}

export function parseRecentGroupChatFollowupRequest(text, previousArgs = {}, userId = '') {
    const value = getPrimaryUserInstruction(text).replace(/^#[A-Za-z0-9_]+\s*/i, '').trim()
    if (!value || parseNamedGroupChatContextRequest(value)) return null
    const referencesPreviousGroup = /(?:括号|方括号)(?:那个|这个)?\s*(?:的)?群|(?:刚才查的|刚才看的|前面查的|前面看的|刚才那个|前面那个|上个|那个|这个|该)\s*(?:的)?群/i.test(value)
    const asksForMoreMessages = /(?:还|又|另外|其他|其它|别的|更多).{0,18}(?:说|发|聊|消息|发言)|(?:说|发|聊).{0,18}(?:啥|什么|哪些|内容)/i.test(value)
    if (!referencesPreviousGroup || !asksForMoreMessages) return null

    const previousScope = String(previousArgs.scope || '').trim()
    const previousGroupId = String(previousArgs.group_id || previousArgs.groupId || '').trim()
    const previousQuery = String(previousArgs.query || '').trim()
    if (!['specific_group', 'all_groups'].includes(previousScope) || (!previousGroupId && !previousQuery)) return null

    const asksForSelf = /(?:^|[，,。！？!?\s])(我|俺|咱)(?:在|还|又|都|之前|刚才|前面)?/i.test(value)
    return {
        scope: 'specific_group',
        ...(previousGroupId ? { group_id: previousGroupId } : { query: previousQuery }),
        ...(asksForSelf && userId ? { user_id: String(userId) } : {}),
        limit: Math.min(Math.max(Number(previousArgs.limit) || 40, 5), 120),
        ...(previousArgs.hours ? { hours: previousArgs.hours } : {})
    }
}

function hasNonChatRecordDomain(value = '') {
    const text = String(value || '')
    const nonChatDomain = /(?:git|commit|提交|提交记录|变更记录|更新记录|改动记录|changelog|change\s*log|代码变更|仓库|repo|repository|分支|branch|diff|pull|插件|AI-Plugin)/i.test(text)
        && /(?:看|查看|查|查询|列出|读取|读|总结|整理|回顾|分析|最近|前|最新|历史|记录|日志|log|变更|改动|提交)/i.test(text)
    if (!nonChatDomain) return false
    const explicitChatContext = /(?:群聊|群消息|聊天记录|消息记录|消息流水|畅聊记录|群上下文|大家|他们|她们|别人|群友|所有群|全部群|跨群|各群|别的群|其他群|其它群|本群|当前群|这个群|这群)/i.test(text)
        || /(?:群里|群内).{0,24}(?:聊了啥|聊了什么|说了啥|说了什么|发了啥|发了什么|发生了什么|前情|总结|记录|流水)/i.test(text)
    return !explicitChatContext
}

export function hasExplicitGroupChatDigestIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const digestAction = '(?:总结|整理|回顾|概括|复盘|补课|看看|看一下|讲讲|说说)'
    const groupObject = '(?:群里|群内|群聊|群消息|聊天记录|消息流水|大家|他们|她们|所有群|全部群|跨群|各群|别的群|其他群|其它群|别群|这个群|本群|当前群)'
    const longRange = '(?:最近\\s*(?:\\d{1,2}|[一二两三四五六七八九十两几]{1,3})\\s*(?:天|日|小时|钟头|h)|这几天|近几天|过去几天|今天|昨天|昨日|前天|这两天|最近一阵|这段时间|我不在(?:的时候|这段时间)?|我没在(?:的时候|这段时间)?|没看群(?:的时候|这段时间)?|漏看(?:的时候|这段时间)?|睡觉(?:的时候|期间)?|睡醒|从我(?:上次|最后一次).{0,8}(?:发言|说话|冒泡|发消息)|上次(?:发言|说话|冒泡|发消息)后)'
    return new RegExp(`${longRange}.{0,40}${groupObject}.{0,40}(?:聊|说|发|发生|什么情况|前情|${digestAction})`, 'i').test(value)
        || new RegExp(`${digestAction}.{0,30}${longRange}.{0,30}${groupObject}`, 'i').test(value)
        || new RegExp(`${digestAction}.{0,30}${groupObject}.{0,30}${longRange}`, 'i').test(value)
        || new RegExp(`${groupObject}.{0,30}${longRange}.{0,30}(?:聊|说|发|发生|什么情况|前情|${digestAction})`, 'i').test(value)
        || new RegExp(`${groupObject}.{0,30}${longRange}.{0,30}${digestAction}`, 'i').test(value)
}

export function parseGroupChatDigestRequest(text) {
    const value = getPrimaryUserInstruction(text).trim()
    if (!hasExplicitGroupChatDigestIntent(value)) return null
    const args = {}
    if (/(?:我不在|我没在|没看群|漏看|睡觉|睡醒|从我(?:上次|最后一次).{0,8}(?:发言|说话|冒泡|发消息)|上次(?:发言|说话|冒泡|发消息)后)/i.test(value)) {
        args.range = 'since_last_message'
    } else if (/昨天|昨日/i.test(value)) {
        args.range = 'yesterday'
    } else if (/今天|今日|从早上|从上午|从今天/i.test(value)) {
        args.range = 'today'
    } else {
        const hourMatch = value.match(/(?:最近|近|过去|这|前)?\s*(\d{1,3}|[一二两三四五六七八九十两几]{1,3})\s*(?:个)?(?:小时|钟头|h)/i)
        const dayMatch = value.match(/(?:最近|近|过去|这|前)?\s*(\d{1,2}|[一二两三四五六七八九十两几]{1,3})\s*(?:天|日)/i)
        if (hourMatch?.[1]) {
            args.range = 'recent_hours'
            if (/^\d+$/.test(hourMatch[1])) args.hours = Number(hourMatch[1])
        } else if (dayMatch?.[1] || /(?:最近几天|这几天|近几天|过去几天)/i.test(value)) {
            args.range = 'recent_days'
            if (dayMatch?.[1] && /^\d+$/.test(dayMatch[1])) args.days = Number(dayMatch[1])
        }
    }
    if (!args.range) args.range = 'recent_hours'

    if (/(?:所有群|全部群|跨群|各群|全局)/i.test(value)) {
        args.scope = 'all_groups'
    } else if (/(?:我|俺|咱).{0,30}(?:别的群|其他群|其它群|跨群).{0,30}(?:说|聊|发|消息|总结|回顾)|(?:别的群|其他群|其它群|跨群).{0,30}(?:我|俺|咱).{0,30}(?:说|聊|发|消息|总结|回顾)/i.test(value)) {
        args.scope = 'my_recent_messages'
        if (/(?:别的群|其他群|其它群|别群)/i.test(value)) args.exclude_current_group = true
    } else {
        args.scope = 'current_group'
    }

    const groupMatch = value.match(/(?:群号|群)\s*[：:=]?\s*(\d{5,15})/i)
    if (groupMatch?.[1]) {
        args.scope = 'specific_group'
        args.group_id = groupMatch[1]
    }
    const queryMatch = value.match(/(?:关于|关键词|包含|提到)\s*[「"“]?([^」"”，,。！？\n]{2,40})[」"”]?/i)
    if (queryMatch?.[1] && !/(群里|群聊|大家|他们|她们|最近|昨天|今天|我不在)/i.test(queryMatch[1])) {
        args.query = queryMatch[1].trim()
    }
    return args
}

export function hasStrongGroupChatContextQuestion(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (hasNonChatRecordDomain(value)) return false

    const groupActors = '(?:群里|群内|群聊|群消息|群友|大家|他们|她们|别人|本群|当前群|这个群|这群)'
    const crossGroupWords = '(?:所有群|全部群|跨群|各群|别的群|其他群|其它群|别群|那边群|别处群)'
    const shortTimeWords = '(?:刚才|刚刚|前面|之前|这会儿|刚才那会儿)'
    const chatActions = '(?:聊(?:了|过)?(?:啥|什么|些啥|些什么)|在聊(?:啥|什么)|说(?:了|过)?(?:啥|什么|些啥|些什么)|在说(?:啥|什么)|发(?:了|过)?(?:啥|什么|些啥|些什么)|发生(?:了)?(?:啥|什么|什么事)|什么情况|啥情况|咋了|怎么了|在干嘛|在干什么|前情|前情提要)'
    const recordActions = '(?:总结|概括|回顾|消息|记录|流水)'

    return new RegExp(`${groupActors}.{0,28}(?:${chatActions}|${recordActions})|(?:${chatActions}|${recordActions}).{0,24}${groupActors}`, 'i').test(value)
        || new RegExp(`${shortTimeWords}.{0,24}${chatActions}|${chatActions}.{0,20}${shortTimeWords}`, 'i').test(value)
        || new RegExp(`${crossGroupWords}.{0,28}(?:${chatActions}|${recordActions})|(?:${chatActions}|${recordActions}).{0,20}${crossGroupWords}`, 'i').test(value)
        || /(?:最近前情|前情提要|补一下前情|补补前情)/i.test(value)
        || /(?:我不在|没看群|漏看).{0,24}(?:聊|说|发|发生|总结|前情)/i.test(value)
}

export function hasExplicitUserProfileUpdateIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|能不能|可以|能).{0,20}(?:写|更新|维护|记|提炼|抽取|整理|总结).{0,20}(?:个人档案|用户档案|用户画像|档案|画像|长期记忆).{0,10}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦|现在|直接).{0,16}(?:写|更新|维护|记|提炼|抽取|整理|总结)/i.test(value)) {
        return false
    }
    const object = '(?:个人档案|用户档案|用户画像|个人画像|我的档案|我的画像|我的资料|个人资料|长期档案|长期记忆|稳定画像)'
    const action = '(?:记到|记进|写到|写进|存到|存进|加入|更新|维护|整理|提炼|抽取|总结)'
    const memoryAction = '(?:记住|记一下|记下来|帮我记|给我记|以后记得|长期记住|别忘了)'
    const personalSignal = '(?:我|我的|叫我|称呼|名字|昵称|喜欢|不喜欢|偏好|习惯|常用|住在|来自|职业|身份|项目|性格|雷点|忌口)'
    return new RegExp(`${action}.{0,24}${object}|${object}.{0,24}${action}`, 'i').test(value)
        || /(?:把|将).{1,120}(?:记到|记进|写到|写进|存到|存进).{0,16}(?:档案|画像|资料|长期记忆)/i.test(value)
        || hasExplicitUserProfileHistoryExtractionIntent(value)
        || new RegExp(`${memoryAction}.{0,100}${personalSignal}|${personalSignal}.{0,100}${memoryAction}`, 'i').test(value)
}

export function hasExplicitUserProfileHistoryExtractionIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const source = '(?:刚才|刚刚|上面|前面|最近|历史|聊天|对话|上下文|记录|我们(?:的)?(?:聊天|对话|记录)?|咱们(?:的)?(?:聊天|对话|记录)?|我(?:和|跟|与)你(?:的)?(?:聊天|对话|记录)?|你(?:和|跟|与)我(?:的)?(?:聊天|对话|记录)?)'
    const action = '(?:全面读|完整读|全部读|通读|读(?:一下|一遍)?|看(?:一下|一遍)?|回顾|梳理|提炼|抽取|整理|总结|更新|维护|生成|写成|整理成|提炼成|做成|变成)'
    const object = '(?:个人档案|用户档案|用户画像|个人画像|我的档案|我的画像|长期档案|长期记忆|稳定画像|档案|画像)'
    return new RegExp(`(?:从|根据|基于|围绕)?.{0,12}${source}.{0,50}${action}.{0,40}${object}`, 'i').test(value)
        || new RegExp(`${action}.{0,50}${source}.{0,50}${object}`, 'i').test(value)
        || new RegExp(`${source}.{0,50}${object}.{0,30}${action}`, 'i').test(value)
}

export function hasExplicitMemorySearchIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (hasExplicitUserProfileUpdateIntent(value)) return false

    const recentGroupQuestion = hasGroupChatContextQuestion(value)
    const semanticHint = /(?:语义|相关记忆|相关历史|历史里|记忆里|旧对话|对话记录|聊天记录|以前|之前|曾经|说过|提过|聊过|讨论过|记得|记不记得)/i.test(value)
    if (recentGroupQuestion && !semanticHint) return false

    return /(?:历史|记忆|旧对话|过往|对话记录|聊天记录|记录里).{0,40}(?:搜索|检索|查|查询|找|翻|回忆|有没有|是否|说过|提过|聊过|讨论过|相关)/i.test(value)
        || /(?:搜索|检索|查|查询|找|翻|翻翻|回想).{0,32}(?:历史|记忆|旧对话|过往|对话记录|聊天记录|记录|以前|之前)/i.test(value)
        || /(?:相关记忆|相关历史|语义检索|语义搜索|交叉检索|跨源检索|跨群检索)/i.test(value)
        || /(?:我|我们|咱们|你).{0,24}(?:以前|之前|曾经).{0,36}(?:说过|提过|聊过|讨论过|提到过|讲过|记得|记不记得)/i.test(value)
        || /(?:你还记得|还记不记得|有没有印象).{0,80}(?:我|我们|之前|以前|说过|提过|聊过|讨论过)/i.test(value)
}

export function parseMemorySearchRequest(text) {
    const value = getPrimaryUserInstruction(text).trim()
    if (!hasExplicitMemorySearchIntent(value)) return null
    const query = value.replace(/^#[A-Za-z0-9_]+\s*/i, '').trim() || value
    const args = { query }
    if (/(?:所有群|全部群|跨群|各群|全局|全部记忆|所有记忆|所有历史|全部历史)/i.test(value)) {
        args.scope = 'all'
    } else if (/(?:本群|当前群|这个群|群里|群聊)/i.test(value)) {
        args.scope = 'current_group'
    } else if (/(?:我的个人记忆|我的记忆|我自己的|关于我|我的历史|我们的对话|咱们的对话|我和你|你和我)/i.test(value)) {
        args.scope = 'my_memory'
    }
    const userMatch = value.match(/(?:QQ|用户|user[_\s-]?id)\s*[：:=]?\s*(\d{5,15})/i)
    if (userMatch?.[1]) {
        args.user_id = userMatch[1]
        if (!args.scope) args.scope = 'user_memory'
    }
    const groupMatch = value.match(/(?:群号|群)\s*[：:=]?\s*(\d{5,15})/i)
    if (groupMatch?.[1]) {
        args.group_id = groupMatch[1]
        args.scope = 'specific_group'
    }
    return args
}

export function hasGroupChatContextQuestion(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    if (hasNonChatRecordDomain(value)) return false
    if (hasStrongGroupChatContextQuestion(value)) return true

    const contextVerbs = '(?:聊(?:了|过)?(?:啥|什么|些啥|些什么)?|在聊(?:啥|什么)|水(?:了|过)?(?:啥|什么|些啥|些什么)?|在水(?:啥|什么)|说(?:了|过)?(?:啥|什么|些啥|些什么)?|在说(?:啥|什么)|发(?:了|过)?(?:啥|什么|些啥|些什么)?|发生(?:了)?(?:啥|什么|什么事)?|什么情况|啥情况|咋了|怎么了|在干嘛|在干什么|前情|前情提要|总结|概括|回顾|消息|流水)'
    const timeWords = '(?:刚才|刚刚|之前|前面|最近|这会儿|刚才那会儿|我不在的时候|我没看的时候)'
    const currentGroupWords = '(?:他们|她们|大家|群里|群内|这群|这个群|这里|刚才|刚刚|之前|前面)'
    const crossGroupWords = '(?:所有群|全部群|跨群|各群|别的群|其他群|其它群|别群|那边群|别处群)'

    return new RegExp(`${currentGroupWords}.{0,28}${contextVerbs}|${contextVerbs}.{0,20}(?:${timeWords}|群里|大家|他们|她们)`, 'i').test(value)
        || new RegExp(`${crossGroupWords}.{0,28}${contextVerbs}|${contextVerbs}.{0,20}${crossGroupWords}`, 'i').test(value)
        || /(?:我不在|没看群|漏看).{0,24}(?:聊|说|发|发生|总结|前情)/i.test(value)
}

export function hasExplicitShellIntent(text, toolName = '') {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const commandKeywords = 'ssh|scp|rsync|git|npm|pnpm|node|python3?|bash|sh|zsh|systemctl|docker|pm2|grep|rg|find|ls|cat|tail|head|nmap|ip|tmux|sqlite3|sqlite|curl|wget|jq|sed|awk'
    const shellKeywords = `${commandKeywords}|shell|命令|终端`
    const sessionWords = '(?:tmux|ai-shell|shell\\s*session|shell会话|shell窗口|独立shell|终端会话)'
    if (toolName === 'shell_session'
        && new RegExp(sessionWords, 'i').test(value)
        && /(?:输出|回显|结果|窗口|画面|内容|状态|读|读取|查看|看看|刷新|回读|还有|执行|运行|输入|发送|打入|中断|停止|清屏|重启|关闭)/i.test(value)) {
        return true
    }
    if (/^(?:你|诺亚|noa)?\s*(?:会不会|会|能不能|可以|能).{0,16}(?:执行|运行|调用).{0,16}(?:shell|命令|终端|命令行).{0,20}(?:吗|嘛|么|？|\?)/i.test(value)
        && !/(?:帮我|给我|请|麻烦)/i.test(value)) {
        return false
    }
    if (isQuestionAboutTool(value, shellKeywords)
        && !new RegExp(`(?:帮我|给我|请|麻烦|执行|运行|调用|用|拿|通过).{0,20}(?:${shellKeywords})`, 'i').test(value)) {
        return false
    }
    if (hasExplicitLocalFileMutationIntent(value)) return true
    if (hasExplicitLocalFileDiscoveryIntent(value)) return true
    if (toolName === 'shell_session' && new RegExp(sessionWords, 'i').test(value)) return true
    if (/\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)\b/i.test(value)
        && /(?:看|看看|读|读取|打开|检查|分析|搜索|查找|统计|内容|日志|配置|脚本|文件|目录)/i.test(value)) return true
    if (hasExplicitLocalFileReadIntent(value)) return true
    if (/(?:局域网|内网|LAN|网段|入网设备|在线设备|网关|路由器).{0,24}(?:扫描|探测|查|查看|多少|有哪些|nmap)|(?:扫描|探测|查|查看).{0,24}(?:局域网|内网|LAN|网段|入网设备|在线设备|网关|路由器)/i.test(value)) return true
    if (/(?:执行|运行|调用).{0,12}(?:shell|命令|终端|命令行|脚本)|(?:shell|命令)[:：]/i.test(value)) return true
    if (new RegExp(`(?:执行|运行|调用).{0,8}(?:${commandKeywords})\\b`, 'i').test(value)) return true
    if (/(?:^|[，,。\s])(?:再|继续|接着|重新)?\s*(?:执行|运行|跑(?:一下)?|试(?:一下)?|调用)\s*(?:一下|下)?\s*(?:sudo\s+)?[A-Za-z0-9_./:-]+(?:\s+[A-Za-z0-9_./:=@%+-]+){0,40}(?:\s*(?:看(?:一下|下|看)?|瞅(?:一下|下)?|查(?:一下|下)?|看结果|看看结果|输出结果|试试|一下|下|吧|喵|呢|嘛|吗|么|了))?[?？!！。,.，\s]*$/i.test(value)) return true
    if (new RegExp(`(?:输入|发送|打入).{0,8}(?:${commandKeywords})\\b`, 'i').test(value)) return true
    if (new RegExp(`^(?:sudo\\s+)?(?:${commandKeywords})\\b`, 'i').test(value)) return true
    if (new RegExp(`\\b(?:${commandKeywords})\\b[\\s\\S]{0,200}(?:命令|执行|运行|输入|发送|打入|跑一下|试一下)`, 'i').test(value)) return true
    if (/\b(?:git\s+(?:pull|status|diff|log|show|fetch)|tmux\s+ls|nmap\s+-|ip\s+(?:route|addr)|pnpm\s+|npm\s+|node\s+|python3?\s+|docker\s+|systemctl\s+|sqlite3\s+|curl\s+|wget\s+|jq\s+)/i.test(value)) return true
    if (new RegExp(`(?:用|拿|通过).{0,12}(?:${commandKeywords}).{0,12}(?:命令|工具)`, 'i').test(value)) return true
    if (new RegExp(`(?:${commandKeywords}).{0,10}(?:命令).{0,16}(?:查|看|读取|查询|检查|列出)`, 'i').test(value)) return true
    if (/(?:git|commit|提交|提交记录|变更记录|更新记录|改动记录|changelog|change\s*log).{0,40}(?:记录|历史|日志|log|提交|commit|变更|改动|更新|最近|最新|前\s*\d{1,4}\s*条)|(?:记录|历史|日志|log|提交|commit|变更|改动|更新|最近|最新|前\s*\d{1,4}\s*条).{0,40}(?:git|commit|提交|提交记录|变更记录|更新记录|改动记录|changelog|change\s*log)/i.test(value)) return true
    if (/(?:插件|AI-Plugin|仓库|repo|repository|代码).{0,40}(?:git|commit|提交|提交记录|变更记录|更新记录|改动记录|changelog|change\s*log|历史|日志)|(?:git|commit|提交|提交记录|变更记录|更新记录|改动记录|changelog|change\s*log|历史|日志).{0,40}(?:插件|AI-Plugin|仓库|repo|repository|代码)/i.test(value)) return true
    if (/(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看).{0,16}(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机)/i.test(value)) return true
    if (/(?:插件|仓库|代码|服务|进程|容器|日志|服务器|系统|主机).{0,16}(?:更新|拉取|重启|启动|停止|检查|诊断|搜索|查|看)/i.test(value)) return true
    return false
}

export function hasExplicitLocalFileReadIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value) return false
    const fileName = '(?:\\.{0,2}\\/)?(?:[\\w@+.-]+\\/)*[\\w@+.-]+\\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|txt|log|py|sh|zsh|bash|toml|ini|conf|cfg|xml|html|css|vue|svelte|go|rs|java|kt|c|cc|cpp|h|hpp|sql)'
    const readAction = '(?:看|看看|看下|看一下|瞅|瞅瞅|瞅一眼|读|读取|打开|检查|分析|搜索|查找|确认|告诉我|查)'
    const contentTarget = '(?:内容|代码|配置|脚本|文件|名称|名字|name|tag|字段|导出|定义|实现|是什么|叫什[么麼])'
    const fieldQuestion = '(?:(?:name|tag|字段|导出|定义|名称|名字).{0,18}(?:是什么|叫什[么麼]|是哪(?:个|些)?|有没[有无]|多少)|(?:是什么|叫什[么麼]|是哪(?:个|些)?|有没[有无]|多少).{0,18}(?:name|tag|字段|导出|定义|名称|名字))'
    return new RegExp(`${readAction}.{0,24}${fileName}(?:.{0,36}${contentTarget})?`, 'i').test(value)
        || new RegExp(`${fileName}.{0,36}(?:${readAction}|${fieldQuestion})`, 'i').test(value)
}

export function parseExplicitLocalFileReadRequest(text) {
    const value = getPrimaryUserInstruction(text)
    if (!hasExplicitLocalFileReadIntent(value)) return null
    const match = value.match(/\/(?:root|home|etc|var|opt|usr|data|srv|tmp|mnt)[^\s，。；;]*/i)
    if (!match) return null
    const raw = match[0].replace(/[，。；;,]+$/g, '')
    const fileMatch = raw.match(/^(.+?\.(?:tar\.gz|txt|log|md|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|zsh|bash|toml|ini|conf|cfg|xml|html|css|vue|svelte|go|rs|java|kt|c|cc|cpp|h|hpp|sql|db|sqlite|bin))\b/i)
    return fileMatch?.[1] ? { path: fileMatch[1] } : null
}

export function isContinuationToolInstruction(text) {
    const value = getPrimaryUserInstruction(text)
        .replace(/^#[A-Za-z0-9_]+\s*/i, '')
        .trim()
    if (!value) return false

    if (/^(?:现在|再|重新|刷新|继续|接着|帮我|给我|麻烦你?)?[，,。\s]*(?:看看|看一下|读一下|查看|刷新|回读).{0,18}(?:有没有|有无)?(?:输出|回显|结果|窗口|画面|终端内容|tmux内容|shell内容)/i.test(value)
        || /(?:tmux|ai-shell|shell会话|shell窗口|独立shell|终端会话).{0,18}(?:输出|回显|结果|窗口|画面|内容).{0,18}(?:还有|还有啥|还有什么|还有些什么|还有哪些|其他|别的|更多|些啥)/i.test(value)) {
        return true
    }
    if (/(?:不对|不是|还没|没有).{0,12}(?:执行|运行|跑|调用|发送|输入)|(?:执行|运行|跑|调用|发送|输入).{0,12}(?:还没|没有|漏了|没做)/i.test(value)) {
        return true
    }

    const prefix = '(?:咳咳|嗯+|呃+|那个|那|现在|这次|刚才|前面|上面|之前|好了|可以了|行了|ok|OK)?'
    const action = '(?:继续|接着|往下做|下一步|看看|看一下|帮我看看|给我看看|处理|弄一下|执行|跑一下|查一下|读一下)'
    return new RegExp(`^\\s*${prefix}[,，。!！\\s]*(?:现在)?(?:能不能|能|可以|可不可以)?(?:帮我|给我|麻烦你?)?${action}(?:了吗|了没|吗|嘛|么|吧|一下|下)?[?？!！。,.，\\s]*$`, 'i').test(value)
}

export function hasExplicitGroupAdminIntent(toolName, text) {
    const value = getPrimaryUserInstruction(text)
    if (isCapabilityOrUsageQuestion(value, '禁言|解禁|踢人|踢出|移出群|全员禁言|群名片|群昵称|头衔|精华|入群申请|加群申请|进群申请|群管理')) return false
    if (/(?:谁|哪个人|什么人|有没有人).{0,20}(?:通过|同意|拒绝|处理).{0,20}(?:申请|入群|进群|加群)/i.test(value)) return false
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

export function hasExplicitGroupFileListIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value || isCapabilityOrUsageQuestion(value, '群文件|群文件列表')) return false
    const groupFile = /(?:群文件|群文件区|群里的文件|群内文件)/i.test(value)
    const listAction = /(?:看看|查看|列出|有哪些|有什么|找找|搜索|查找|列表|目录)/i.test(value)
    return groupFile && listAction
}

export function hasExplicitGroupFileDownloadIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value || isCapabilityOrUsageQuestion(value, '群文件下载|下载群文件')) return false
    return /(?:下载|保存|取下来|拿下来).{0,36}(?:群文件|群文件区|群里的文件|群内文件|这个文件|那个文件)|(?:群文件|群文件区|群里的文件|群内文件).{0,36}(?:下载|保存|取下来|拿下来)/i.test(value)
}

export function hasExplicitGroupRequestListIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value || isCapabilityOrUsageQuestion(value, '入群申请|加群申请|进群申请')) return false
    if (/(?:谁|哪个人|什么人).{0,20}(?:通过|同意|拒绝|处理).{0,20}(?:入群|加群|进群).{0,8}申请/i.test(value)) return false
    return /(?:看看|查看|列出|有哪些|有什么|谁|待处理|最近).{0,30}(?:入群|加群|进群).{0,8}申请|(?:入群|加群|进群).{0,8}申请.{0,30}(?:列表|有哪些|有什么|谁|待处理)/i.test(value)
}

export function hasExplicitWeatherIntent(text) {
    const value = getPrimaryUserInstruction(text)
    if (!value || isCapabilityOrUsageQuestion(value, '天气查询|查天气|天气工具')) return false
    return /(?:查|查询|看看|看下|告诉我|预报).{0,20}(?:天气|气温|温度|降雨|台风|空气质量)/i.test(value)
        || /(?:天气|气温|温度|降雨|台风|空气质量|穿衣).{0,24}(?:怎么样|如何|多少|几度|会不会|有没有|吗|嘛|么|预报|情况)/i.test(value)
        || /(?:今天|明天|后天|周末|未来.{0,4}天|[\u4e00-\u9fa5]{2,12}).{0,12}(?:天气|气温|温度|降雨|下雨|台风|空气质量|穿衣)(?:[。！!？?\s]*$)/i.test(value)
}

export function detectToolIntentFamilies(text, options = {}) {
    const value = getPrimaryUserInstruction(text)
    const urls = Array.isArray(options.urls) ? options.urls : extractUrls(value)
    const families = new Set()
    if (!value) return families

    const add = (condition, family) => {
        if (condition) families.add(family)
    }
    const hasImages = options.hasImages === true
    const hasRecentImages = options.hasRecentImages === true
    const localFileHint = !/https?:\/\//i.test(value)
        && /(?:\/|\.\.?\/|[\w@+.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|txt|log|py|sh|toml|ini|conf|cfg|xml|html|css|vue|svelte|go|rs|java|kt|c|cc|cpp|h|hpp|sql|db|sqlite|bin)\b|源码|代码|脚本|插件|目录)/i.test(value)

    add(hasExplicitWebFetchIntent(value, urls), 'web_fetch')
    add(hasExplicitWebSearchIntent(value), 'web_search')
    add(hasExplicitFileSendIntent(value), 'file_send')
    add(hasExplicitFileDownloadIntent(value, { hasImages }), 'file_download')
    add(hasExplicitGroupFileListIntent(value), 'group_file_list')
    add(hasExplicitGroupFileDownloadIntent(value), 'group_file_download')
    add(hasExplicitLocalFileMutationIntent(value), 'local_file_mutation')
    add(urls.length === 0 && (hasExplicitShellIntent(value) || hasExplicitLocalFileReadIntent(value) || hasExplicitLocalFileDiscoveryIntent(value)
        || (localFileHint && /(?:瞅|读|看|找|列|检查|分析|打开)/i.test(value))), 'local_file')
    add(hasExplicitDrawIntent(value, { hasImages, hasRecentImages }), 'draw')
    add(hasExplicitUserProfileUpdateIntent(value), 'profile_update')
    add(hasExplicitMemorySearchIntent(value), 'memory')
    add(hasExplicitGroupChatDigestIntent(value), 'group_digest')
    add(!hasExplicitFileSendIntent(value) && (hasExplicitGroupChatContextIntent(value) || hasGroupChatContextQuestion(value)), 'group_context')
    add(Boolean(parseGroupSendRequest(value)), 'group_send')
    add(Boolean(parseGroupLeaveRequest(value)), 'group_leave')
    add(hasExplicitWeatherIntent(value), 'weather')
    add(/(?:系统信息|服务器信息|主机信息|运行状态|磁盘|内存|CPU|负载|进程|服务状态|系统时间|当前时间|现在几点|几点了)/i.test(value), 'system')
    add(/(?:这个人是谁|这人是谁|他是谁|她是谁|@.{0,12}是谁|外号|绰号|群里.{0,12}叫|谁(?:被)?叫|称呼记录|群内称呼)/i.test(value), 'member_alias')
    add(hasExplicitGroupRequestListIntent(value), 'group_request_list')
    add(['group_mute', 'group_whole_mute', 'group_kick', 'group_set_card', 'group_set_title', 'group_essence', 'group_request_handle']
        .some(name => hasExplicitGroupAdminIntent(name, value)), 'group_admin')
    return families
}

export function selectToolCandidates(enabledTools = [], text = '', options = {}) {
    const enabled = new Set(Array.isArray(enabledTools) ? enabledTools : [])
    const families = detectToolIntentFamilies(text, options)
    const selected = new Set()
    const add = names => names.forEach(name => enabled.has(name) && selected.add(name))

    if (options.allowContinuation === true && isContinuationToolInstruction(text)) {
        add(Array.isArray(options.continuationTools) ? options.continuationTools : [])
    }
    if (families.has('weather')) add(['weather'])
    if (families.has('web_search')) add(['web_search', 'web_fetch'])
    if (families.has('web_fetch')) add(['web_fetch'])
    if (families.has('system')) add(['system_info', 'shell_exec', 'shell_session'])
    if (families.has('local_file')) add(['shell_exec'])
    if (families.has('local_file_mutation')) add(['config_manage', 'shell_exec'])
    if (families.has('file_send')) add(['file_send', 'shell_exec'])
    if (families.has('file_download')) add(['file_download'])
    if (families.has('group_file_list')) add(['group_file_list'])
    if (families.has('group_file_download')) add(['group_file_list', 'group_file_download'])
    if (families.has('draw')) add(['draw_image'])
    if (families.has('profile_update')) add(['user_profile_update'])
    if (families.has('memory')) add(['memory_search'])
    if (families.has('group_digest')) add(['group_chat_digest'])
    if (families.has('group_context')) add(['group_chat_context'])
    if (families.has('group_send')) add(['group_send_message'])
    if (families.has('group_leave')) add(['group_leave'])
    if (families.has('member_alias')) add(['group_member_aliases', 'group_member_resolve', 'group_member_list'])
    if (families.has('group_request_list')) add(['group_request_list'])
    if (families.has('group_admin')) add([
        'group_mute', 'group_whole_mute', 'group_kick', 'group_set_card', 'group_set_title',
        'group_essence', 'group_member_list', 'group_member_resolve', 'group_request_list', 'group_request_handle'
    ])
    return {
        tools: [...selected],
        families: [...families],
        compound: families.size > 1,
        reason: selected.size > 0 ? `候选工具=${[...selected].join(', ')}` : '当前指令没有明显工具需求'
    }
}

function extractUrls(text) {
    return String(text || '').match(/https?:\/\/[^\s<>'"，。！？、]+/gi) || []
}

function hasModelPlannedLowRiskEvidence(call = {}, instruction = '', options = {}) {
    if (options.allowModelPlannedLowRisk !== true) return false
    if (call.name === 'shell_session') {
        const args = call.args || call.params || {}
        const action = String(args.action || '').trim().toLowerCase()
        if (['read', 'status'].includes(action)) {
            return /(?:输出|回显|结果|窗口|画面|终端内容|tmux内容|shell内容|看看|看一下|读取|查看|刷新|现在)/i.test(instruction)
        }
    }
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
        case 'config_manage': {
            const action = String(options.toolArgs?.action || '').trim()
            if (action === 'update') return hasExplicitLocalFileMutationIntent(text)
            return hasExplicitLocalFileReadIntent(text) || hasExplicitLocalFileMutationIntent(text)
        }
        case 'file_download':
            return hasExplicitFileDownloadIntent(text, options)
        case 'file_send':
            return hasExplicitFileSendIntent(text)
        case 'group_file_list':
            return hasExplicitGroupFileListIntent(text) || hasExplicitGroupFileDownloadIntent(text)
        case 'group_file_download':
            return hasExplicitGroupFileDownloadIntent(text)
        case 'web_fetch':
            return hasExplicitWebFetchIntent(text, options.candidateUrls || [])
        case 'web_search':
            return hasExplicitWebSearchIntent(text)
        case 'weather':
            return hasExplicitWeatherIntent(text)
        case 'system_info':
            return /(?:系统信息|服务器信息|主机信息|运行状态|磁盘|内存|CPU|负载|进程|服务状态|系统时间|当前时间|现在几点|几点了)/i.test(getPrimaryUserInstruction(text))
        case 'group_chat_context':
            return hasExplicitGroupChatContextIntent(text)
        case 'group_chat_digest':
            return hasExplicitGroupChatDigestIntent(text)
        case 'memory_search':
            return hasExplicitMemorySearchIntent(text)
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
        case 'group_request_list':
            return hasExplicitGroupRequestListIntent(text)
        default:
            return true
    }
}

export function filterToolCallsByIntent(toolCalls = [], text = '', options = {}) {
    const filtered = []
    const blocked = []
    const instruction = getPrimaryUserInstruction(text)
    const allowContinuation = options.allowContinuation === true
        && (isContinuationToolInstruction(instruction) || options.allowTaskContextContinuation === true)
    const continuationTools = new Set(Array.isArray(options.continuationTools) ? options.continuationTools : [])
    const sideEffectTools = new Set([
        'file_send', 'file_download', 'group_file_download', 'user_profile_update', 'group_send_message',
        'group_leave', 'group_mute', 'group_whole_mute', 'group_kick', 'group_set_card', 'group_set_title',
        'group_essence', 'group_request_handle'
    ])
    for (const call of toolCalls || []) {
        if (!call?.name) continue
        if (!isExplicitToolIntent(call.name, instruction, { ...options, toolArgs: call.args || call.params || {} })) {
            if (allowContinuation && continuationTools.has(call.name) && !sideEffectTools.has(call.name)) {
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
