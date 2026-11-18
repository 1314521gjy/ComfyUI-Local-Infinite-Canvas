import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PANORAMA_WIDTH = 5664
PANORAMA_HEIGHT = 2832
STRIP_WIDTH = 1536
STRIP_HEIGHT = 2816
WHITE_BAND = 384
MASK_EXPAND = 56
MASK_BLUR = 20

def load_rgb(path):
    with Image.open(path) as im:
        return im.convert("RGB")


def roll_half(im):
    arr = np.asarray(im)
    rolled = np.roll(arr, im.width // 2, axis=1)
    return Image.fromarray(rolled)


def unroll_half(im):
    arr = np.asarray(im)
    rolled = np.roll(arr, -(im.width // 2), axis=1)
    return Image.fromarray(rolled)


def strip_box(im):
    left = (im.width - STRIP_WIDTH) // 2
    top = (im.height - STRIP_HEIGHT) // 2
    return left, top, left + STRIP_WIDTH, top + STRIP_HEIGHT


def count_faces(path):
    try:
        import cv2
    except Exception:
        return None
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        return None
    im = load_rgb(path)
    scale = 2048.0 / im.width
    small = im.resize((2048, max(1, int(round(im.height * scale)))), Image.LANCZOS)
    gray = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2GRAY)
    min_side = max(24, int(round(gray.shape[0] * 0.03)))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side))
    return int(len(faces))


def edge_metrics(path):
    im = load_rgb(path)
    arr = np.asarray(im).astype(np.float32)
    h, w = arr.shape[:2]
    left = arr[:, 0, :]
    right = arr[:, w - 1, :]
    edge_mae = float(np.mean(np.abs(left - right)))
    lum = arr @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    luma_delta = float(abs(float(lum[:, 0].mean()) - float(lum[:, w - 1].mean())))
    diffs = []
    for x in range(1, w, max(1, w // 64)):
        diffs.append(float(np.mean(np.abs(arr[:, x - 1, :] - arr[:, x, :]))))
    diffs.sort()
    adjacent = diffs[len(diffs) // 2] if diffs else None
    return {
        "width": int(w),
        "height": int(h),
        "aspect": round(w / h, 6),
        "megapixels": round(w * h / 1e6, 3),
        "edge_mae": round(edge_mae, 3),
        "luma_delta": round(luma_delta, 2),
        "adjacent_column_mae_median": round(adjacent, 3) if adjacent is not None else None,
    }


def place(input_path, out_path, width, height, offset_x, offset_y):
    im = load_rgb(input_path)
    scale = min(width / im.width, height / im.height)
    nw = max(1, int(round(im.width * scale)))
    nh = max(1, int(round(im.height * scale)))
    resized = im.resize((nw, nh), Image.LANCZOS)
    x = max(0, min(width - nw, int(round((width - nw) * offset_x))))
    y = max(0, min(height - nh, int(round((height - nh) * offset_y))))
    arr = np.asarray(resized)
    canvas = np.pad(arr, ((y, height - y - nh), (x, width - x - nw), (0, 0)), mode="edge")
    Image.fromarray(canvas).save(out_path)
    print(json.dumps({
        "width": int(width),
        "height": int(height),
        "scale": round(scale, 6),
        "offset_x": offset_x,
        "offset_y": offset_y,
        "x": x,
        "y": y,
        "placed_width": nw,
        "placed_height": nh,
    }, ensure_ascii=False))


def prepare(pano_path, strip_path, mask_path, input_path=None):
    pano = load_rgb(pano_path)
    if pano.size != (PANORAMA_WIDTH, PANORAMA_HEIGHT):
        pano = pano.resize((PANORAMA_WIDTH, PANORAMA_HEIGHT), Image.LANCZOS)
    rolled = roll_half(pano)
    strip = rolled.crop(strip_box(rolled))

    band_left = (strip.width - WHITE_BAND) // 2
    band_right = band_left + WHITE_BAND
    draw = ImageDraw.Draw(strip)
    draw.rectangle([band_left, 0, band_right - 1, strip.height - 1], fill=(255, 255, 255))
    strip.save(strip_path)

    mask = Image.new("L", (strip.width, strip.height), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rectangle([band_left, 0, band_right - 1, mask.height - 1], fill=255)
    mask.save(mask_path)

    payload = {
        "strip_width": strip.width,
        "strip_height": strip.height,
        "band_left": band_left,
        "band_width": WHITE_BAND,
        "input_faces": count_faces(input_path) if input_path else None,
    }
    print(json.dumps(payload, ensure_ascii=False))


def stitch(pano_path, strip_path, mask_path, out_path, metrics_path, input_path=None):
    pano = load_rgb(pano_path)
    if pano.size != (PANORAMA_WIDTH, PANORAMA_HEIGHT):
        pano = pano.resize((PANORAMA_WIDTH, PANORAMA_HEIGHT), Image.LANCZOS)
    repaired = load_rgb(strip_path)
    if repaired.size != (STRIP_WIDTH, STRIP_HEIGHT):
        repaired = repaired.resize((STRIP_WIDTH, STRIP_HEIGHT), Image.LANCZOS)

    rolled = roll_half(pano)
    box = strip_box(rolled)
    base = rolled.crop(box)

    band_left = (STRIP_WIDTH - WHITE_BAND) // 2 - MASK_EXPAND
    band_right = (STRIP_WIDTH + WHITE_BAND) // 2 + MASK_EXPAND
    alpha = Image.new("L", (STRIP_WIDTH, STRIP_HEIGHT), 0)
    adraw = ImageDraw.Draw(alpha)
    adraw.rectangle([band_left, 0, band_right - 1, STRIP_HEIGHT - 1], fill=255)
    alpha = alpha.filter(ImageFilter.GaussianBlur(MASK_BLUR))

    blended = Image.composite(repaired, base, alpha)
    rolled.paste(blended, (box[0], box[1]))
    final = unroll_half(rolled)
    final.save(out_path)

    metrics = edge_metrics(out_path)
    metrics["input_faces"] = count_faces(input_path) if input_path else None
    metrics["output_faces"] = count_faces(out_path)
    metrics["dimensions_ok"] = final.size == (PANORAMA_WIDTH, PANORAMA_HEIGHT)
    with open(metrics_path, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=2)
    print(json.dumps(metrics, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("prepare")
    p.add_argument("--pano", required=True)
    p.add_argument("--strip-out", required=True)
    p.add_argument("--mask-out", required=True)
    p.add_argument("--input")

    place_parser = sub.add_parser("place")
    place_parser.add_argument("--input", required=True)
    place_parser.add_argument("--out", required=True)
    place_parser.add_argument("--width", type=int, default=PANORAMA_WIDTH)
    place_parser.add_argument("--height", type=int, default=PANORAMA_HEIGHT)
    place_parser.add_argument("--offset-x", type=float, default=0.5)
    place_parser.add_argument("--offset-y", type=float, default=0.5)

    s = sub.add_parser("stitch")
    s.add_argument("--pano", required=True)
    s.add_argument("--strip", required=True)
    s.add_argument("--mask", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--metrics", required=True)
    s.add_argument("--input")

    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.pano, args.strip_out, args.mask_out, args.input)
    elif args.command == "place":
        place(args.input, args.out, args.width, args.height, args.offset_x, args.offset_y)
    else:
        stitch(args.pano, args.strip, args.mask, args.out, args.metrics, args.input)


if __name__ == "__main__":
    main()
