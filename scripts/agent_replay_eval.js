global.logger = global.logger || { info() {}, warn() {}, error() {}, debug() {} }

const {
    filterToolCallsByIntent,
    hasExplicitFileSendIntent,
    hasExplicitLocalFileDiscoveryIntent,
    hasExplicitLocalFileMutationIntent,
    hasExplicitLocalFileReadIntent,
    hasExplicitUserProfileUpdateIntent,
    hasGroupChatContextQuestion,
    parseExplicitLocalFileReadRequest,
    parseGroupSendRequest,
    parseNamedGroupChatContextRequest,
    parseRecentGroupChatFollowupRequest,
    hasExplicitDrawIntent
} = await import('../utils/tool_intent.js')
const { isExpiredGroupContextImageUrl, isGroupContextImageQuestion } = await import('../utils/group_context_images.js')
const { isPlanOnlyResponse, sanitizeModelOutput } = await import('../utils/model_output.js')

const incidents = [
    {
        id: 'read-relative-source-file',
        input: '#c读一下sendImage.js里 constructor 的 name',
        pass: text => hasExplicitLocalFileReadIntent(text)
    },
    {
        id: 'relay-message-to-named-group',
        input: '#c帮我给龟龟教那个群带个话，内容是"测试"',
        pass: text => {
            const request = parseGroupSendRequest(text)
            return request?.target === '龟龟教' && request?.message === '测试'
        }
    },
    {
        id: 'discover-and-send-local-plugin',
        input: '#c诺亚帮我看下plugins/example目录下是不是有个叫who are you的插件，如果有，帮我发出来到群里并且给我一份这个插件的使用方法',
        pass: text => hasExplicitLocalFileDiscoveryIntent(text)
            && hasExplicitFileSendIntent(text)
            && !hasGroupChatContextQuestion(text)
    },
    {
        id: 'upload-natural-plugin-name',
        input: '#c不是，我的意思是把who are you插件上传到群里',
        pass: text => hasExplicitFileSendIntent(text) && !hasGroupChatContextQuestion(text)
    },
    {
        id: 'absolute-config-file-priority',
        input: '#c看看/root/Yunzai/config/config/group.yaml里710024443的配置',
        pass: text => parseExplicitLocalFileReadRequest(text)?.path === '/root/Yunzai/config/config/group.yaml'
    },
    {
        id: 'config-edit-not-file-send',
        input: '#c把“[无用插件]发送图片”加入710024443群配置的disable',
        pass: text => hasExplicitLocalFileMutationIntent(text) && !hasExplicitFileSendIntent(text)
    },
    {
        id: 'profile-question-not-update',
        input: '#c我的个人档案有写我的居住城市吗？',
        pass: text => !hasExplicitUserProfileUpdateIntent(text)
    },
    {
        id: 'code-image-word-not-vision',
        input: "dsc: '发送随机图片'",
        pass: text => !isGroupContextImageQuestion(text)
    },
    {
        id: 'git-record-not-group-context',
        input: '#c看最近16条git变更记录',
        pass: text => !hasGroupChatContextQuestion(text)
    },
    {
        id: 'named-group-cross-context',
        input: '#c你看看名字叫「【】」的群最近聊了些啥',
        pass: text => parseNamedGroupChatContextRequest(text)?.query === '【】'
    },
    {
        id: 'named-group-referential-followup',
        input: '#c我在括号那个群还说了些啥',
        pass: text => {
            const request = parseRecentGroupChatFollowupRequest(text, {
                scope: 'specific_group',
                query: '【】',
                limit: 120,
                hours: 3
            }, '956753394')
            return request?.query === '【】' && request.user_id === '956753394' && request.hours === 3
        }
    },
    {
        id: 'bootanimation-not-draw-intent',
        input: '#uc我以前自己做安卓的启动动画bootanimation.zip，这个使用压缩算法就没效果了',
        pass: text => !hasExplicitDrawIntent(text)
    }
]

let passed = 0
const failures = []
for (const incident of incidents) {
    if (incident.pass(incident.input)) {
        passed++
        console.log(`✓ replay ${incident.id}`)
    } else {
        failures.push(incident.id)
        console.error(`✗ replay ${incident.id}: ${incident.input}`)
    }
}

const guardedConfig = filterToolCallsByIntent([{
    name: 'config_manage',
    args: {
        action: 'update',
        path: '/root/Yunzai/config/config/group.yaml',
        key_path: '710024443.disable',
        operation: 'append',
        value: '[无用插件]发送图片'
    }
}], '#c把“[无用插件]发送图片”写到/root/Yunzai/config/config/group.yaml里710024443的disable里面')
if (guardedConfig.tools.length === 1) {
    passed++
    console.log('✓ replay config-update-security-guard')
} else {
    failures.push('config-update-security-guard')
    console.error('✗ replay config-update-security-guard')
}

const staleUrlSkipped = isExpiredGroupContextImageUrl(
    'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=expired',
    '2026-07-26 14:00:00',
    Date.parse('2026-07-26T14:10:01Z')
)
if (staleUrlSkipped) {
    passed++
    console.log('✓ replay stale-qq-image-url')
} else {
    failures.push('stale-qq-image-url')
    console.error('✗ replay stale-qq-image-url')
}

const sanitized = sanitizeModelOutput('Analysis:\n先调用工具读取文件\n\nFinal Answer:\n实际字段是 image')
if (sanitized === '实际字段是 image' && isPlanOnlyResponse('【工具规划】先读取文件')) {
    passed++
    console.log('✓ replay internal-plan-sanitization')
} else {
    failures.push('internal-plan-sanitization')
    console.error(`✗ replay internal-plan-sanitization: ${sanitized}`)
}

console.log(`\nAgent replay eval: ${passed}/${passed + failures.length} passed`)
if (failures.length > 0) process.exit(1)
