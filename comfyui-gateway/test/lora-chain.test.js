import assert from "node:assert/strict";
import { test } from "node:test";

import { applyLoraChain } from "../src/lora-chain.js";

function workflow() {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: "base.safetensors", weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: "clip.safetensors", type: "qwen_image" } },
    4: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    5: { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["2", 0] } },
  };
}

test("inserts an ordered LoRA chain after the primary model loader", () => {
  const source = workflow();
  const result = applyLoraChain(source, {
    loras: [
      { name: "Z-Image人物\\zit刘亦菲.safetensors", strength: 0.8 },
      { name: "Kook_Zimage_如梦似幻.safetensors", strength: 0.6 },
    ],
  });
  assert.equal(result.applied.length, 2);
  const [first, second] = result.applied.map((item) => item.id);
  assert.equal(result.workflow[first].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(result.workflow[first].inputs.model, ["1", 0]);
  assert.deepEqual(result.workflow[second].inputs.model, [first, 0]);
  assert.deepEqual(result.workflow["4"].inputs.model, [second, 0]);
  assert.deepEqual(result.workflow["5"].inputs.clip, ["2", 0]);
  assert.equal(result.workflow[first].inputs.strength_model, 0.8);
  assert.equal(result.workflow[second].inputs.strength_model, 0.6);
  assert.deepEqual(source["4"].inputs.model, ["1", 0]);
});

test("no loras leaves the workflow untouched", () => {
  const source = workflow();
  const result = applyLoraChain(source, { loras: [] });
  assert.equal(result.workflow, source);
  assert.equal(result.applied.length, 0);
});

test("rejects invalid or filtered LoRA names", () => {
  assert.throws(
    () => applyLoraChain(workflow(), { loras: [{ name: "missing.safetensors", strength: 1 }] }, { available: ["other.safetensors"] }),
    /LoRA 不存在/,
  );
  assert.throws(
    () => applyLoraChain(workflow(), { loras: [{ name: "Krea2-style.safetensors", strength: 1 }] }, { filter: "Z-Image|ZIT|Kook_Zimage" }),
    /不适用于当前模型/,
  );
});

test("requires a recognizable model loader", () => {
  const source = { 4: { class_type: "KSampler", inputs: { model: ["2", 0] } } };
  assert.throws(() => applyLoraChain(source, { loras: [{ name: "x.safetensors", strength: 1 }] }), /没有可识别的模型加载器/);
});
