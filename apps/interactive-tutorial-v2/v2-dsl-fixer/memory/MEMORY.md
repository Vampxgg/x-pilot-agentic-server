# dsl-fixer Memory（v2）

## 常见 unknown component 修复（typo → 正确名）

- `infocard` → `InfoCard`
- `quiz` → `Quiz`
- `slider` → `Slider`
- `button` / `Button` → 没有这个，应改为 `FlowController` 或包到 PlayController/Selection 内
- `text` → `Markdown`
- `paragraph` → `Markdown`
- `card` → `InfoCard`

## 常见 expression 错误

- 圆括号不匹配 → 补全
- 用 `&&`/`||` 不识别 → 检查是否被转义
- 用 `?:` 三元 → 没问题，ExpressionVM 支持
- 写了 `=>` lambda → 不支持，改写
