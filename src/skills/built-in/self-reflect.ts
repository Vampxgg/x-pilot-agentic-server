import type { SkillDefinition } from "../../core/types.js";

export const selfReflectSkill: SkillDefinition = {
  name: "self-reflect",
  description: "Structured self-reflection after task completion",
  filePath: "__builtin__",
  content: `# Self-Reflection Skill

After completing a task, perform structured self-reflection:

## Reflection Protocol

1. **Outcome Assessment**: Did the task succeed? Rate confidence 0-1.
2. **Process Review**: What steps were taken? Were they optimal?
3. **Error Analysis**: What went wrong? Root cause?
4. **Efficiency**: Could fewer steps achieve the same result?
5. **Tool Usage**: Were the right tools used? Any misuse?
6. **Lessons Learned**: Extract 1-3 actionable lessons.
7. **Improvement Proposals**: Suggest specific improvements for next time.

## Output Format

Produce a structured reflection:
- summary: Brief overview of what happened
- lessonsLearned: Array of specific takeaways
- suggestedImprovements: Array of actionable changes
- confidence: 0-1 score of reflection quality

## When to Reflect
- After every completed task (mandatory)
- After tool failures (immediate mini-reflection)
- After sub-agent task aggregation

## Quality Gate
Only record lessons with confidence > 0.6 to long-term memory.
Discard trivial observations that don't generalize.`,
};
