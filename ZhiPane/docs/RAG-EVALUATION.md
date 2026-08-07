# RAG Evaluation Set

Automated tests use the mock AI provider. Real provider quality must be evaluated with a deterministic dataset before release.

Minimum dataset:

- 20 Chinese exact-fact questions
- 20 semantic paraphrase questions
- 10 no-answer questions
- 10 cross-page synthesis questions
- 10 permission-isolation questions
- 10 topic-source traceability questions

Metrics:

- citation_precision
- answer_groundedness
- no_answer_accuracy
- permission_leakage_rate, must be 0
- retrieval_recall_at_5
- chinese_keyword_hit_rate
