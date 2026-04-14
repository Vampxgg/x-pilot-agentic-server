import type { SkillDefinition } from "../../core/types.js";

export const memorySearchSkill: SkillDefinition = {
  name: "memory-search",
  description: "Semantic search over agent memory for context retrieval",
  filePath: "__builtin__",
  content: `# Memory Search Skill

Search your memory store for relevant context before taking action.

## When to Search Memory

1. Before starting any new task -- check if you've handled similar tasks
2. When encountering an error -- check if you've seen this before
3. When the user references past interactions
4. When making decisions that could benefit from historical context

## Search Strategy

1. **Keyword Search**: Use specific terms from the current task
2. **Semantic Query**: Formulate a natural language question
3. **Temporal Query**: Search by date range for recent context
4. **Cross-reference**: Combine multiple search results

## Using Search Results

- Priority: Long-term memory > Recent daily logs > Working memory
- Confidence weighting: Assign higher weight to frequently reinforced facts
- Decay: Older memories get lower relevance unless reinforced
- Contradiction resolution: Newer facts override older ones

## Memory Hygiene

- Don't store duplicate information
- Consolidate similar facts into single entries
- Mark outdated information for review during consolidation
- Keep memory entries concise and actionable`,
};
