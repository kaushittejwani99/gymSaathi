GymSaathi QA Test Harness
=========================

Copy the `tests/` directory into your GymSaathi project root (where server.js lives). On a local Node.js 22+ installation run:

  node tests/run_e2e.cjs
  node tests/test_qr_edges.cjs
  node tests/test_50_assistant.cjs

The tests set a temporary DATA_DIR in the operating-system temp folder and use a fake admin/gym account; they do not use your real gym data. The 50-query suite disables Gemini and targets the repeatable built-in local assistant fallback; it is not a live Gemini/provider test. The harness writes JSON results into the project root. Use only a local/staging code checkout.
