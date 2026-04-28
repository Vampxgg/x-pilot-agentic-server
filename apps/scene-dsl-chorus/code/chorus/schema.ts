/**
 * Chorus DSL Schema —— 独立镜像，与 react-code-rander/src/runtime/dsl/schema.ts 手动对齐。
 * 禁止 import apps/interactive-tutorial-v2/code/dsl。
 */

import { z } from "zod";

export const expressionSchema = z.object({ expr: z.string().min(1) });
export type Expression = z.infer<typeof expressionSchema>;

export interface UINode {
  type: string;
  props?: Record<string, unknown>;
  slots?: Record<string, UINode[]>;
  children?: UINode[];
  events?: Record<string, string>;
  if?: Expression;
  key?: string;
}

export const uiNodeSchema: z.ZodType<UINode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    slots: z.record(z.string(), z.array(uiNodeSchema)).optional(),
    children: z.array(uiNodeSchema).optional(),
    events: z.record(z.string(), z.string()).optional(),
    if: expressionSchema.optional(),
    key: z.string().optional(),
  }),
);

export const actionOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_context"), path: z.string().min(1), value: z.unknown() }),
  z.object({ type: z.literal("navigate"), to: z.string().min(1) }),
  z.object({
    type: z.literal("emit"),
    event: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("api_call"),
    url: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
    body: z.unknown().optional(),
    onSuccess: z.string().optional(),
    onError: z.string().optional(),
  }),
  z.object({
    type: z.literal("custom_widget"),
    target: z.string().min(1),
    method: z.string().min(1),
    args: z.array(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("compute_step"),
    provider: z.string().min(1),
    description: z.string().optional(),
  }),
]);

export type ActionOp = z.infer<typeof actionOpSchema>;

export const actionSchema = z.union([
  actionOpSchema,
  z.object({ type: z.literal("compound"), ops: z.array(actionOpSchema).min(1) }),
]);

export type Action = z.infer<typeof actionSchema>;

export const transitionSchema = z.object({
  from: z.string().min(1),
  action: z.string().min(1),
  to: z.string().min(1),
  condition: expressionSchema.optional(),
});

export type Transition = z.infer<typeof transitionSchema>;

export const tickSchema = z.object({
  intervalMs: z.number().int().positive().max(1000).default(50),
  action: z.string().min(1),
  autoStart: z.boolean().default(false),
  runningPath: z.string().min(1).default("running"),
});

export const sceneSchema = z.object({
  title: z.string().optional(),
  intent: z.string().optional(),
  ui: uiNodeSchema,
  on: z.record(z.string(), z.string()).optional(),
});

export type Scene = z.infer<typeof sceneSchema>;

export const appMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  shell: z
    .object({
      layout: z.enum(["centered", "full", "plain", "workspace"]).default("centered"),
      header: z
        .union([
          z.boolean(),
          z.object({
            brand: z
              .union([
                z.boolean(),
                z.object({
                  show: z.boolean().default(true),
                  text: z.string().optional(),
                  subtitle: z.string().optional(),
                  icon: z.string().optional(),
                }).partial(),
              ])
              .optional(),
            progress: z
              .union([
                z.boolean(),
                z.object({
                  show: z.boolean().default(true),
                  value: z.string().optional(),
                  label: z.string().optional(),
                }).partial(),
              ])
              .optional(),
          }).partial(),
        ])
        .optional(),
      maxWidth: z.union([z.enum(["narrow", "normal", "wide", "full"]), z.string()]).optional(),
      background: z
        .enum(["theme", "plain", "mesh", "tech", "paper", "dark", "none"])
        .default("theme")
        .optional(),
      padding: z.enum(["none", "sm", "md", "lg"]).default("lg").optional(),
    })
    .optional(),
  theme: z
    .object({
      preset: z
        .enum(["edu-light", "tech-blue", "notion-warm", "industrial", "kid-vivid", "academic", "minimal"])
        .default("edu-light"),
      tokens: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export const contextDefSchema = z.object({
  schema: z.record(z.string(), z.unknown()).optional(),
  initial: z.record(z.string(), z.unknown()).default({}),
});

export const flowSchema = z.object({
  initial: z.string().min(1),
  completion: z.string().optional(),
});

export const dslSchema = z.object({
  version: z.union([z.literal("1.0"), z.literal("1.1")]),
  app: appMetaSchema,
  context: contextDefSchema,
  scenes: z.record(z.string(), sceneSchema).refine((s) => Object.keys(s).length > 0, {
    message: "scenes 不能为空",
  }),
  actions: z.record(z.string(), actionSchema).default({}),
  transitions: z.array(transitionSchema).default([]),
  flow: flowSchema,
  tick: tickSchema.optional(),
  computed: z
    .record(z.string(), z.object({ provider: z.string().min(1), description: z.string().optional() }))
    .optional(),
});

export type Dsl = z.infer<typeof dslSchema>;

export interface DslValidationError {
  path: string;
  message: string;
  code?: string;
}

export interface DslValidationResult {
  valid: boolean;
  data?: Dsl;
  errors: DslValidationError[];
}

export function parseDsl(input: unknown): DslValidationResult {
  const result = dslSchema.safeParse(input);
  if (result.success) return { valid: true, data: result.data, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map((iss) => ({
      path: iss.path.join("."),
      message: iss.message,
      code: iss.code,
    })),
  };
}
