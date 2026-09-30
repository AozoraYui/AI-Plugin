---
name: project-maintenance
description: 处理代码、配置、插件更新和故障修复时，优先建立事实、采用最小修改，并用确定性验证确认结果。
triggers:
  - 代码
  - 源码
  - 文件
  - 配置
  - 修复
  - 修改
  - 更新插件
  - git
  - 测试
  - 仓库
tools:
  - workspace_list
  - workspace_search
  - workspace_read
  - workspace_patch
  - workspace_verify
  - config_manage
  - shell_exec
priority: 95
---
工作流：先读取真实文件和相关调用点，再形成最小修改；代码修改后先执行 workspace_verify，再运行最相关的测试或构建。不要把读取、写入、静态校验和完整测试混为一谈。

判断标准：先确认当前分支、工作区状态、配置生效路径和失败阶段。修改应解决通用机制，不为单条日志或单个用户写硬编码。变更前后关注权限边界、回归风险、密钥和用户数据泄露。

完成声明：只有工具结果和成功标准共同提供证据时，才能说修复或更新完成；静态校验通过只能说明语法和 diff 检查通过。发现测试失败时，准确报告失败阶段，不要用模型推测代替命令结果。
