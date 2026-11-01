import assert from "node:assert/strict";
import { test } from "node:test";

import { findSimilarModel, modelNameSimilarity } from "../src/model-match.js";

test("same family with different quant matches when format is identical", () => {
    const moss = modelNameSimilarity("moss_image_sft_bf16.safetensors", "moss_image_sft_int8.safetensors");
    assert.equal(moss.ok, true);
    assert.ok(moss.score >= 0.5);
    const krea = modelNameSimilarity("krea2_turbo_fp8.safetensors", "krea2_turbo.safetensors");
    assert.equal(krea.ok, true);
    const qwen = modelNameSimilarity("qwen_image_2.1_turbo_int8_convrot.safetensors", "qwen_image_2.1_turbo_int8.safetensors");
    assert.equal(qwen.ok, true);
});

test("different formats never match", () => {
    const result = modelNameSimilarity("moss_image_sft_bf16.safetensors", "moss_image_sft_int8.gguf");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "format");
});

test("different components or qualifiers never match", () => {
    assert.equal(modelNameSimilarity("minimax_h3_audio_vae_fp32.safetensors", "minimax_h3_vae_fp32.safetensors").ok, false);
    assert.equal(modelNameSimilarity("moss_image_sft_bf16.safetensors", "moss_image_vae.safetensors").ok, false);
    assert.equal(modelNameSimilarity("moss_image_sft_bf16.safetensors", "moss_video_sft_bf16.safetensors").ok, false);
    assert.equal(modelNameSimilarity("qwen_image_2.1_turbo.safetensors", "qwen_3_4b.safetensors").ok, false);
});

test("findSimilarModel prefers the highest score and refuses ambiguous ties", () => {
    const best = findSimilarModel("moss_image_sft_bf16.safetensors", ["moss_image_sft_int8.safetensors", "moss_alt_8step.safetensors", "qwen_3_4b.safetensors"]);
    assert.equal(best.file, "moss_image_sft_int8.safetensors");
    const ambiguous = findSimilarModel("moss_image_sft_bf16.safetensors", ["moss_image_sft_x.safetensors", "moss_image_sft_y.safetensors"]);
    assert.equal(ambiguous.file, "");
    assert.equal(ambiguous.ambiguous, true);
});

test("does not cross model sizes or turbo/raw variants", () => {
    assert.equal(findSimilarModel("qwen3vl_4b_fp8_scaled.safetensors", ["qwen3vl_8b_bf16.safetensors"]).file, "");
    assert.equal(findSimilarModel("krea2_turbo_fp8_scaled.safetensors", ["krea2_raw_fp8_scaled.safetensors"]).file, "");
    assert.equal(findSimilarModel("qwen3vl_4b_fp8_scaled.safetensors", ["qwen3vl_4b_bf16.safetensors"]).file, "qwen3vl_4b_bf16.safetensors");
    assert.equal(findSimilarModel("qwen_image_2.1_turbo_int8_convrot.safetensors", ["z_image_turbo_int8_convrot.safetensors"]).file, "");
});

test("Qwen Image 2.1 VAE never fuzzy matches legacy Qwen or Wan VAEs", () => {
    const qwen21 = "qwen_image_2.1_vae_bf16.safetensors";
    for (const legacy of ["qwen_image_vae.safetensors", "wan_2.1_vae.safetensors", "wan2.1_vae.safetensors"]) {
        assert.equal(findSimilarModel(qwen21, [legacy]).file, "");
        assert.equal(findSimilarModel(legacy, [qwen21]).file, "");
    }
});

test("Qwen Image 2.1 VAE still matches same-generation quantization", () => {
    const match = findSimilarModel("qwen_image_2.1_vae_bf16.safetensors", ["qwen_image_2.1_vae_fp16.safetensors"]);
    assert.equal(match.file, "qwen_image_2.1_vae_fp16.safetensors");
});
