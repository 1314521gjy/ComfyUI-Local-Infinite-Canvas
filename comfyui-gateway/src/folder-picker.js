import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function powershellPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function isDir(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

// 浏览器拿不到本地绝对路径；由本机网关弹原生文件夹对话框，选完把路径回填。
export function pickFolder({ title = "选择文件夹", initial = "", timeoutMs = 10 * 60 * 1000 } = {}) {
  if (process.env.FOLDER_PICKER_FAKE) {
    return Promise.resolve({ canceled: false, path: path.resolve(process.env.FOLDER_PICKER_FAKE) });
  }
  if (process.platform !== "win32") {
    return Promise.reject(new Error("当前系统不支持原生文件夹选择，请手动输入路径"));
  }
  const initialDir = initial && isDir(initial) ? path.resolve(initial) : "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = 'None'",
    "$owner.StartPosition = 'CenterScreen'",
    "$owner.Size = New-Object System.Drawing.Size(1,1)",
    "$owner.Opacity = 0",
    "$owner.Show()",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description = ${psQuote(title)}`,
    "$d.ShowNewFolderButton = $true",
    initialDir ? `$d.SelectedPath = ${psQuote(initialDir)}` : "",
    "$r = $d.ShowDialog($owner)",
    "$owner.Close()",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ]
    .filter(Boolean)
    .join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(reject, new Error("选择目录超时"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code !== 0) {
        const message = String(stderr || "").replace(/#< CLIXML[\s\S]*$/i, "").trim();
        finish(reject, new Error(message || `选择目录失败（退出码 ${code}）`));
        return;
      }
      const selected = String(stdout || "").trim();
      finish(resolve, selected ? { canceled: false, path: selected } : { canceled: true, path: "" });
    });
  });
}
