import { spawn } from "node:child_process";
import path from "node:path";

// Linux/macOS 没有 PowerShell，原生选择框改由本机桌面对话框提供：
//   1) zenity（GTK，最通用）
//   2) kdialog（KDE）
//   3) python3 tkinter（没有桌面环境时的兜底）
// 返回 { canceled, path, error }：取消时 canceled=true；path 为绝对路径。
//
// 测试可用 FILE_PICKER_FAKE 直接回填路径，FILE_PICKER_FAKE_CANCELED=1 模拟取消。

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ spawned: false, code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ spawned: true, code: -1, stdout, stderr: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ spawned: false, code: -1, stdout, stderr: String(error?.message || error) }));
    child.on("close", (code) => finish({ spawned: true, code, stdout, stderr }));
  });
}

function zenityArgs({ title, initialDir, filters, directory }) {
  const args = ["--file-selection", `--title=${title}`];
  if (directory) args.push("--directory");
  if (initialDir) args.push(`--filename=${initialDir}${initialDir.endsWith("/") ? "" : "/"}`);
  for (const filter of filters || []) {
    const patterns = (filter.patterns || []).filter(Boolean);
    if (!patterns.length) continue;
    args.push(`--file-filter=${filter.name || "文件"} | ${patterns.join(" ")}`);
  }
  return args;
}

function kdialogArgs({ title, initialDir, filters, directory }) {
  if (directory) return ["--getexistingdirectory", initialDir || "."];
  const patterns = (filters || []).flatMap((filter) => (filter.patterns || []).filter(Boolean));
  return ["--getopenfilename", initialDir || ".", patterns.join(" ") || "*"];
}

// tkinter 的 filetypes 是 (标签, 通配) 列表，逐个 pattern 展开更稳。
const TKINTER_SCRIPT = [
  "import json, sys",
  "import tkinter as tk",
  "from tkinter import filedialog",
  "args = json.loads(sys.argv[1])",
  "root = tk.Tk()",
  "root.withdraw()",
  "root.attributes('-topmost', True)",
  "initial = args.get('initialDir') or None",
  "if args.get('directory'):",
  "    chosen = filedialog.askdirectory(title=args.get('title') or '', initialdir=initial)",
  "else:",
  "    filetypes = [(f.get('name') or '文件', p) for f in args.get('filters') or [] for p in (f.get('patterns') or [])]",
  "    chosen = filedialog.askopenfilename(title=args.get('title') or '', initialdir=initial, filetypes=filetypes or None)",
  "root.destroy()",
  "sys.stdout.write(chosen or '')",
  "sys.stdout.flush()",
].join("\n");

// 各后端的“取消”信号：zenity/kdialog 取消时退出码 1；tkinter 取消时输出为空。
const BACKENDS = [
  { name: "zenity", command: "zenity", args: zenityArgs, canceled: (result) => result.code === 1, emptyMeansCancel: false },
  { name: "kdialog", command: "kdialog", args: kdialogArgs, canceled: (result) => result.code === 1, emptyMeansCancel: false },
  {
    name: "python3 tkinter",
    command: "python3",
    args: (options) => ["-c", TKINTER_SCRIPT, JSON.stringify(options)],
    canceled: (result) => result.code === 0 && !String(result.stdout || "").trim(),
    emptyMeansCancel: true,
  },
];

export function pickFileLinux({ title = "选择", initialDir = "", filters = [], directory = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (process.env.FILE_PICKER_FAKE) {
    const fake = path.resolve(process.env.FILE_PICKER_FAKE);
    return Promise.resolve(process.env.FILE_PICKER_FAKE_CANCELED ? { canceled: true, path: "" } : { canceled: false, path: fake });
  }
  const options = { title, initialDir, filters, directory };
  return (async () => {
    const problems = [];
    for (const backend of BACKENDS) {
      const result = await runProcess(backend.command, backend.args(options), timeoutMs);
      if (!result.spawned) {
        // ENOENT：该后端没装，继续试下一个。
        problems.push(`${backend.name} 不可用（${result.stderr || "未安装"}）`);
        continue;
      }
      const selected = String(result.stdout || "").trim();
      if (selected) {
        return { canceled: false, path: path.resolve(selected) };
      }
      if (backend.canceled(result)) return { canceled: true, path: "" };
      if (backend.emptyMeansCancel) return { canceled: true, path: "" };
      problems.push(`${backend.name} 退出码 ${result.code}${result.stderr ? `：${result.stderr.trim()}` : ""}`);
    }
    return {
      canceled: false,
      path: "",
      error: `未找到可用的本机文件选择器（已尝试 ${BACKENDS.map((backend) => backend.name).join("、")}）：${problems.join("；")}`,
    };
  })();
}
