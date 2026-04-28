/**
 * mergeDslFragments —— 合并 fan-out 阶段产生的 scene 片段为完整 dsl。
 *
 * 输入：
 *  - skeleton：blueprint-architect 输出的 dsl.skeleton.json（含 app/context/flow/transitions/actions 与空 scenes）
 *  - sceneFragments：[{ id, scene: Scene, actionsContrib?: Record<string,Action> }] —— scene-author fan-out 的输出数组
 *
 * 输出：完整 dsl（含所有 scenes 与累积的 actions）。
 *
 * 合并规则：
 *  - skeleton.scenes 是空对象时直接全用 fragments 填；非空时 fragment 优先（最后写赢）
 *  - actions 累积合并（fragment.actionsContrib 优先于 skeleton.actions）
 *  - actions 同 id 冲突时报警（保留先到的，丢弃后到的）
 */

import type { Dsl, Scene, Action } from "./schema.js";
import { logger } from "../../../../src/utils/logger.js";

export interface SceneFragment {
  id: string;
  scene: Scene;
  /** 该 scene 内部需要的额外 action（可选，scene-author 可顺手定义） */
  actionsContrib?: Record<string, Action>;
}

export function mergeDslFragments(
  skeleton: Partial<Dsl> & { app: Dsl["app"]; context: Dsl["context"]; flow: Dsl["flow"] },
  sceneFragments: SceneFragment[],
): Dsl {
  const scenes: Record<string, Scene> = { ...(skeleton.scenes ?? {}) };
  const actions: Record<string, Action> = { ...(skeleton.actions ?? {}) };

  for (const frag of sceneFragments) {
    if (!frag?.id || !frag.scene) {
      logger.warn(`[merger] 跳过非法 scene fragment: ${JSON.stringify(frag)}`);
      continue;
    }
    if (scenes[frag.id]) {
      logger.info(`[merger] 覆盖 skeleton.scenes.${frag.id}（fragment 优先）`);
    }
    scenes[frag.id] = frag.scene;

    if (frag.actionsContrib) {
      for (const [aid, action] of Object.entries(frag.actionsContrib)) {
        if (actions[aid]) {
          logger.warn(`[merger] action "${aid}" 重复定义，保留先到的`);
          continue;
        }
        actions[aid] = action;
      }
    }
  }

  return {
    version: skeleton.version ?? "1.1",
    app: skeleton.app,
    context: skeleton.context,
    scenes,
    actions,
    transitions: skeleton.transitions ?? [],
    flow: skeleton.flow,
    ...(skeleton.tick ? { tick: skeleton.tick } : {}),
    ...(skeleton.computed ? { computed: skeleton.computed } : {}),
  };
}
