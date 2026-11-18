# YuE2 Instrumental Convert

ComfyUI custom node wrapping the official YuE2 instrumental conversion
(`convert_score`, Vocal -> Ins) from the YuE2-Official skills:

- Source: `YuE-official/skills/yue2-music/instrumental/scripts`
- License: Apache-2.0 (see LICENSE)
- No model weights or PyTorch calls; pure Python score conversion.

Node: `YuE2InstrumentalConvert` (`YuE2` category) takes an ABC string and
returns the converted ABC for `YuE2GenerateMusic`.
