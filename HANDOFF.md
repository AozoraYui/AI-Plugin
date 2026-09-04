# AI-Plugin Handoff For GPT-5.6 Sol

This handoff is for the next agent taking over development of `AI-Plugin`.

Current local repo:

```text
/home/yui/Documents/dev/yunzai-plugins/AI-Plugin
```

Current branch:

```text
main
```

Latest pushed commit at handoff:

```text
b459a97 feat: add contextual group digest routing
```

Remote:

```text
origin https://github.com/AozoraYui/AI-Plugin.git
```

Current worktree note:

```text
HANDOFF.md is intentionally untracked unless the user asks to commit it.
```

## User Intent And Preferences

The user is building a smarter Yunzai/TRSS AI bot plugin. They want the bot to feel closer to a real agent:

- Natural-language intent understanding, not a pile of rigid trigger words.
- Fast chat mode should be quick, but still share memory and tool behavior with normal chat.
- Sensitive operations such as group relay messages and remote group leave must stay strict and require confirmation.
- The bot should remember cross-mode context when possible.
- Token use can be somewhat high if it buys better reasoning, but token explosions must be controlled.
- Local-first privacy matters. User strongly prefers local storage and local vector database over cloud uploads.

When discussing design, the user likes direct engineering judgment and is comfortable with iterative implementation.

## High-Level Architecture

Important entry points:

```text
apps/chat.js              Normal #c/#pc/#uc chat entry, agent loop, tool planning, final reply
apps/fast_chat.js         Fast chat mode, group message capture and natural trigger replies
apps/management.js        #ai management commands, vector status/migration/rebuild commands
client/AiClient.js        Provider/model config, model dispatch, request handling
model/conversation.js     Per-user history, checkpoint loading/saving, auto summary counters
tools/registry.js         Tool metadata, LLM tool routing, compileToolPlan
utils/tool_intent.js      Lightweight intent helpers and safety filters
utils/database.js         SQLite schema and query helpers
utils/memory_context.js   Shared memory/profile/vector context loading
utils/vector_memory.js    Vector memory indexing, migration, retrieval, service lifecycle
scripts/vector_server.py  Local sentence-transformers + ChromaDB HTTP server
```

## Current Major Features

### Normal Chat

`apps/chat.js` handles command chat such as:

```text
#c ...
#pc ...
#uc ...
#sc ...
```

It now has:

- Main-model tool planning.
- Intent-model parameter compilation.
- Multi-round agent loop for follow-up tool calls.
- Agent task persistence in SQLite.
- Pending confirmation integration for sensitive operations.
- Shared user memory loading through `loadUserMemoryContext`.
- Automatic semantic memory retrieval when vector memory is enabled.

### Fast Chat

`apps/fast_chat.js` is the renamed former `noa_chat`.

Config key is now:

```yaml
enable_fast_chat: true
```

Old `enable_noa_chat` / `NOA_CHAT_*` compatibility was intentionally removed at user request. Trigger words such as `诺亚` / `noa` still remain as natural triggers.

Fast chat currently:

- Captures public group messages, including command messages, unless access rules block capture.
- Replies when natural trigger rules match.
- Loads recent group context.
- Loads user memory summary and user profile.
- Loads semantic vector memory if enabled.
- Routes tools for clear tool intents.
- Shares some recent normal-chat Agent task context for natural continuation.

### Memory Layers

The bot can see several memory/context layers:

- Per-user raw conversation history in SQLite.
- Full/incremental summaries.
- User profile in `user_profiles`.
- Group chat logs captured by fast chat.
- Local vector memory index, when enabled.
- Recent Agent task summaries, for continuation like "再看 32 条".

Important behavior:

- Normal `#c` chat saves user history unless single-shot mode is used.
- Fast chat also saves its exchange back to personal history.
- Fast chat quoting a normal chat reply includes the quoted text in `normalizedText`.
- User profile is global per user, not per group scene.

### Vector Memory

Config:

```yaml
enable_vector_memory: true
VECTOR_DB_DIR: data/chroma_db
VECTOR_SERVER_URL: http://127.0.0.1:9901
VECTOR_EMBEDDING_MODEL: shibing624/text2vec-base-chinese
```

Default vector DB directory was moved to:

```text
data/chroma_db
```

SQLite remains the source of truth. ChromaDB is a local retrieval index.

Management commands include:

```text
#ai向量状态
#ai向量迁移
#ai向量重建
```

Known vector history:

- Server has no discrete GPU; CPU embedding is expected and acceptable, just slower.
- Python dependencies are in `scripts/requirements.txt`.
- Prior failures included stale process on `127.0.0.1:9901`, closed fetch clients, and lone UTF-16 surrogate text. These have been addressed in recent commits.
- Full migration has successfully completed once on the server, producing around 140k vector documents.

## Recent Commits

```text
b459a97 feat: add contextual group digest routing
117d630 refactor: rename noa chat to fast chat
8d02f07 refactor: share chat memory context
d02922b feat: add agent task runtime
8fd8e5d feat: summarize oversized noa context in chunks
39f30bf fix: sanitize vector text before embedding
e2775af fix: cap noa final context size
98094dd fix: retry vector writes during migration
```

## Latest Changes In b459a97

This commit addresses two related problems:

1. Fast/normal chat needed a long-range group digest tool.
2. Tool routing was too eager and misread "最近 N 条 git 变更记录" as group chat context because of loose "最近 + 记录" matching.

### New Tool: `group_chat_digest`

New file:

```text
tools/group_chat_digest.js
```

Purpose:

- Summarize long time ranges of captured group chat.
- Avoid dumping huge raw group logs into final model context.
- Use internal pagination and batch summarization.

Good examples:

```text
诺亚总结一下群里最近几天聊了什么
#c总结一下所有群最近3天聊了什么
诺亚我不在的时候群里聊了什么
诺亚从我上次发言后群里都发生了什么
```

Scopes:

- Normal users: current group, or their own cross-group public messages.
- Master: current group, specific group, all groups.

Internals:

- Parses `today`, `yesterday`, recent hours/days, and `since_last_message`.
- `since_last_message` locates the trigger user's previous message in the current group and starts after it.
- Excludes the current trigger message.
- Caps range to 7 days / 168 hours and max 2000 logs.
- Batches roughly by 42k chars or 120 logs.
- Calls flash model for per-batch summaries, then merges.

Registration/docs touched:

```text
tools/index.js
tools/registry.js
README.md
apps/help.js
config_template/models_config.yaml
```

Database helpers added:

```text
utils/database.js
```

New helpers include:

- `countGroupMessageLogs(options)`
- `getGroupMessageLogsByTimeRange(options)`
- `getLastGroupMessageByUser(groupId, userId, options)`

### Smarter Routing

Relevant files:

```text
apps/chat.js
apps/fast_chat.js
utils/tool_intent.js
tools/registry.js
```

Key design:

- Hard pre-routing is now treated more like a high-confidence accelerator.
- Ambiguous requests should go to model planning instead of being captured by loose regex.
- "records/history/changes" is disambiguated by object:
  - `git`, `commit`, `plugin`, `repo`, `code changes` -> code repository / shell candidate.
  - `group`, `chat`, `messages`, `大家/他们说了什么` -> group context or group digest.

New helper:

```js
hasStrongGroupChatContextQuestion(text)
```

`preRouteToolIntent` now uses the strong group context helper for direct `group_chat_context` pre-routing. The older looser `hasGroupChatContextQuestion` remains useful for candidate recall and model planning, but is less likely to steal ambiguous non-chat requests.

Important sample behavior tested:

```text
#c看一下最近16条git变更记录
  shell candidate: true
  group context: false

#c这样吧，再看一下插件最近32条git变更记录
  shell candidate: true
  group context: false

#c他们刚才聊了啥
  group context: true

#c最近16条记录
  no direct shell/group assumption
```

### Recent Agent Task Context

Normal chat now injects a small "recent Agent task context" into tool planning when the current instruction looks like a natural continuation.

Examples:

```text
再看 32 条
接着查
换成 16 条
多看一点
```

This context is only for model planning. It is not a direct trigger by itself.

Safety:

- Only a low-risk/mostly read-only continuation tool set can be allowed by this context.
- It does not open a shortcut for:
  - `group_send_message`
  - `group_leave`
  - `draw_image`
  - `file_send`
  - `file_download`
  - group admin actions

Fast chat has a lighter version:

- It does not create Agent tasks.
- It can read recent Agent tasks created by normal chat.
- This helps bridge `#c` -> fast chat continuation.

## Sensitive Tools

### Group Send

Tool:

```text
group_send_message
```

Behavior:

- Master only.
- Supports explicit multiple targets.
- Open-ended "all groups" style sets are intentionally blocked.
- Creates pending confirmation first.
- User confirms with natural `#c确认...` style confirmation, using context and pending action state.

### Group Leave

Tool:

```text
group_leave
```

Behavior:

- Master only.
- Supports current group, group id, unique group name, or explicit multiple targets.
- Open-ended "all groups / 不友好的群 / 有问题那些群" should not compile directly.
- Creates pending confirmation first.
- Execution only after confirmation.

### Shell

Tool:

```text
shell_exec
shell_session
```

Important:

- Master only.
- `enable_shell_exec` / `enable_shell_session` must be enabled.
- Directory safety guard exists in `utils/shell_safety.js`.
- Read-only repository queries such as `git log` are safe candidates.
- Mutating commands such as `git pull` are guarded against wrong cwd.

## Config Notes

Important current config keys:

```yaml
enable_fast_chat: false
enable_vector_memory: false
enable_shell_exec: false
enable_shell_session: false
enable_file_transfer: false
enable_group_send: false
enable_group_leave: false
enable_group_admin: false
```

Fast chat key rename is complete:

```text
noa_chat -> fast_chat
enable_noa_chat -> enable_fast_chat
NOA_CHAT_* -> FAST_CHAT_*
```

No backward compatibility was kept, at user request.

Template config and README were updated for:

- Fast chat rename.
- Vector memory.
- Group digest behavior.
- Token-safe long group summaries.

The user also requested a complete runtime config written to:

```text
/home/yui/Documents/dev/yunzai-plugins/models.yaml
```

That happened earlier in the session, separate from repo template changes.

## Common Test Commands

Use the user's nvm Node path if plain `node` is not in PATH:

```bash
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check apps/chat.js
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check apps/fast_chat.js
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check utils/tool_intent.js
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check tools/registry.js
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check tools/group_chat_digest.js
/home/yui/.nvm/versions/node/v25.9.0/bin/node --check utils/database.js
git diff --check
```

Routing sanity snippet:

```bash
/home/yui/.nvm/versions/node/v25.9.0/bin/node --input-type=module - <<'NODE'
import {
  hasExplicitShellIntent,
  hasGroupChatContextQuestion,
  hasStrongGroupChatContextQuestion
} from './utils/tool_intent.js'

for (const text of [
  '#c看一下最近16条git变更记录',
  '#c这样吧，再看一下插件最近32条git变更记录',
  '#c他们刚才聊了啥',
  '#c最近16条记录'
]) {
  console.log(text, {
    shell: hasExplicitShellIntent(text),
    group: hasGroupChatContextQuestion(text),
    strong: hasStrongGroupChatContextQuestion(text)
  })
}
NODE
```

Expected:

```text
git change record requests -> shell true, group false
他们刚才聊了啥 -> group true
最近16条记录 -> no direct assumption
```

## Runtime Verification Ideas

After deploying to server:

1. Restart TRSS-Yunzai.
2. Confirm plugin loads with no syntax/runtime import errors.
3. Test vector status:

```text
#ai向量状态
```

4. Test normal chat repository routing:

```text
#c看一下最近16条git变更记录
#c这样吧，再看一下插件最近32条git变更记录
```

Expected:

- First should go to shell planning / `git log`.
- Second should not route to `group_chat_context`.
- If it follows the recent Agent task correctly, it should understand "再看" as continuation.

5. Test group short context:

```text
诺亚他们刚才聊了啥
```

Expected:

- Uses `group_chat_context`.

6. Test long group digest:

```text
诺亚总结一下群里最近几天聊了什么
诺亚我不在的时候群里聊了什么
```

Expected:

- Uses `group_chat_digest`.
- Does not inject huge raw logs into final model.

7. Test cross-mode continuation:

```text
#c看一下插件最近5条git变更记录
```

Then in fast chat:

```text
诺亚再看32条
```

Expected:

- Fast chat should load recent Agent task context and route as a continuation if shell is enabled and the user is master.

## Known Fragile Areas

### Natural Language Routing

The current system is deliberately hybrid:

- Rules for high-confidence or safety-sensitive cases.
- Main-model planning for ambiguous or context-dependent cases.
- Intent-model compilation for concrete tool args.

Avoid adding many narrow hardcoded trigger commands. If adding regex, prefer using it only for candidate recall or high-confidence pre-route.

### Token Budgets

Previously the bot hit extreme input sizes, including over 1M tokens. Current protections:

- Fast chat final context target cap.
- Section-level compaction.
- Group digest tool for long group summaries.
- Shell/file outputs paginated.
- Vector memory for semantic retrieval instead of dumping all history.

Still watch logs for:

```text
input token count exceeds maximum
Failed to parse request body as JSON
unexpected end of hex escape
```

### Unicode / Surrogate Text

QQ messages can contain malformed/lone surrogate sequences. Existing sanitizers:

- `stripLoneSurrogates` in fast chat.
- Vector text sanitization before embedding.
- `sanitizeText` in `group_chat_digest`.

If a new path sends raw QQ text to Python, sanitize first.

### Vector Service Process Lifecycle

Prior server issues:

- Port `9901` already in use by old python process.
- Existing service stuck and fetch client closed.
- Server not ready while model still loading.

If it happens again:

```bash
lsof -i :9901
kill -9 $(lsof -t -i :9901)
```

Then restart Yunzai and check:

```text
#ai向量状态
```

### Fast Chat vs Chat Split

The user feels these can be too split. Current bridging:

- Shared memory loader in `utils/memory_context.js`.
- Fast chat saves to personal history.
- Fast chat loads user profile and summaries.
- Fast chat can read recent normal-chat Agent task context.

Future improvement idea:

- Centralize tool planning between `chat.js` and `fast_chat.js` more deeply.
- Possibly create a shared `utils/tool_planner.js` instead of maintaining separate logic.

## Files Changed In Latest Commit

```text
README.md
apps/chat.js
apps/fast_chat.js
apps/help.js
config_template/models_config.yaml
tools/group_chat_digest.js
tools/index.js
tools/registry.js
utils/database.js
utils/tool_intent.js
```

## Do Not Accidentally Revert

Do not revert these intentional design choices:

- No old `noa_chat` config compatibility.
- Vector DB directory is `data/chroma_db`.
- Personal profile length limit was relaxed earlier.
- Sensitive group relay/leave operations require confirmation.
- Group digest exists to avoid token explosion for multi-day group summaries.
- Ambiguous "record/history/change" requests should not be pre-routed to group context.

## Suggested Next Work

Good next steps if user asks to continue improving "agent intelligence":

1. Extract shared tool planning utilities from `chat.js` and `fast_chat.js`.
2. Add lightweight regression tests for `utils/tool_intent.js`.
3. Add a debug command to inspect the last Agent task context used for planning.
4. Add a route-decision log summary visible to master, e.g. "why this tool was chosen".
5. Tune fast chat context compaction based on real server logs.

## Operational Notes

The server deploy path is usually:

```text
/root/Yunzai/plugins/AI-Plugin
```

The local development path is:

```text
/home/yui/Documents/dev/yunzai-plugins/AI-Plugin
```

User's shell is zsh. In this local session, plain `node` was not found, but the working Node path is:

```text
/home/yui/.nvm/versions/node/v25.9.0/bin/node
```

Do not assume server PATH is identical.

## Final State At Handoff

- Latest code was committed and pushed to `origin/main`.
- Syntax checks passed for the key modified JS files.
- `git diff --check` passed.
- `HANDOFF.md` itself is local and untracked unless the user asks to commit it.
