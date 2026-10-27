import assert from "node:assert/strict";
import test from "node:test";

import { uploadImages } from "../src/uploads.js";

test("multi-reference uploads with the same original name get distinct ComfyUI names", async () => {
  const calls = [];
  const comfy = {
    uploadImage: async (buffer, filename, mimeType) => {
      calls.push({ filename, mimeType, byte: buffer[0] });
      return { name: filename, subfolder: "", type: "input" };
    },
  };
  const files = [
    { originalname: "AI_.png", mimetype: "image/png", buffer: Buffer.from([1]) },
    { originalname: "AI_.png", mimetype: "image/png", buffer: Buffer.from([2]) },
  ];
  const uploaded = await uploadImages(comfy, files);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].filename, calls[1].filename);
  assert.deepEqual(uploaded.map((item) => item.name), calls.map((item) => item.filename));
  assert.deepEqual(calls.map((item) => item.byte), [1, 2]);
});
