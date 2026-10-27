import argparse
import os
import subprocess
import sys


def use_utf8_streams():
    # 网关按 UTF-8 解码子进程输出；管道下 Windows Python 默认走 GBK，会变乱码
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


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

    # compile.py 把错误打在 stdout，网关只收 stderr，这里先自查再转发
    try:
        import tensorrt  # noqa: F401
    except ImportError:
        print(
            "[Error] ComfyUI 的 Python 环境缺少 tensorrt，无法编译 H3 TRT engine。"
            f"请为 {sys.executable} 安装与本机 CUDA/驱动匹配的 tensorrt 后重试。",
            file=sys.stderr,
        )
        return 3

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

    tail = []
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"),
    )
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        tail.append(line.rstrip())
        if len(tail) > 40:
            tail.pop(0)
    code = process.wait()
    if code != 0:
        print(
            "[h3-trt] 编译失败，最后输出：\n" + "\n".join(tail[-20:]),
            file=sys.stderr,
        )
    return code


if __name__ == "__main__":
    use_utf8_streams()
    raise SystemExit(main())
