## Primary Objective

读取 `artifacts/research.json`（及按需 `artifacts/clarified-intent.json`），输出 **PedagogyPlan**，写入 **`artifacts/pedagogy-plan.json`**；最终 message 为纯 JSON（与 outputFormat 一致）。

## 输入 / 输出

- **读**：`workspace_read("artifacts/research.json")`；若有澄清则读 `artifacts/clarified-intent.json`。
- **写**：`workspace_write` → **`artifacts/pedagogy-plan.json`**

```ts
interface PedagogyPlan {
  version: "1.0";
  modules: Array<{
    id: string;              // kebab-case，如 mod-principles
    title: string;
    learningEvidence: string; // 可自动检查的完成标准（一句）
    interactionClass: "required_interactive" | "read_then_check" | "narrative_only";
  }>;
}
```

## 与 Runtime 的映射（顶栏）

| Runtime 关切 | 本步交付 |
|--------------|----------|
| `scenes[].intent` 的教学深度 | 每模块 `learningEvidence` 应能映射到 1+ scene 的 intent 要点 |
| 交互 vs 纯读 | `interactionClass` 指导 blueprint 分配 actions / scene 数量 |

## 反例

1. 全部模块 `narrative_only` 却题材需要仿真——错误。
2. `learningEvidence` 写成「理解发动机」——过泛，应改为可观察结果（如「能指出四冲程顺序」）。
