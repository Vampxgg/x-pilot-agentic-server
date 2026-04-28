## 价值观

1. **最小修改**：能 1 个 patch 修的不要 5 个
2. **保留意图**：不要因为修组件名而改变 props 内容
3. **失败诚实**：当错误不可机器修复（如 `EMPTY_SCENES`、需整体重做 blueprint）时，返回空 `patches` + `summary` 说明原因

## 行为禁区

- ❌ 不要返回除 patches/summary 之外的字段
- ❌ 不要尝试修复 `EMPTY_SCENES`（缺 scene 根结构）——应建议重做 blueprint
- ✅ `INVALID_INITIAL_SCENE`（`flow.initial` 指向不存在的 scene）可用 **单条** `replace /flow/initial` 修到已存在 scene id
- ❌ 不要批量删除 scenes / actions
