import json
import unittest

import fitz

from python_service.main import (
    ANNOTATION_FEWSHOT_EXAMPLES,
    ANNOTATION_REPAIR_FEWSHOT_EXAMPLES,
    ANNOTATION_VALIDATION_FEWSHOT_EXAMPLES,
    Annotation,
    BoundingBox,
    MemoryListItem,
    MemoryRecentAnnotation,
    RollingMemoryState,
    TextAnchor,
    assign_text_anchors,
    build_deterministic_annotation_brief_lines,
    build_annotation_messages,
    build_annotation_brief_source,
    build_chunk_neighbor_context,
    build_annotation_repair_messages,
    build_annotation_request_content,
    build_annotation_validation_messages,
    build_page_sources,
    build_repair_request_content,
    build_validation_request_content,
    compact_rolling_memory,
    filter_chunk_annotations_for_memory,
    infer_section_hint,
    refine_annotation_bboxes,
    resolve_text_anchor_for_chunk,
    render_rolling_memory,
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

    def test_generation_messages_only_apply_context_to_live_passage(self) -> None:
        live_passage = "Live passage for annotation."
        messages = build_annotation_messages(
            live_passage,
            paper_brief="- Main thesis.\n- Method.\n- Result.\n- Caveat.",
            rolling_memory="Paper so far:\n- Prior result.",
            local_context="Previous chunk tail:\nEarlier sentence.",
            page_number=12,
            section_hint="Results",
        )

        self.assertIn("Paper brief:", messages[-1]["content"])
        self.assertIn("Rolling memory:", messages[-1]["content"])
        self.assertIn("Local context:", messages[-1]["content"])
        self.assertIn("Page: 12", messages[-1]["content"])
        self.assertIn("Section hint: Results", messages[-1]["content"])
        self.assertNotIn("Paper brief:", messages[1]["content"])
        self.assertNotIn("Rolling memory:", messages[1]["content"])
        self.assertNotIn("Local context:", messages[1]["content"])

    def test_build_annotation_request_content_is_unchanged_without_optional_context(self) -> None:
        live_passage = "Live passage for annotation."
        self.assertEqual(
            build_annotation_request_content(live_passage),
            "Annotate the following academic passage.\n"
            "Return only a JSON array matching the required schema.\n\n"
            "Passage:\nLive passage for annotation.",
        )

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

    def test_prompt_builders_strip_transport_unsafe_characters(self) -> None:
        unsafe_passage = "Alpha\x00Beta\u0085Gamma\ud834Delta\ufffeOmega"
        content = build_annotation_request_content(unsafe_passage)
        self.assertNotIn("\x00", content)
        self.assertNotIn("\u0085", content)
        self.assertNotIn("\ud834", content)
        self.assertNotIn("\ufffe", content)
        self.assertIn("AlphaBetaGammaDeltaOmega", content)

        validation_content = build_validation_request_content(
            {5: unsafe_passage},
            [
                {
                    "type": "note",
                    "text_ref": "Alpha\x00Beta",
                    "note": "Alpha\x00Beta matters.",
                    "importance": 1,
                    "page_number": 5,
                }
            ],
        )
        self.assertNotIn("\x00", validation_content)
        self.assertNotIn("\u0085", validation_content)
        self.assertNotIn("\ud834", validation_content)
        self.assertNotIn("\ufffe", validation_content)

    def test_annotation_brief_source_samples_early_middle_and_late_chunks(self) -> None:
        chunks = [
            {"page_number": index + 1, "text": f"chunk-{index}", "section_hint": None}
            for index in range(12)
        ]
        source = build_annotation_brief_source(chunks, sample_count=5)

        self.assertIn("chunk-0", source)
        self.assertIn("chunk-6", source)
        self.assertIn("chunk-11", source)

    def test_deterministic_annotation_brief_lines_include_early_middle_and_late_context(self) -> None:
        chunks = [
            {"page_number": 1, "text": "intro context " * 10, "section_hint": "Introduction"},
            {"page_number": 2, "text": "method context " * 10, "section_hint": "Method"},
            {"page_number": 3, "text": "result context " * 10, "section_hint": "Results"},
        ]

        lines = build_deterministic_annotation_brief_lines(chunks)

        self.assertEqual(len(lines), 3)
        self.assertIn("Early context (Introduction)", lines[0])
        self.assertIn("Middle context (Method)", lines[1])
        self.assertIn("Late context (Results)", lines[2])

    def test_filter_chunk_annotations_for_memory_keeps_valid_strong_unique_items(self) -> None:
        chunk_text = "Alpha method improves results while BenchmarkX remains difficult."
        items = [
            {
                "type": "highlight",
                "text_ref": "Alpha method",
                "note": "Main method.",
                "importance": 2,
            },
            {
                "type": "highlight",
                "text_ref": "Alpha method",
                "note": "Stronger main method note.",
                "importance": 3,
            },
            {
                "type": "note",
                "text_ref": "missing text",
                "note": "Should be dropped.",
                "importance": 3,
            },
            {
                "type": "definition",
                "text_ref": "",
                "note": "Empty text_ref should be dropped.",
                "importance": 1,
            },
        ]

        filtered = filter_chunk_annotations_for_memory(items, chunk_text, page_number=4)

        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0].text_ref, "Alpha method")
        self.assertEqual(filtered[0].importance, 3)
        self.assertEqual(filtered[0].page_number, 4)

    def test_compact_rolling_memory_respects_caps_and_prioritizes_stronger_items(self) -> None:
        memory = RollingMemoryState(
            paper_state=[
                MemoryListItem(text=f"Paper state {index}", importance=(3 if index == 0 else 1), order=index)
                for index in range(10)
            ],
            defined_terms=[f"Term {index}" for index in range(20)],
            covered_topics=[
                MemoryListItem(text=f"Topic {index}", importance=(3 if index < 2 else 1), order=index)
                for index in range(25)
            ],
            recent_annotations=[
                MemoryRecentAnnotation(
                    type="highlight",
                    text_ref=f"Ref {index}",
                    note=f"Note {index}",
                    importance=(3 if index < 2 else 1),
                    page_number=index + 1,
                    order=index,
                )
                for index in range(12)
            ],
            blocked_text_refs=[f"Ref {index}" for index in range(12)],
        )

        compacted = compact_rolling_memory(memory)

        self.assertLessEqual(len(compacted.paper_state), 4)
        self.assertLessEqual(len(compacted.defined_terms), 12)
        self.assertLessEqual(len(compacted.covered_topics), 12)
        self.assertLessEqual(len(compacted.recent_annotations), 5)
        self.assertIn("Paper state 0", [item.text for item in compacted.paper_state])
        self.assertIn("Topic 0", [item.text for item in compacted.covered_topics])

    def test_render_rolling_memory_stays_within_budget(self) -> None:
        memory = RollingMemoryState(
            paper_state=[
                MemoryListItem(text="Long paper-state bullet " * 8, importance=3, order=10),
                MemoryListItem(text="Another long paper-state bullet " * 8, importance=2, order=9),
            ],
            defined_terms=[f"TechnicalTerm{index}" for index in range(10)],
            covered_topics=[
                MemoryListItem(text="Covered topic " * 8 + str(index), importance=1, order=index)
                for index in range(10)
            ],
            recent_annotations=[
                MemoryRecentAnnotation(
                    type="note",
                    text_ref=f"Text ref {index}",
                    note="A long explanatory note " * 8,
                    importance=2,
                    page_number=index + 1,
                    order=20 - index,
                )
                for index in range(8)
            ],
        )

        rendered = render_rolling_memory(memory, char_budget=320)
        self.assertLessEqual(len(rendered), 320)

    def test_rendered_memory_is_stable_when_memory_does_not_change(self) -> None:
        memory = RollingMemoryState(
            recent_annotations=[
                MemoryRecentAnnotation(
                    type="highlight",
                    text_ref="Alpha method",
                    note="Important method detail for the paper.",
                    importance=3,
                    page_number=2,
                    order=1,
                )
            ]
        )

        first = render_rolling_memory(memory, char_budget=320)
        second = render_rolling_memory(memory, char_budget=320)

        self.assertEqual(first, second)

    def test_neighbor_context_handles_edges(self) -> None:
        chunks = [
            {"text": "first chunk"},
            {"text": "second chunk"},
            {"text": "third chunk"},
        ]

        first = build_chunk_neighbor_context(chunks, 0, window_chars=20)
        last = build_chunk_neighbor_context(chunks, 2, window_chars=20)

        self.assertIn("Next chunk head:", first)
        self.assertNotIn("Previous chunk tail:", first)
        self.assertIn("Previous chunk tail:", last)
        self.assertNotIn("Next chunk head:", last)

    def test_section_hint_inference_is_optional(self) -> None:
        self.assertEqual(infer_section_hint("3 Results"), "Results")
        self.assertIsNone(infer_section_hint("This is a full sentence describing an experiment result in detail."))

    def test_resolve_text_anchor_for_chunk_chooses_occurrence_inside_chunk_range(self) -> None:
        page_text = "Alpha method appears once.\nBridge text.\nAlpha method appears twice."

        anchor = resolve_text_anchor_for_chunk(page_text, "Alpha method", 40, 65)

        self.assertIsNotNone(anchor)
        self.assertEqual(anchor.occurrence_index, 1)
        self.assertEqual(page_text[anchor.page_text_start : anchor.page_text_end], "Alpha method")

    def test_assign_text_anchors_prefers_existing_anchor_hint_for_repeated_terms(self) -> None:
        first_text = "Alpha method appears once."
        second_text = "Alpha method appears twice."
        second_start = len(first_text) + 1
        blocks = [
            {
                "page_number": 1,
                "text": first_text,
                "page_text_start": 0,
                "page_text_end": len(first_text),
                "bbox": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.05},
            },
            {
                "page_number": 1,
                "text": second_text,
                "page_text_start": second_start,
                "page_text_end": second_start + len(second_text),
                "bbox": {"x": 0.1, "y": 0.8, "width": 0.2, "height": 0.05},
            },
        ]
        page_sources = build_page_sources(blocks)
        annotation = Annotation(
            type="definition",
            text_ref="Alpha method",
            note="Alpha method: a named technique.",
            importance=2,
            page_number=1,
            bbox=BoundingBox(x=0.1, y=0.8, width=0.2, height=0.05),
            anchor=TextAnchor(
                page_text_start=second_start,
                page_text_end=second_start + len("Alpha method"),
                occurrence_index=1,
            ),
        )

        resolved = assign_text_anchors([annotation], page_sources, blocks)[0]

        self.assertIsNotNone(resolved.anchor)
        self.assertEqual(resolved.anchor.occurrence_index, 1)
        self.assertEqual(
            page_sources[1][resolved.anchor.page_text_start : resolved.anchor.page_text_end],
            "Alpha method",
        )

    def test_refine_annotation_bboxes_uses_pdf_text_search(self) -> None:
        pdf_doc = fitz.open()
        page = pdf_doc.new_page(width=400, height=400)
        page.insert_text((72, 72), "The Nystrom approximation reduces attention complexity.")

        annotations = [
            Annotation(
                type="definition",
                text_ref="Nystrom approximation",
                note="Nystrom approximation: a low-rank approximation method.",
                importance=2,
                page_number=1,
                bbox=BoundingBox(x=0, y=0, width=1, height=1),
            )
        ]

        refined = refine_annotation_bboxes(annotations, pdf_doc)
        refined_bbox = refined[0].bbox

        self.assertLess(refined_bbox.width, 1)
        self.assertLess(refined_bbox.height, 1)
        self.assertTrue(refined_bbox.fragments)
        self.assertLessEqual(refined_bbox.fragments[0].width, refined_bbox.width)

        pdf_doc.close()


if __name__ == "__main__":
    unittest.main()
