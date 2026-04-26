# AI-Plugin

> 基于 Yunzai-Bot 的模块化 AI 插件，支持 Gemini 系列模型，提供对话、作图、记忆管理等功能。

## ✨ 功能特性

### 💬 智能对话
- 支持多轮对话，自动维护对话历史
- 支持图片识别与多模态理解
- 支持合并转发消息展开
- 单次对话模式（不污染上下文）
- 自动请求体优化，防止 413 错误

### 🎨 AI 作图
- 丰富的作图预设（风格转换、角色生成等）
- 支持自定义指令作图（#bnn）
- 支持多图片输入（最多 16 张）
- 支持 @某人 获取头像作图
- 图片自动压缩优化

### 📚 记忆管理
- 全量/增量记忆锚点创建
- 每日定时摘要（23:50）
- 记忆档案列表查看
- 支持导出个人/全部记忆
- SQLite 数据库存储

### ⚙️ 管理功能
- 多模型供应商支持
- 模型自动测试与状态管理
- 白名单/黑名单权限控制
- 思考过程显示开关
- 模型启用/禁用管理

## 📦 部署方法

### 前置要求
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) 已正常运行
- Node.js >= 18
- 已配置好 Gemini API 或兼容的第三方 API

### 安装步骤

1. **克隆插件到 plugins 目录**
```bash
cd /path/to/Yunzai-Bot/plugins
git clone https://github.com/AozoraYui/AI-Plugin.git
```

2. **安装依赖**
```bash
cd AI-Plugin
pnpm install
# 或 npm install
```

3. **配置 API**

在 `data/ai_assistant/` 目录下创建或编辑以下文件：

**`models_config.yaml`** - 模型供应商配置
```yaml
- id: provider1
  name: 供应商名称
  base_url: https://api.example.com/v1
  api_key: your-api-key-here
  model_groups:
    default:
      chat_models:
        - gemini-2.0-flash
      draw_models:
        - gemini-2.0-flash
    pro:
      chat_models:
        - gemini-2.5-pro
    gemini3:
      chat_models:
        - gemini-3-pro
```

**`gemini_presets.yaml`** - 作图预设配置
```yaml
- command: 二次元
  name: 二次元风格
  prompt: "请将图片转换为二次元动漫风格"
  aliases:
    - anime
    - 动漫
- command: 像素
  name: 像素风格
  prompt: "请将图片转换为像素艺术风格"
```

4. **重启 Yunzai-Bot**
```bash
# 重启后插件会自动加载
```

## 📖 使用指南

### 对话功能
| 指令 | 说明 |
|------|------|
| `#gm [内容]` | 与 AI 对话（默认模型） |
| `#progm [内容]` | 使用 Pro 模型对话 |
| `#3gm [内容]` | 使用 Gemini 3 模型对话 |
| `#sgm [内容]` / `#singlegm [内容]` | 单次对话模式（不保存历史） |
| `#导出[AI名称]记忆` | 导出你的对话记忆 |
| `#导出[AI名称]全部记忆` | 导出所有用户记忆（管理员） |

### 作图功能
| 指令 | 说明 |
|------|------|
| `#bnn [内容]` | 自定义作图（默认模型） |
| `#3bnn [内容]` | 使用 Gemini 3 模型作图 |
| `#画图预设列表` | 查看作图预设列表 |
| `#画图预设列表pro` | 查看详细预设列表 |
| `#画图预设重载` | 重载预设配置 |
| `#画图预设添加 [指令] [名称]` | 添加新预设 |
| `#画图预设删除 [指令]` | 删除预设 |
| `#添加预设别名 [指令]` | 为预设添加别名 |
| `#删除预设别名 [指令]` | 删除预设别名 |

### 记忆管理
| 指令 | 说明 |
|------|------|
| `#gemini创建全量锚点` | 创建完整记忆锚点 |
| `#gemini创建增量锚点` | 创建增量记忆锚点 |
| `#gemini总结记忆列表` | 查看记忆总结列表 |

### 管理功能（管理员）
| 指令 | 说明 |
|------|------|
| `#gemini模型列表` | 查看当前模型配置 |
| `#gemini模型测试` | 测试所有模型可用性 |
| `#gemini启用全部模型` | 启用所有模型 |
| `#gemini禁用 [模型ID]` | 禁用指定模型 |
| `#gemini启用 [模型ID]` | 启用指定模型 |
| `#gemini状态` | 查看插件运行状态 |
| `#gemini权限模式 whitelist/blacklist` | 切换权限模式 |
| `#gemini权限添加/删除 白名单用户 [用户ID]` | 添加/删除白名单用户 |
| `#gemini权限添加/删除 黑名单用户 [用户ID]` | 添加/删除黑名单用户 |
| `#gemini权限添加/删除 白名单群 [群号]` | 添加/删除白名单群 |
| `#gemini权限添加/删除 黑名单群 [群号]` | 添加/删除黑名单群 |
| `#gemini权限列表` | 查看当前权限配置 |
| `#gemini思考开启/关闭` | 开启/关闭思考过程显示 |
| `#gemini帮助` | 显示帮助信息 |

## 🗂️ 目录结构

```
AI-Plugin/
├── apps/                    # 功能模块
│   ├── chat.js             # 对话功能
│   ├── image.js            # 作图功能
│   ├── memory.js           # 记忆管理
│   ├── management.js       # 管理功能
│   └── help.js             # 帮助信息
├── client/                  # API 客户端
│   └── GeminiClient.js     # Gemini API 封装
├── model/                   # 数据模型
│   └── conversation.js     # 对话历史管理
├── utils/                   # 工具函数
│   ├── config.js           # 配置管理
│   ├── session.js          # 会话管理
│   ├── access.js           # 权限控制
│   └── common.js           # 通用工具
├── index.js                 # 入口文件
└── package.json             # 依赖配置
```

## ⚙️ 配置说明

### 数据文件
所有配置和数据文件存储在 `data/ai_assistant/` 目录：

| 文件 | 说明 |
|------|------|
| `models_config.yaml` | 模型供应商配置 |
| `model_status.json` | 模型测试状态 |
| `disabled_models.json` | 禁用的模型列表 |
| `gemini_presets.yaml` | 作图预设配置 |
| `access_control.yaml` | 权限控制配置 |
| `ai_plugin.db` | SQLite 数据库（对话历史、记忆锚点、摘要缓存） |

### 数据存储
- **SQLite 数据库**：主要存储引擎，存储对话历史、记忆锚点、摘要缓存
- **JSON/YAML 文件**：配置文件（模型配置、权限配置、预设等）
- **Redis**：可选缓存层，加速对话读取

### 模型组说明
- **default**: 默认模型组，适用于日常对话
- **pro**: Pro 模型组，更高质量的回复
- **gemini3**: Gemini 3 模型组，最新模型

## 📝 注意事项

1. 首次使用请先运行 `#gemini模型测试` 确认可用模型
2. 作图预设需要自行配置 prompt 内容
3. 记忆锚点创建会消耗 API 调用，建议定期执行
4. 白名单模式下，只有白名单内的用户/群可以使用
5. 黑名单模式下，黑名单内的用户/群无法使用

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

ISC
