
import sys
import time
import threading
import re
from datetime import datetime
from typing import Optional


# ==================== 颜色方案（柔和配色） ====================
class ColorScheme:
    """ANSI转义码颜色方案 - 柔和配色"""

    # 控制码
    RESET = "\033[0m"
    BOLD = "\033[1m"

    # 柔和配色方案
    SUCCESS = "\033[92m"      # 淡绿色
    WARNING = "\033[38;5;214m"  # 橙色
    ERROR = "\033[38;5;211m"    # 粉红色
    INFO = "\033[38;5;153m"     # 淡蓝色
    PROGRESS = "\033[38;5;141m" # 紫色
    WHITE = "\033[97m"
    GRAY = "\033[90m"

    @staticmethod
    def paint(text: str, color: str, bold: bool = False) -> str:
        """给文本上色"""
        prefix = ColorScheme.BOLD if bold else ""
        return f"{prefix}{color}{text}{ColorScheme.RESET}"

    _ANSI_PATTERN = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

    @staticmethod
    def strip_color(text: str) -> str:
        """移除颜色代码（用于计算实际长度）"""
        return ColorScheme._ANSI_PATTERN.sub('', text)


# ==================== Unicode字符宽度计算 ====================
def get_display_width(text: str) -> int:
    """
    计算字符串的实际显示宽度（考虑中文、emoji等宽字符）

    规则：
    - ASCII字符（0x00-0x7F）: 宽度1
    - 中文、日文、韩文（CJK）: 宽度2
    - Emoji和其他宽字符: 宽度2
    """
    width = 0
    for char in text:
        code = ord(char)
        # ASCII字符
        if code <= 0x7F:
            width += 1
        # CJK统一表意文字
        elif 0x4E00 <= code <= 0x9FFF:  # 基本中文
            width += 2
        elif 0x3400 <= code <= 0x4DBF:  # 扩展A
            width += 2
        elif 0x20000 <= code <= 0x2A6DF:  # 扩展B
            width += 2
        elif 0x2A700 <= code <= 0x2B73F:  # 扩展C
            width += 2
        elif 0x2B740 <= code <= 0x2B81F:  # 扩展D
            width += 2
        elif 0x2B820 <= code <= 0x2CEAF:  # 扩展E
            width += 2
        elif 0x2CEB0 <= code <= 0x2EBEF:  # 扩展F
            width += 2
        elif 0x30000 <= code <= 0x3134F:  # 扩展G
            width += 2
        # CJK符号和标点
        elif 0x3000 <= code <= 0x303F:
            width += 2
        # 日文假名
        elif 0x3040 <= code <= 0x309F:  # 平假名
            width += 2
        elif 0x30A0 <= code <= 0x30FF:  # 片假名
            width += 2
        # 韩文
        elif 0xAC00 <= code <= 0xD7AF:  # 韩文音节
            width += 2
        elif 0x1100 <= code <= 0x11FF:  # 韩文字母
            width += 2
        # Emoji (常用范围)
        elif 0x1F300 <= code <= 0x1F9FF:  # 各类emoji
            width += 2
        elif 0x2600 <= code <= 0x26FF:  # 杂项符号
            width += 2
        elif 0x2700 <= code <= 0x27BF:  # 装饰符号
            width += 2
        elif 0xFE00 <= code <= 0xFE0F:  # 变体选择符（通常不占宽度）
            width += 0
        # 全角字符
        elif 0xFF00 <= code <= 0xFFEF:
            width += 2
        # 其他默认宽度1
        else:
            width += 1

    return width


# ==================== 进度条 ====================
# 全局进度条管理器（用于多线程协调）
_active_progress_bar = None
_progress_bar_lock = threading.Lock()


class ProgressBar:
    """实时进度条 - 实心方块样式"""

    def __init__(self, total: int, description: str = "处理中", width: int = 20):
        self.total = total
        self.current = 0
        self.description = description
        self.width = width
        self.start_time = time.time()
        self.lock = threading.Lock()
        self._last_line_length = 0
        self._last_line = ""  # 保存最后一行用于恢复

    def clear_line(self):
        """清除当前进度条行"""
        if self._last_line_length > 0:
            sys.stdout.write("\r" + " " * self._last_line_length + "\r")
            sys.stdout.flush()

    def restore_line(self):
        """恢复进度条显示"""
        if self._last_line:
            sys.stdout.write(self._last_line)
            sys.stdout.flush()

    def update(self, n: int = 1):
        """更新进度"""
        with self.lock:
            self.current += n
            if self.current > self.total:
                self.current = self.total
            self._render()

    def _render(self):
        """渲染进度条"""
        # 计算进度
        percent = (self.current / self.total) * 100 if self.total > 0 else 0
        filled = int(self.width * self.current / self.total) if self.total > 0 else 0

        # 实心方块进度条
        bar = '█' * filled + '░' * (self.width - filled)

        # 计算时间
        elapsed = time.time() - self.start_time
        if self.current > 0 and elapsed > 0:
            speed = self.current / elapsed
            eta = (self.total - self.current) / speed if speed > 0 else 0
        else:
            eta = 0

        # 构建输出行
        percent_str = ColorScheme.paint(f"{percent:.0f}%", ColorScheme.PROGRESS, bold=True)
        line = (
            f"\r🔄 {self.description}: "
            f"{ColorScheme.paint(bar, ColorScheme.PROGRESS)} "
            f"{percent_str} "
            f"({self.current}/{self.total}) | "
            f"用时: {elapsed:.1f}s"
        )

        # 添加预计时间（只在未完成时显示）
        if self.current < self.total and eta > 0:
            line += f" | 预计: {eta:.1f}s"

        # 清除之前的行（如果新行更短）- 使用Unicode宽度计算
        line_stripped = ColorScheme.strip_color(line)
        current_width = get_display_width(line_stripped)

        if current_width < self._last_line_length:
            line += " " * (self._last_line_length - current_width)

        self._last_line_length = current_width

        # 输出
        sys.stdout.write(line)
        sys.stdout.flush()

        # 保存当前行用于恢复
        self._last_line = line

        # 完成后换行
        if self.current >= self.total:
            print()

    def __enter__(self):
        global _active_progress_bar
        with _progress_bar_lock:
            _active_progress_bar = self
        return self

    def __exit__(self, *args):
        global _active_progress_bar
        # 确保进度条完成
        if self.current < self.total:
            self.current = self.total
            self._render()

        with _progress_bar_lock:
            _active_progress_bar = None


# ==================== 线程安全日志器 ====================
class ThreadSafeLogger:
    """线程安全的日志系统 - 标准模式"""

    _THREAD_PATTERN = re.compile(r'(\d+)')

    def __init__(self):
        self.lock = threading.Lock()
        self._enable_color = True
        self._check_terminal_support()

    def _check_terminal_support(self):
        """检测终端是否支持颜色"""
        # Windows需要启用ANSI支持
        if sys.platform == "win32":
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            except Exception:
                self._enable_color = False

    def _format_message(self, level: str, message: str, emoji: str, color: str) -> str:
        """格式化日志消息"""
        timestamp = datetime.now().strftime("%H:%M:%S")

        # 构建消息（不显示线程名称）
        line = f"[{timestamp}] {emoji} {message}"

        # 应用颜色
        if self._enable_color:
            return ColorScheme.paint(line, color)
        return line

    def _print_with_progress_handling(self, message: str):
        """
        输出消息，自动处理进度条暂停/恢复

        如果有活跃的进度条，会：
        1. 清除进度条
        2. 输出消息
        3. 恢复进度条
        """
        global _active_progress_bar

        with self.lock:
            # 如果有活跃的进度条，先清除
            if _active_progress_bar:
                with _progress_bar_lock:
                    _active_progress_bar.clear_line()

            # 输出消息
            print(message, flush=True)

            # 恢复进度条
            if _active_progress_bar:
                with _progress_bar_lock:
                    _active_progress_bar.restore_line()

    def info(self, message: str):
        """信息日志"""
        line = self._format_message("INFO", message, "ℹ️", ColorScheme.INFO)
        self._print_with_progress_handling(line)

    def success(self, message: str):
        """成功日志"""
        line = self._format_message("SUCCESS", message, "✅", ColorScheme.SUCCESS)
        self._print_with_progress_handling(line)

    def warning(self, message: str):
        """警告日志"""
        line = self._format_message("WARNING", message, "⚠️", ColorScheme.WARNING)
        self._print_with_progress_handling(line)

    def error(self, message: str):
        """错误日志"""
        line = self._format_message("ERROR", message, "❌", ColorScheme.ERROR)
        self._print_with_progress_handling(line)

    def progress_bar(self, total: int, description: str = "处理中") -> ProgressBar:
        """创建进度条"""
        return ProgressBar(total, description)

    def separator(self, char: str = "=", length: int = 60):
        """打印分隔线"""
        with self.lock:
            print(ColorScheme.paint(char * length, ColorScheme.GRAY), flush=True)

    def header(self, title: str, width: int = 60):
        """打印标题头（使用Unicode宽度计算）"""
        with self.lock:
            # 计算居中 - 使用Unicode宽度
            title_with_spaces = f"  {title}  "
            title_width = get_display_width(title_with_spaces)

            # 计算内容区域宽度（扣除边框的2个字符）
            content_width = width - 2

            # 计算左右padding（确保居中）
            total_padding = content_width - title_width
            left_padding = total_padding // 2
            right_padding = total_padding - left_padding

            # 使用双线边框
            top = "╔" + "═" * content_width + "╗"
            middle = "║" + " " * left_padding + title_with_spaces + " " * right_padding + "║"
            bottom = "╚" + "═" * content_width + "╝"

            print(ColorScheme.paint(top, ColorScheme.PROGRESS), flush=True)
            print(ColorScheme.paint(middle, ColorScheme.PROGRESS, bold=True), flush=True)
            print(ColorScheme.paint(bottom, ColorScheme.PROGRESS), flush=True)

    def summary(self, title: str, items: dict, width: int = 60):
        """打印摘要信息"""
        with self.lock:
            # 标题
            title_line = f"✨ {title}"
            print(f"\n{ColorScheme.paint(title_line, ColorScheme.SUCCESS, bold=True)}", flush=True)

            # 内容
            for key, value in items.items():
                # 格式化键值对
                line = f"   {key}: {ColorScheme.paint(str(value), ColorScheme.WHITE, bold=True)}"
                print(line, flush=True)

            print()  # 空行


# ==================== 全局日志实例 ====================
logger = ThreadSafeLogger()


# ==================== 导出 ====================
__all__ = ['logger', 'ColorScheme', 'ProgressBar']
