import "dotenv/config";
import { createModel } from "../src/llm/provider.ts";

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main() {
  const modelName = getArg("--model") ?? "gemini-2.5-flash";
  const prompt = getArg("--prompt") ?? "Reply exactly: VERTEX_OK";

  console.log(`[vertex-test] provider=vertex model=${modelName}`);

  const model = createModel({
    provider: "vertex",
    model: modelName,
    temperature: 0,
  });

  const result = await model.invoke(prompt);
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);

  console.log("[vertex-test] response:");
  console.log(content);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[vertex-test] failed:");
  console.error(message);
  process.exit(1);
});
