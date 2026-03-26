import json
import unittest

from python_service.main import (
    ANNOTATION_FEWSHOT_EXAMPLES,
    ANNOTATION_REPAIR_FEWSHOT_EXAMPLES,
    ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES,
    build_annotation_messages,
    build_annotation_repair_messages,
    build_annotation_request_content,
    build_annotation_validation_messages,
    build_repair_request_content,
    build_validation_request_content,
    sanitize_extracted_text,
)


class AnnotationPromptTests(unittest.TestCase):
    def test_generation_examples_have_expected_shape(self) -> None:
        self.assertGreaterEqual(len(ANNOTATION_FEWSHOT_EXAMPLES), 5)
        self.assertTrue(any(example["output"] == [] for example in ANNOTATION_FEWSHOT_EXAMPLES))

        for example in ANNOTATION_FEWSHOT_EXAMPLES:
            self.assertIsInstance(example["passage"], str)
            self.assertIsInstance(example["output"], list)
            for item in example["output"]:
                self.assertEqual(set(item), {"type", "text_ref", "note", "importance"})
                self.assertIn(item["type"], {"highlight", "note", "definition"})
                self.assertIn(item["importance"], {1, 2, 3})
                if item["type"] == "definition":
                    self.assertTrue(item["note"].startswith(f'{item["text_ref"]}:'))

    def test_generation_messages_place_few_shots_before_live_passage(self) -> None:
        live_passage = "Live passage for annotation."
        messages = build_annotation_messages(live_passage)

        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(len(messages), 1 + (len(ANNOTATION_FEWSHOT_EXAMPLES) * 2) + 1)
        self.assertEqual(messages[-1]["role"], "user")
        self.assertEqual(messages[-1]["content"], build_annotation_request_content(live_passage))

        first_example_user = messages[1]
        first_example_assistant = messages[2]
        self.assertEqual(first_example_user["role"], "user")
        self.assertEqual(first_example_assistant["role"], "assistant")
        self.assertEqual(
            first_example_user["content"],
            build_annotation_request_content(ANNOTATION_FEWSHOT_EXAMPLES[0]["passage"]),
        )
        self.assertEqual(json.loads(first_example_assistant["content"]), ANNOTATION_FEWSHOT_EXAMPLES[0]["output"])

    def test_repair_messages_include_correction_examples(self) -> None:
        live_source = "Source passage."
        broken_output = "[not json"
        messages = build_annotation_repair_messages(live_source, broken_output)

        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(len(messages), 1 + (len(ANNOTATION_REPAIR_FEWSHOT_EXAMPLES) * 2) + 1)
        self.assertEqual(messages[-1]["role"], "user")
        self.assertEqual(messages[-1]["content"], build_repair_request_content(live_source, broken_output))

        first_example_assistant = messages[2]
        repaired = json.loads(first_example_assistant["content"])
        self.assertTrue(repaired)
        for item in repaired:
            self.assertEqual(set(item), {"type", "text_ref", "note", "importance"})

    def test_validation_examples_and_messages_include_page_numbers(self) -> None:
        live_page_sources = {7: "Page excerpt."}
        live_annotations = [
            {
                "type": "highlight",
                "text_ref": "Page excerpt",
                "note": "Important claim.",
                "importance": 2,
                "page_number": 7,
            }
        ]
        messages = build_annotation_validation_messages(live_page_sources, live_annotations)

        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(len(messages), 1 + (len(ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES) * 2) + 1)
        self.assertEqual(messages[-1]["content"], build_validation_request_content(live_page_sources, live_annotations))

        for example in ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES:
            for item in example["output"]:
                self.assertIn("page_number", item)

        validated = json.loads(messages[2]["content"])
        for item in validated:
            self.assertEqual(set(item), {"type", "text_ref", "note", "importance", "page_number"})

    def test_sanitize_extracted_text_removes_control_characters(self) -> None:
        raw = "Alpha\x00Beta\x02Gamma\x12Delta\tLine\nBreak"
        self.assertEqual(sanitize_extracted_text(raw), "AlphaBetaGammaDelta\tLine\nBreak")


if __name__ == "__main__":
    unittest.main()
