# Recorded answers (ADR 0116)

`expansions.yaml`: the context expander's answer for each retrieval case, replayed by the eval's
+expansion mode through the planner's expansion step (its prompt and its checks). They are
stand-ins written by hand, not Copilot's: see the file's header. Replace each with a real answer
recorded at the GPT-4o mini floor before deciding the expansion's default.

There are no rerank answers yet: a rerank's answer names the candidates its case shows, so it can
only be recorded from a real run.

`models/` beside this folder holds the golden token ids of each model's own tokenizer and an
invented tokenizer for the unit tests.
