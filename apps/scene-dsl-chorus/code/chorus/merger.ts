/**
 * Chorus —— 合并 fan-out 的 scene 片段为完整 DSL。
 */

import type { Dsl, Scene, Action } from "./schema.js";
import { logger } from "../../../../src/utils/logger.js";

export interface SceneFragment {
  id: string;
  scene: Scene;
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
      logger.warn(`[chorus merger] 跳过非法 scene fragment: ${JSON.stringify(frag)}`);
      continue;
    }
    if (scenes[frag.id]) {
      logger.info(`[chorus merger] 覆盖 skeleton.scenes.${frag.id}`);
    }
    scenes[frag.id] = frag.scene;

    if (frag.actionsContrib) {
      for (const [aid, action] of Object.entries(frag.actionsContrib)) {
        if (actions[aid]) {
          logger.warn(`[chorus merger] action "${aid}" 重复定义，保留先到的`);
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
