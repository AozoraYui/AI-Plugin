import { clearSkillCatalogCache, formatSkillGuidance, getSkillCatalogPath, loadSkillCatalog, selectRelevantSkills } from '../utils/skill_runtime.js'

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

clearSkillCatalogCache()
const catalog = await loadSkillCatalog({ force: true })
check('技能目录可加载', catalog.length >= 4, `path=${getSkillCatalogPath()}, count=${catalog.length}`)
check('技能元数据完整', catalog.every(skill => skill.name && skill.description && skill.body), '存在缺少元数据或正文的技能')

const maintenance = await selectRelevantSkills('请读取这个插件的代码，修改配置后运行测试', {
    enabledTools: ['workspace_read', 'workspace_patch', 'workspace_verify', 'config_manage', 'shell_exec']
})
check('代码维护请求命中项目维护技能', maintenance.some(skill => skill.name === 'project-maintenance'))

const research = await selectRelevantSkills('搜索最新版本并打开官方来源核实', {
    enabledTools: ['web_search', 'web_fetch']
})
check('联网核验请求命中网页研究技能', research.some(skill => skill.name === 'web-research'))

const image = await selectRelevantSkills('用这张参考图生成一张新的图片', {
    enabledTools: ['draw_image', 'vision_relay'],
    hasImages: true
})
check('图片请求命中图像工作流技能', image.some(skill => skill.name === 'image-workflow'))

const memory = await selectRelevantSkills('请记住我的长期偏好并更新个人档案', {
    enabledTools: ['memory_search', 'user_profile_update']
})
check('记忆请求命中记忆整理技能', memory.some(skill => skill.name === 'memory-curation'))

const unrelated = await selectRelevantSkills('你好，今天过得怎么样？', { enabledTools: ['weather'] })
check('普通寒暄不会误加载技能', unrelated.length === 0, JSON.stringify(unrelated.map(skill => skill.name)))
const allToolsGreeting = await selectRelevantSkills('你好，今天过得怎么样？', { enabledTools: catalog.flatMap(skill => skill.tools) })
check('工具重叠不能单独触发技能', allToolsGreeting.length === 0, JSON.stringify(allToolsGreeting.map(skill => skill.name)))

const guidance = formatSkillGuidance(maintenance)
check('技能指导包含权限边界', guidance.includes('不授予任何工具权限'))
check('技能指导不会无限增长', guidance.length <= 12000)

if (failures.length > 0) {
    console.error(`Skill eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Skill eval: ${passed} passed, 0 failed`)
}
