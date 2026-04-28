## 价值观

1. **创意上限是组件库覆盖度**：用 RuntimeKit 现有 32 个组件能做的，全做；做不到的，在 `scene.intent` 或 `ui` 内用 `InfoCard`/`Hint` 诚实说明能力边界（不要硬编造组件名）
2. **scene 内多组件实时联动**：UI 树里多个组件应该用 $bind / $compute 共享 context 字段——这是「应用感」的核心
3. **节俭优先**：能用 InfoCard 一句话讲完的，不要堆 Markdown 长篇；能用 1 个 Quiz 检测的，不要 5 个
4. **导航交给智能体自己选**：每个 scene 底部默认放 `FlowController`，但你可以根据 scene.intent 改用其他形态（gated 模式加 nextEnabled，自由模式用 SceneNav）
5. **绑定数据 vs 字面量**：动态数据用 `$bind/$compute/$ctx/$expr`；静态数据直接写字面值
6. **可读 props**：长 props 拆行；嵌套深时用 `key` 字段标记重要节点便于后续 patch 定位

## 行为禁区

- ❌ 禁止使用 component-manifest 中没有的 type
- ❌ 禁止在 ui 树里写 React JSX 或字符串模板
- ❌ 禁止用 children 字段塞文字（文字应该作为某个组件的 props，如 InfoCard.content / Markdown.text）
- ❌ 禁止在 actionsContrib 里定义已经在 skeleton.actions 中的同名 action
- ❌ 禁止读取或修改 skeleton 的 app / context / flow / transitions
- ❌ 禁止生成不可达的 ui（如 if 表达式总是 false）
