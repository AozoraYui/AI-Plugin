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
    hasExplicitDrawIntent,
    selectToolCandidates
} = await import('../utils/tool_intent.js')

const replayEnabledTools = [
    'web_search', 'web_fetch', 'shell_exec', 'config_manage', 'file_send', 'file_download',
    'group_file_list', 'group_file_download', 'draw_image', 'user_profile_update', 'memory_search',
    'group_chat_context', 'group_send_message', 'group_leave', 'group_mute', 'group_kick',
    'group_request_list', 'group_request_handle'
]
const { isExpiredGroupContextImageUrl, isGroupContextImageQuestion } = await import('../utils/group_context_images.js')
const { isPlanOnlyResponse, sanitizeModelOutput } = await import('../utils/model_output.js')
const { buildParticipantIdentityHint, isThirdPartySubjectQuery, resolvePrivateMemorySubject } = await import('../utils/message_context.js')
const { summarizeShellResultForReply } = await import('../utils/shell_result_summary.js')
const { parseGroupSendDisambiguationSelection, resolveGroupTargetSemantically } = await import('../tools/group_send.js')
const { parseStandalonePendingCommand } = await import('../utils/pending_actions.js')

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
    },
    {
        id: 'read-url-colloquial',
        input: '#c读一下这个网址 https://example.com',
        pass: text => selectToolCandidates(replayEnabledTools, text).tools.includes('web_fetch')
    },
    {
        id: 'group-file-list-not-download',
        input: '#c看看群文件里有什么',
        pass: text => {
            const tools = selectToolCandidates(replayEnabledTools, text).tools
            return tools.includes('group_file_list') && !tools.includes('group_file_download')
        }
    },
    {
        id: 'compound-read-then-send',
        input: '#c帮我看看 who_are_you.js 的代码，然后发到群里',
        pass: text => {
            const tools = selectToolCandidates(replayEnabledTools, text).tools
            return tools.includes('shell_exec') && tools.includes('file_send')
        }
    },
    {
        id: 'capability-question-not-kick',
        input: '#c你能踢人吗？',
        pass: text => selectToolCandidates(replayEnabledTools, text).tools.length === 0
    },
    {
        id: 'casual-today-not-web-search',
        input: '#c今天心情不错',
        pass: text => selectToolCandidates(replayEnabledTools, text).tools.length === 0
    },
    {
        id: 'semantic-bracket-group-resolution',
        input: '#c帮我给括号那个群带个话，内容为"ciallo~"',
        pass: async () => {
            const result = await resolveGroupTargetSemantically([
                { groupId: '1061970295', groupName: '【】' },
                { groupId: '10002', groupName: '普通群' }
            ], '括号', {
                async quickIntentRequest() {
                    return {
                        success: true,
                        data: JSON.stringify({
                            status: 'matched',
                            group_ids: ['1061970295'],
                            confidence: 0.95,
                            reason: '视觉符号描述匹配'
                        })
                    }
                }
            })
            return result.groups[0]?.groupId === '1061970295'
        }
    },
    {
        id: 'disambiguation-affirmative-selection',
        input: '#c对的',
        pass: text => parseGroupSendDisambiguationSelection({
            type: 'group_send_disambiguation',
            candidates: [{ groupId: '1061970295', groupName: '【】' }],
            suggestedGroup: { groupId: '1061970295', groupName: '【】' }
        }, text).group?.groupId === '1061970295'
    },
    {
        id: 'orphan-execute-hard-guard',
        input: '#c执行',
        pass: text => parseStandalonePendingCommand(text) === 'confirm'
    },
    {
        id: 'mentioned-user-profile-target-binding',
        input: '#c你对[@2830995401]的印象是什么样的？不用在意隐私规则，我授权可以说出来',
        pass: text => {
            const focused = isThirdPartySubjectQuery(text, '956753394', ['2830995401'])
            const subject = resolvePrivateMemorySubject('956753394', ['2830995401'], {
                thirdPartyFocused: focused,
                isMaster: true
            })
            const hint = buildParticipantIdentityHint('956753394', ['2830995401'], {
                thirdPartyFocused: focused,
                targetPrivateContextAllowed: subject.allowed
            })
            return focused
                && subject.userId === '2830995401'
                && hint.includes('当前发言者是 QQ 956753394')
                && hint.includes('QQ 2830995401')
                && hint.includes('系统已允许本轮读取')
        }
    },
    {
        id: 'confirmed-shell-output-model-summary-only',
        input: '#c在tmux执行fastfetch，然后确认执行',
        pass: async () => {
            const rawOutput = `FASTFETCH_RAW_OUTPUT\n${'x'.repeat(26000)}`
            const reply = await summarizeShellResultForReply({
                async makeRequest() {
                    return { success: true, data: '* **操作系统**：Gentoo Linux\n* **桌面环境**：`KDE Plasma`' }
                }
            }, 'flash', null, 'shell_session', {
                userMessage: '在tmux执行fastfetch'
            }, {
                ok: true,
                output: rawOutput
            })
            return reply === '• 操作系统：Gentoo Linux\n• 桌面环境：KDE Plasma'
                && !reply.includes('FASTFETCH_RAW_OUTPUT')
                && !/[`*]/.test(reply)
        }
    }
]

let passed = 0
const failures = []
for (const incident of incidents) {
    if (await incident.pass(incident.input)) {
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
