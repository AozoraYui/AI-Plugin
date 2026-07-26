import { getPrimaryUserInstruction, hasExplicitLocalFileMutationIntent, parseNamedGroupChatContextRequest } from './tool_intent.js'

export function hasImplicitRecentTaskReference(text = '') {
    const value = getPrimaryUserInstruction(text)
        .replace(/^#[A-Za-z0-9_]+\s*/i, '')
        .trim()
    if (!value) return false
    if (/^(?:任务|agent).{0,12}(?:状态|进度|取消|停止|终止)/i.test(value)) return false
    if (parseNamedGroupChatContextRequest(value)) return false

    return hasExplicitLocalFileMutationIntent(value)
        || /^(?:接着|继续|再|重新|还有|刚才|刚刚|上次|前面)[，,。\s]*/i.test(value)
        || /^(?:这样吧|那|那么|然后|顺便|另外)[，,。\s]*(?:再|继续|接着|看|看看|查|查看|读|读取|列|列出|总结|整理|分析|输出|换成|改成|多看|多查|更多|完整|详细)/i.test(value)
        || /(?:再|继续|接着|重新|顺便|另外|还有|刚才|刚刚|上次|前面|更多|完整|详细|展开|换成|改成|多看|多查).{0,30}(?:看|看看|查|查看|读|读取|列|列出|总结|整理|分析|输出|结果|记录|条)/i.test(value)
        || /(?:看|看看|查|查看|读|读取|列|列出|总结|整理|分析).{0,30}(?:更多|完整|详细|展开|前|后|最近|上次|刚才|刚刚|\d{1,4}\s*条|[一二两三四五六七八九十百]{1,4}\s*条)/i.test(value)
        || /(?:(?:括号|方括号)(?:那个|这个)?|刚才查的|刚才看的|前面查的|前面看的|刚才那个|前面那个|上个|那个|这个|该)\s*(?:的)?群.{0,30}(?:还|又|另外|其他|其它|别的|更多|说|发|聊|消息|发言)/i.test(value)
}

export function getRecentTaskToolArgs(task, toolName) {
    const steps = Array.isArray(task?.steps) ? task.steps : []
    for (let index = steps.length - 1; index >= 0; index--) {
        const step = steps[index]
        if (step?.toolName === toolName && step.toolArgs && typeof step.toolArgs === 'object') return step.toolArgs
    }
    return null
}
