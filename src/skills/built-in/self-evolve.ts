import type { SkillDefinition } from "../../core/types.js";

export const selfEvolveSkill: SkillDefinition = {
  name: "self-evolve",
  description: "Generate evolution proposals for agent improvement",
  filePath: "__builtin__",
  content: `# Self-Evolution Skill

Analyze accumulated experience and propose improvements to your own capabilities.

## Evolution Types

1. **soul_update**: Modify MUTABLE sections of SOUL.md
   - Adjust communication style based on user feedback patterns
   - Refine decision-making heuristics
   - Never modify CORE sections

2. **new_skill**: Propose a new reusable skill
   - When a multi-step pattern is detected 3+ times
   - Create a structured .md file in the skills/ directory
   - Include clear trigger conditions and execution steps

3. **config_change**: Propose agent.config.yaml updates
   - Adjust model selection based on task complexity patterns
   - Tune concurrency/timeout based on observed performance
   - Modify heartbeat frequency based on workload

4. **workflow_adjustment**: Propose changes to execution strategy
   - New tool combinations for recurring task types
   - Improved sub-agent delegation patterns
   - Better error recovery strategies

## Proposal Format

Each proposal must include:
- type: One of the evolution types above
- description: What to change and why
- diff: The specific textual change (before/after)
- confidence: 0-1 how confident you are this helps
- evidence: References to specific past experiences

## Governance Rules

- Proposals with confidence < 0.7 are auto-rejected
- soul_update proposals ALWAYS require human approval
- new_skill proposals are auto-approved if confidence >= 0.85
- config_change proposals require approval if they affect model selection

## Safety Constraints

- Never propose removing safety constraints
- Never propose increasing token limits beyond 2x current
- Never propose disabling evolution approval gates
- Preserve agent identity core values`,
};
