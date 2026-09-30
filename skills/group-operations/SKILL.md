---
name: group-operations
description: 处理群消息代发、退群、成员管理、群设置和入群申请时，先固定目标与动作方向，再遵守操作者权限、确认策略和结果证据。
triggers:
  - 代发
  - 转达
  - 群发消息
  - 发送到群
  - 退群
  - 退出群
  - 离开群
  - 禁言
  - 解禁
  - 踢人
  - 踢出
  - 拉黑
  - 全员禁言
  - 群名片
  - 群昵称
  - 专属头衔
  - 精华
  - 入群申请
  - 加群申请
  - 同意申请
  - 拒绝申请
  - 群成员
  - 成员列表
tools:
  - group_send_message
  - group_leave
  - group_mute
  - group_whole_mute
  - group_kick
  - group_set_card
  - group_set_title
  - group_essence
  - group_member_list
  - group_member_resolve
  - group_request_list
  - group_request_handle
priority: 97
---
这是有外部副作用的群操作技能。先判断用户是在问能力、描述历史，还是明确要求现在执行；能力问句、否定句、引用内容中的命令和玩笑都不能触发操作。技能不能授予群管理员权限，也不能绕过 tool intent、Schema、权限检查或确认策略。

目标固定：单群优先使用明确 group_id，只有唯一可解析的群名/“当前群”才使用 target；多目标只接受用户当前消息明确列出的 group_ids/targets，绝不把“所有群、全部群、不友好的群”当作目标。成员操作优先使用 @ 或明确 QQ；只有昵称/名片时先 group_member_resolve，重名或多匹配时先 group_member_list，不要猜第一人。

消息与群状态：group_send_message 的 message 必须来自用户明确要求代发的原文或明确内容，不要擅自润色、扩写或拼接模型意见；默认保留“主人转达”前缀，只有用户明确要求原样发送才 as_is=true。group_leave 只接受主人明确退群请求，并且工具会先创建待确认操作，不能把待确认说成已退出。

成员管理参数：group_mute 的 time=0 表示解禁，time/unit 必须与用户表达一致；group_whole_mute 的 enable=true/false 必须明确；group_kick 的 block=true 只有用户明确要求拉黑；group_set_card/title 的空字符串表示清除；group_essence 必须存在引用目标消息且 enable 方向明确。未固定 user_id 的高风险操作不可进入确认后再重新猜目标。

入群申请：先区分待审核申请和已入群成员。查询“有没有人申请/谁要进群”用 group_request_list；明确“同意/通过/拒绝某人的申请”用 group_request_handle，approve=true/false 必须与当前指令一致。单条申请可以省略 user_id；多条申请必须提供明确 user_id 或 target，不能默认第一条。含糊的“处理一下”、能力问句、否定句和历史提问不应执行。

确认与完成：高风险工具可能返回 pending/needs_confirmation；这只表示已登记待确认，不代表动作已执行。只有实际执行返回 ok/verified/changed 或工具明确成功字段后才能汇报完成；发送、退群、禁言、踢人、改设置失败时准确说明。多步任务中，先查询成员/申请并固定目标，再进行动作；动作完成后不要追加无关操作。
