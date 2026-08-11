# 未尽

个人 AI 秘书 PWA。通过“秘书”会话把混乱原话整理为可编辑的依赖、估时和周一至周日排程，用户确认后才写入正式计划。

当前使用 DeepSeek V4 Pro。没有 API Key 或请求失败时会保留原话并显示错误，不会回退到标点拆分。

数据、项目档案、计时和周报保存在当前浏览器的 localStorage；API Key 不进入 Git 或公开导出。

## 本地运行

在本目录运行：

```powershell
python -m http.server 8080
```

打开 `http://localhost:8080`。

## GitHub Pages

推送仓库后，在 GitHub 仓库的 Settings -> Pages 中选择 `main` 分支根目录。

不要把 DeepSeek Key 写进任何源码文件。首次在 App 的“设置”页填写即可。
