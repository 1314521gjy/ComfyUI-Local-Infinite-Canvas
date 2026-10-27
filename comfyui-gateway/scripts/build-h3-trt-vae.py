import argparse
import os
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--compiler", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", type=int, default=0)
    args = parser.parse_args()

    if not os.path.isfile(args.compiler):
        print(f"[Error] H3 TRT compiler not found: {args.compiler}", file=sys.stderr)
        return 2
    if not os.path.isfile(args.input):
        print(f"[Error] ONNX input not found: {args.input}", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    command = [
        sys.executable,
        args.compiler,
        "--input",
        args.input,
        "--output",
        args.output,
        "--device",
        str(args.device),
    ]
    print("[h3-trt] " + " ".join(command), flush=True)
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
