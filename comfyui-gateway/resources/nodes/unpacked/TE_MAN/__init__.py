"""
通用ComfyUI自定义节点加载器
支持任何文件夹名称，自动检测并加载节点
"""

import importlib
from pathlib import Path

# 导入新的日志系统
from .logger import logger

# 获取当前文件夹路径
current_dir = Path(__file__).parent

# 初始化节点映射字典
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__version__ = "V0.02"

# 需要跳过的模块名
SKIP_MODULES = {
    "__init__",
    "logger",
    "config_manager",
    "api_client",
    "image_codec",
    "task_runner",
    "grid_split_core",
    "save_image_with_output_core",
    "test_logger",
    "test_enhancements",
    "verify_integration",
}


def _iter_loadable_module_names(directory: Path):
    module_names = set()
    for pattern in ("*.py", "*.pyd"):
        for module_file in directory.glob(pattern):
            module_name = module_file.stem
            if module_name in SKIP_MODULES:
                continue
            module_names.add(module_name)
    return sorted(module_names)

# 显示加载器标题
logger.header("TE MAN Node Loader")
logger.info(f"TE MAN version {__version__}")

# 自动查找并加载所有节点模块
for module_name in _iter_loadable_module_names(current_dir):
    try:
        # 使用包名导入，避免与其他插件中的同名模块互相污染
        module = importlib.import_module(f".{module_name}", package=__name__)

        # 合并节点映射
        if hasattr(module, 'NODE_CLASS_MAPPINGS'):
            NODE_CLASS_MAPPINGS.update(module.NODE_CLASS_MAPPINGS)

        if hasattr(module, 'NODE_DISPLAY_NAME_MAPPINGS'):
            NODE_DISPLAY_NAME_MAPPINGS.update(module.NODE_DISPLAY_NAME_MAPPINGS)

        logger.success(f"成功加载节点模块: {module_name}")

    except Exception as e:
        logger.error(f"加载节点模块失败 {module_name}: {str(e)}")

# 打印加载的节点信息
if NODE_CLASS_MAPPINGS:
    logger.info(f"总共加载了 {len(NODE_CLASS_MAPPINGS)} 个自定义节点")
    for node_name in NODE_CLASS_MAPPINGS.keys():
        display_name = NODE_DISPLAY_NAME_MAPPINGS.get(node_name, node_name)
        logger.info(f"   - {display_name} ({node_name})")
else:
    logger.warning("未找到任何有效的节点")

# ComfyUI需要的变量
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', '__version__']
WEB_DIRECTORY = "./web"
