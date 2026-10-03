import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import definitions
import judge
import judge_en_test as en
import styles


# shared/definitions.json 的中文部分必须与线上代码逐字一致。判断层的措辞实测极敏感
# （两轮压缩掉到 81.8% / 77.3%），共享文件抄错一个字就是一次静默回归。
class ChineseParityTests(unittest.TestCase):
    def test_intents_match_judge(self):
        self.assertEqual(definitions.intents('zh'), judge.INTENTS)

    def test_risk_levels_match_judge(self):
        self.assertEqual(definitions.risk_levels('zh'), judge.RISK_LEVELS)

    def test_actions_match_judge(self):
        self.assertEqual(definitions.actions('zh'), judge.ACTION_MAP)

    def test_tones_match_styles(self):
        self.assertEqual(definitions.tones('zh'), styles.BUILTIN)


# 英文那半同样是抄来的：src/judge_en_test.py 里的 INTENTS_EN / RISK_LEVELS_EN 才是原文，
# 探测报告的 90.6% 就是拿那份措辞测出来的。只校验形状挡不住改一处忘改另一处——
# 而且键序是承重的：extension/src/backends/llm.ts 靠 Object.keys(intents(lang)) 把
# 模型回答的字母下标映射回意图，顺序一变，字母对应的就是另一类意图了。
class EnglishParityTests(unittest.TestCase):
    def test_intents_match_the_measured_wording(self):
        self.assertEqual(definitions.intents('en'), en.INTENTS_EN)

    def test_risk_levels_match_the_measured_wording(self):
        self.assertEqual(definitions.risk_levels('en'), en.RISK_LEVELS_EN)

    def test_intent_key_order_matches(self):
        # dict 相等不看顺序，字母映射看顺序——单独守一条
        self.assertEqual(list(definitions.intents('en')), list(en.INTENTS_EN))


class EnglishShapeTests(unittest.TestCase):
    def test_same_intent_count_in_both_languages(self):
        # 键不要求相同：zh 的键是中文标签（judge.py 的既有形状），en 的键是英文标签，
        # 两边都直接作为界面文字显示。要求相同的是「有几类」。
        self.assertEqual(len(definitions.intents('en')), len(definitions.intents('zh')))

    def test_fallback_intent_exists_in_both(self):
        for lang in ('zh', 'en'):
            with self.subTest(lang=lang):
                self.assertIn(definitions.fallback_intent(lang), definitions.intents(lang))

    def test_risk_scale_is_ten_levels_in_both(self):
        self.assertEqual(len(definitions.risk_levels('en')), 10)
        self.assertEqual(len(definitions.risk_levels('zh')), 10)

    def test_every_intent_has_actions_in_both(self):
        for lang in ('zh', 'en'):
            with self.subTest(lang=lang):
                self.assertEqual(set(definitions.actions(lang)),
                                 set(definitions.intents(lang)))

    def test_english_tones_exist_for_the_skeleton(self):
        # 完整 10 条英文话术是第 7 期的内容；骨架期先有 3 条可用的
        self.assertGreaterEqual(len(definitions.tones('en')), 3)

    def test_unknown_language_raises(self):
        with self.assertRaises(KeyError):
            definitions.intents('fr')
