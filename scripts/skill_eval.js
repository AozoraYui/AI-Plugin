import { clearSkillCatalogCache, formatSkillGuidance, getSkillCatalogPath, loadSkillCatalog, selectRelevantSkills } from '../utils/skill_runtime.js'

globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
globalThis.Config = globalThis.Config || {}
const { toolRegistry } = await import('../tools/index.js')

const failures = []
let passed = 0

function check(name, condition, detail = '') {
    if (condition) {
        passed++
        console.log(`PASS ${name}`)
        return
    }
    failures.push({ name, detail })
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

async function selectNames(instruction, enabledTools, options = {}) {
    const skills = await selectRelevantSkills(instruction, { enabledTools, ...options })
    return skills.map(skill => skill.name)
}

clearSkillCatalogCache()
const catalog = await loadSkillCatalog({ force: true })
const registeredTools = toolRegistry.getToolNames()
const declaredTools = [...new Set(catalog.flatMap(skill => skill.tools))]
check('技能目录可加载', catalog.length >= 8, `path=${getSkillCatalogPath()}, count=${catalog.length}`)
check('技能元数据完整', catalog.every(skill => skill.name && skill.description && skill.body), '存在缺少元数据或正文的技能')
check('技能引用的工具都已注册', declaredTools.every(name => registeredTools.includes(name)), JSON.stringify(declaredTools.filter(name => !registeredTools.includes(name))))
check('所有注册工具至少有一个 Skill 说明', registeredTools.every(name => declaredTools.includes(name)), JSON.stringify(registeredTools.filter(name => !declaredTools.includes(name))))

const maintenance = await selectNames('请读取这个插件的代码，修改配置后运行测试', [
    'workspace_survey', 'workspace_read', 'workspace_patch', 'workspace_verify', 'config_manage', 'shell_exec'
], { isMaster: true })
check('代码维护请求命中项目维护技能', maintenance.includes('project-maintenance'))

const research = await selectNames('搜索最新版本并打开官方来源核实', ['web_search', 'web_fetch'])
check('联网核验请求命中网页研究技能', research.includes('web-research'))
const researchSkill = catalog.find(skill => skill.name === 'web-research')
check('网页研究技能覆盖图片引用核查', researchSkill?.body.includes('图片/引用消息核查') && researchSkill.body.includes('视觉摘要只是待核查线索'))
check('网页研究技能锁定指定版本并要求完整来源', researchSkill?.body.includes('必须锁定这些范围') && researchSkill.body.includes('全部名单') && researchSkill.body.includes('不能用其他范围的部分结果回答'))

const weather = await selectNames('查一下深圳明天会不会下雨', ['weather'])
check('天气请求命中网页研究技能', weather.includes('web-research'))

const userLookup = await selectNames('主人查一下 QQ号为3837933930的人在哪些群', ['qq_user_lookup'], { isMaster: true })
check('QQ 用户来源查询命中专用技能', userLookup.includes('user-lookup'))
const nonMasterUserLookup = await selectNames('查一下 QQ号为3837933930的人在哪些群', ['qq_user_lookup'], { isMaster: false })
check('非主人不会加载 QQ 用户来源技能', !nonMasterUserLookup.includes('user-lookup'))

const image = await selectNames('用这张参考图生成一张新的图片', ['draw_image', 'vision_relay'], { hasImages: true })
check('图片请求命中图像工作流技能', image.includes('image-workflow'))

const imageQuestion = await selectNames('请描述这张图里有什么，不要生成图片', ['draw_image', 'vision_relay'], { hasImages: true })
check('看图请求仍命中图像理解技能', imageQuestion.includes('image-workflow'))
const imageSkill = catalog.find(skill => skill.name === 'image-workflow')
check('图像技能明确视觉证据边界', imageSkill?.body.includes('视觉证据') && imageSkill.body.includes('截图显示'))
check('图像技能禁止冒充执行和扩大成功结论', imageSkill?.body.includes('不得把“截图中的命令已经执行”改写成“我已经为你执行”') && imageSkill.body.includes('不得仅凭截图声称刷机、升级、部署、修复或任务最终成功'))
check('图像技能覆盖动漫角色真人化', imageSkill?.body.includes('真人化') && imageSkill.body.includes('不要当作 preset'))

const memory = await selectNames('请记住我的长期偏好并更新个人档案', ['memory_search', 'user_profile_update'])
check('记忆请求命中记忆整理技能', memory.includes('memory-curation'))

const groupContext = await selectNames('群里刚刚发生了什么，帮我看下前情', ['group_chat_context', 'group_chat_digest', 'group_member_aliases'])
check('群聊前情请求命中群上下文技能', groupContext.includes('group-context'))

const groupAction = await selectNames('同意这条入群申请', ['group_request_list', 'group_request_handle'])
check('群管理动作命中群操作技能', groupAction.includes('group-operations'))

const fileTransfer = await selectNames('把这个日志文件发给我', ['file_send', 'file_download', 'group_file_list', 'group_file_download'], { isMaster: true })
check('服务器文件发送请求命中文件媒体技能', fileTransfer.includes('file-media'))

const groupFile = await selectNames('列一下群文件并包括子文件夹', ['group_file_list', 'group_file_download'], { isMaster: true })
check('群文件请求命中文件媒体技能', groupFile.includes('file-media'))

const system = await selectNames('查看服务器 CPU、内存和磁盘状态', ['system_info', 'shell_exec', 'shell_session'], { isMaster: true })
check('服务器状态请求命中系统操作技能', system.includes('system-operations'))

const tmux = await selectNames('读取 ai-shell 的 tmux 输出', ['system_info', 'shell_exec', 'shell_session'], { isMaster: true })
check('持久 Shell 请求命中系统操作技能', tmux.includes('system-operations'))

const nonMasterAdminTool = await selectNames('查看服务器 CPU 和日志', ['shell_exec'], { isMaster: false })
check('非主人不会注入主人专用系统 Skill', !nonMasterAdminTool.includes('system-operations'))
const nonMasterFileTool = await selectNames('把这个日志文件发给我', ['file_send'], { isMaster: false })
check('非主人不会注入主人专用文件 Skill', !nonMasterFileTool.includes('file-media'))
const inaccessibleTool = await selectNames('把这个日志文件发给我', ['weather'], { isMaster: false })
check('无可用工具时不注入主人专用 Skill', inaccessibleTool.length === 0)

const unrelated = await selectNames('你好，今天过得怎么样？', ['weather'])
check('普通寒暄不会误加载技能', unrelated.length === 0, JSON.stringify(unrelated))
const allToolsGreeting = await selectNames('你好，今天过得怎么样？', registeredTools)
check('工具重叠不能单独触发技能', allToolsGreeting.length === 0, JSON.stringify(allToolsGreeting))

const guidance = formatSkillGuidance(catalog)
check('技能指导包含权限边界', guidance.includes('不授予任何工具权限'))
check('技能指导包含完成证据纪律', guidance.includes('完成证据') || guidance.includes('结果纪律'))
check('技能指导不会无限增长', guidance.length <= 12000)

if (failures.length > 0) {
    console.error(`Skill eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Skill eval: ${passed} passed, 0 failed`)
}
