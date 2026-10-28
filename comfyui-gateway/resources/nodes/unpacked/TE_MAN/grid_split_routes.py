import json
import os
import re
import uuid
from pathlib import Path

from aiohttp import web
import folder_paths
from PIL import Image, ImageOps

try:
    from server import PromptServer
except Exception:  # pragma: no cover
    PromptServer = None

try:
    from .grid_split_core import split_image_to_grid_input_files
except ImportError:
    from grid_split_core import split_image_to_grid_input_files


def _json_error(message, status=400):
    return web.json_response({"success": False, "error": str(message)}, status=status)


def _resolve_ui_image_path(image_info):
    image_type = str(image_info.get("type") or "output")
    base_dir = folder_paths.get_directory_by_type(image_type)
    if not base_dir:
        raise ValueError(f"不支持的图片目录类型: {image_type}")

    filename = str(image_info.get("filename") or "").strip()
    if not filename:
        raise ValueError("缺少图片文件名")

    subfolder = str(image_info.get("subfolder") or "").strip()
    full_dir = os.path.join(base_dir, subfolder) if subfolder else base_dir
    full_dir = os.path.abspath(full_dir)
    base_dir_abs = os.path.abspath(base_dir)
    if os.path.commonpath([full_dir, base_dir_abs]) != base_dir_abs:
        raise ValueError("非法的图片子目录")

    full_path = os.path.abspath(os.path.join(full_dir, filename))
    if os.path.commonpath([full_path, base_dir_abs]) != base_dir_abs:
        raise ValueError("非法的图片路径")

    if not os.path.isfile(full_path):
        raise FileNotFoundError(f"图片不存在: {filename}")

    return full_path


def _sanitize_filename_stem(value):
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "_", value or "").strip("._-")
    return normalized or "te_crop"


def crop_image_to_input_file(image_info, crop):
    source_path = _resolve_ui_image_path(image_info)
    input_dir = folder_paths.get_input_directory()
    source_stem = _sanitize_filename_stem(Path(source_path).stem)

    x = int(crop.get("x", 0) or 0)
    y = int(crop.get("y", 0) or 0)
    width = int(crop.get("width", 0) or 0)
    height = int(crop.get("height", 0) or 0)
    if width <= 0 or height <= 0:
        raise ValueError("裁切尺寸必须大于 0")

    with Image.open(source_path) as source_image:
        prepared = ImageOps.exif_transpose(source_image).convert("RGBA")
        image_width, image_height = prepared.size
        if image_width <= 0 or image_height <= 0:
            raise ValueError("当前图片尺寸无效，无法裁切。")

        left = max(0, min(x, image_width - 1))
        top = max(0, min(y, image_height - 1))
        right = max(left + 1, min(x + width, image_width))
        bottom = max(top + 1, min(y + height, image_height))

        crop_image = prepared.crop((left, top, right, bottom)).convert("RGB")
        filename = f"{source_stem}_crop_{uuid.uuid4().hex[:10]}.png"
        save_path = os.path.join(input_dir, filename)
        crop_image.save(save_path, format="PNG")
        return {
            "filename": filename,
            "subfolder": "",
            "type": "input",
        }


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    @PromptServer.instance.routes.post("/te_image/grid_split")
    async def te_image_grid_split(request):
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return _json_error("请求体不是有效的 JSON。", status=400)
        except Exception as exc:
            return _json_error(f"读取请求体失败: {exc}", status=400)

        try:
            image_info = payload.get("image_info") or {}
            rows = int(payload.get("rows", 0) or 0)
            cols = int(payload.get("cols", 0) or 0)
            images = split_image_to_grid_input_files(image_info=image_info, rows=rows, cols=cols)
            return web.json_response({"success": True, "images": images})
        except FileNotFoundError as exc:
            return _json_error(exc, status=404)
        except ValueError as exc:
            return _json_error(exc, status=400)
        except Exception as exc:
            return _json_error(exc, status=500)

    @PromptServer.instance.routes.post("/te_image/crop_image")
    async def te_image_crop_image(request):
        try:
            payload = await request.json()
        except json.JSONDecodeError:
            return _json_error("请求体不是有效的 JSON。", status=400)
        except Exception as exc:
            return _json_error(f"读取请求体失败: {exc}", status=400)

        try:
            image_info = payload.get("image_info") or {}
            crop = payload.get("crop") or {}
            image = crop_image_to_input_file(image_info=image_info, crop=crop)
            return web.json_response({"success": True, "image": image})
        except FileNotFoundError as exc:
            return _json_error(exc, status=404)
        except ValueError as exc:
            return _json_error(exc, status=400)
        except Exception as exc:
            return _json_error(exc, status=500)
