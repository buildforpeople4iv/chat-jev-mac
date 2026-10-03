import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import judge_en_test as en


# 全部离线：只测数据集完整性与纯函数，不加载模型、不发网络请求。
class DatasetTests(unittest.TestCase):
    def test_every_gold_label_is_a_known_intent(self):
        for text, gold in en.CASES:
            with self.subTest(text=text):
                self.assertIn(gold, en.INTENTS_EN)

    def test_four_cases_per_intent(self):
        counts = {name: 0 for name in en.INTENTS_EN}
        for _text, gold in en.CASES:
            counts[gold] += 1
        self.assertEqual(set(counts.values()), {4}, counts)

    def test_no_duplicate_messages(self):
        texts = [t for t, _g in en.CASES]
        self.assertEqual(len(texts), len(set(texts)))

    def test_risk_scale_has_ten_levels(self):
        # 与中文侧同构：judge.py 的 RISK_LEVELS 是 0..9 十档
        self.assertEqual(len(en.RISK_LEVELS_EN), 10)


class LetterAnswerTests(unittest.TestCase):
    def test_plain_letter(self):
        self.assertEqual(en.parse_letter_answer('B', 8), 1)

    def test_parenthesized(self):
        self.assertEqual(en.parse_letter_answer('(C)', 8), 2)

    def test_with_prefix_and_markup(self):
        self.assertEqual(en.parse_letter_answer('Answer: **(D)**', 8), 3)

    def test_lowercase(self):
        self.assertEqual(en.parse_letter_answer('answer: e', 8), 4)

    def test_out_of_range_is_none(self):
        self.assertIsNone(en.parse_letter_answer('J', 8))

    def test_no_letter_is_none(self):
        self.assertIsNone(en.parse_letter_answer('I think it is a task', 8))

    def test_bracketed_answer_wins_over_earlier_article(self):
        self.assertEqual(en.parse_letter_answer(
            'As a starting point, I would say (D) is correct.', 8), 3)

    def test_bracketed_answer_wins_over_leading_article(self):
        self.assertEqual(en.parse_letter_answer('A good approach here is (D).', 8), 3)

    def test_bare_article_alone_is_not_an_answer(self):
        self.assertIsNone(en.parse_letter_answer('it is a task', 8))

    def test_bracketed_answer_found_despite_earlier_bare_letter(self):
        self.assertEqual(en.parse_letter_answer(
            'I think a reasonable pick is (D).', 8), 3)


class SummarizeTests(unittest.TestCase):
    def test_accuracy_and_per_intent(self):
        run = {'model': 'fake', 'elapsed_s': 1.0, 'results': [
            {'text': 'a', 'gold': 'assign', 'pred': 'assign', 'conf': 0.9},
            {'text': 'b', 'gold': 'assign', 'pred': 'chase', 'conf': 0.4},
            {'text': 'c', 'gold': 'praise', 'pred': 'praise', 'conf': 0.8},
        ]}
        s = en.summarize(run)
        self.assertAlmostEqual(s['acc'], 2 / 3)
        self.assertEqual(s['n'], 3)
        self.assertEqual(s['per_intent']['assign'], 0.5)
        self.assertEqual(s['per_intent']['praise'], 1.0)
        self.assertAlmostEqual(s['majority_baseline'], 0.667, places=3)
