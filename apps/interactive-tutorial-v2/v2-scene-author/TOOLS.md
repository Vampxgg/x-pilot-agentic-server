本 agent 不需要工具。基于 prompt + 上游 JSON 推理直接输出 SceneFragment。

如果上游素材里没有所需图片/视频 url，使用占位 `https://placehold.co/600x400` 之类，让前端先显示骨架（Image 组件会兜底显示 ImageOff icon）。
