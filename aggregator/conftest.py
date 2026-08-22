"""pytest path shim：把 src/ 加进 sys.path，使 `from one_mail_agg...` 可直接导入。

aggregator 用 src-layout（pyproject.toml 的 packages.find where=src），正式安装走
`pip install -e '.[dev]'`。但新 clone 直接跑 `pytest` 会 ModuleNotFoundError——这里
在收集前把 src 拽进 sys.path，让测试零配置即可跑（review I4：测试开箱可跑）。
"""
import os
import sys

_SRC = os.path.join(os.path.dirname(__file__), "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)
