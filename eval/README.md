# Evaluation

- [`read_bbrec.py`](read_bbrec.py) loads a `.bbrec.jsonl` recording (exported from the app's Recordings tab) into decoded rows, using the descriptors stored in the recording. It needs only the standard library; pandas is optional. Run `python eval/read_bbrec.py --selftest` to check it against `protocol/test-vectors.json`.
- **Clock sync (Paper 1):** the evaluator lives in the app (`app/src/sync/evaluate.ts`), so the same estimator code runs live and offline. Run it from `app/`:

  ```bash
  npm run eval:sync                                                     # quick seeded check (5 × 3 min simulated)
  SYNC_EVAL_MINUTES=30 SYNC_EVAL_SEEDS=5 SYNC_EVAL_OUT=../eval/results/sync-sim-30min npm run eval:sync
  SYNC_EVAL_FILE=../path/to/hardware.bbrec.jsonl SYNC_EVAL_OUT=../eval/results/hw-1 npm run eval:sync
  ```

  Each output directory has `report.txt` (tables), `report.json` (the numbers) and `series.csv`. The CSV has the columns `t_s, method, kind, series, value_ms`; `kind` is `pulse`, `absolute` or `ptt`. Plot it with pandas/matplotlib.

  Simulator recordings are reproducible from their seed, so they are not kept (see `.gitignore`).
- **Descriptor synthesis (Paper 2):** the benchmark devices are in `app/src/bench/`, the loop in `app/src/synth/`. From `app/`:

  ```bash
  npm run eval:synth                     # loop mechanics with a scripted model: no API calls, no cost
  export ANTHROPIC_API_KEY=...           # or `ant auth login`
  SYNTH_LIVE=1 SYNTH_DEVICES=fingertip-oximeter,be-ecg-board npm run eval:synth          # small run, Opus 5.5
  SYNTH_LIVE=1 SYNTH_MODELS=claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5 npm run eval:synth   # full comparison
  SYNTH_LIVE=1 SYNTH_ORACLES=structural npm run eval:synth   # ablation: only structural findings fed back ("none" = validator only)

  npm run gemini:models                                      # Gemini: list model ids your GEMINI_API_KEY can use
  SYNTH_LIVE=1 SYNTH_MODELS=gemini:gemini-3.8-flash npm run eval:synth
  ```

  Keys go in the repo-root `.env` (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`; see `.env.example`). Models can be mixed in one run (`SYNTH_MODELS=claude-opus-5-5,gemini:<id>`). On Gemini's free tier the runner backs off on rate limits, so runs are slower, and requests may be used by Google to improve its products.

  A live run prints a worst-case cost before calling the API. Opus 5.5 on all 10 devices is at most about $8; typical runs need 1–2 iterations, not 4. Each run writes one JSON transcript per model and device, plus `report.txt`, to `eval/results/synth-<timestamp>/`.
- **Results so far:** [`results/sync-sim-30min/summary.txt`](results/sync-sim-30min/summary.txt). These are simulation only; see `docs/research-plan.md` §3.7 for what they do and don't show.
