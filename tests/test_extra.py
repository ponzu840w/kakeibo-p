"""tests_extra/(ローカル拡張パーサのテスト。git外・任意)を一緒に実行する。

parsers_extra.py と同じ発想の拡張点。tests_extra/ が無ければ何もしない。
"""
import unittest  # noqa: F401  (unittest discover がテストモジュールと認識する)
from pathlib import Path

_EXTRA = Path(__file__).resolve().parent.parent / "tests_extra"


def load_tests(loader, tests, pattern):
    if _EXTRA.is_dir():
        # 共有loaderはdiscover中の状態(top_level_dir)を持つため新規に作る
        extra_loader = unittest.TestLoader()
        tests.addTests(extra_loader.discover(str(_EXTRA),
                                             pattern or "test_*.py",
                                             top_level_dir=str(_EXTRA)))
    return tests
