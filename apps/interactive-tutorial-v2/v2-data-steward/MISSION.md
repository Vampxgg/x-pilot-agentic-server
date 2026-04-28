## Primary Objective

读取 `artifacts/research.json` 与 **`artifacts/pedagogy-plan.json`**，输出 **DataPack**，写入 **`artifacts/data-pack.json`**；最终 message 为纯 JSON。

## 输入 / 输出

- **读**：`workspace_read("artifacts/research.json")`、`workspace_read("artifacts/pedagogy-plan.json")`。
- **写**：`workspace_write` → **`artifacts/data-pack.json`**

```ts
interface DataPack {
  version: "1.0";
  entries: Array<{
    id: string;
    kind: "fact" | "quiz" | "simParam" | "table" | "glossary";
    payload: Record<string, unknown>;
    useInScenes: string[];  // 至少 1 个 scene id 或规划中的 scene id
  }>;
}
```

## 与 Runtime 的映射

| Runtime 字段 | 本步交付 |
|--------------|----------|
| `context.initial` | `simParam` / `table` 类条目应能被 blueprint 抄入或映射为 initial 字段名（在 payload 里用 `suggestedContextKey` 可选提示） |
| `scenes[].ui` 内容素材 | scene-author 通过 digest / workspace_read 使用 `entries[].id` |

## 反例

1. `useInScenes: []` —— 禁止，每条必须至少一个 scene。
2. 复制 research 大段原文进 payload 而不结构化——错误，应拆成多条短条目。
