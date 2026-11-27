# Idea Tree candidate validation benchmarks

The product comparisons use an isolated ScienceDiscovery stack with JiuwenSwarm and a managed local Linux Bubblewrap Runner. Each pair starts from the same frozen inputs, solver components and first candidate. Both arms score the same first comparison in the product. The harness passes that comparison from the second-round Idea Tree payload to the JiuwenSwarm model in arm B. Arm A receives the same experiment prompt with those measurements withheld. The remaining Evolve roles use a deterministic fixture.

Each arm gets one real model call to propose weights for four components. The harness translates the weights into a Python script. The Runner evaluates the script against the same baseline using the development split. Both arms deliver the best eligible development result, with ties retaining the incumbent. Failed proposals retain the evaluated incumbent. The report includes such fallbacks, model tokens, wall time, validation IDs and execution IDs. A development error that prevents selection leaves the arm without a delivered score.

IMDb fits all four components on the same stratified 20,000 examples from the official training split. The remaining 5,000 form development. Holdout uses the official 25,000 examples and the benchmark's two-class argmax rule. Burgers uses all 50 official development trajectories on a fixed observation grid and global nRMSE. Holdout uses all 100 trajectories at full resolution and the pinned CodePDE evaluator's mean per-trajectory nRMSE. The development and holdout nRMSE formulas differ. Neither holdout score reaches ideation.

## Running the comparison

Provide Python with NumPy, h5py, PyArrow, scikit-learn and httpx. Compatibility with the linked benchmark source is checked in `score.py`. The product harness needs Node, pnpm and a working ScienceDiscovery checkout. Set `E2E_BASE_URL` and `E2E_API_TOKEN` for the isolated JiuwenSwarm stack. Set `REAL_LLM_MODEL`, `REAL_LLM_BASE_URL` and `REAL_LLM_KEY` with the approved model profile. Only the isolated stack's settings are changed. The scripts restore the prior values on exit.

```bash
python test/benchmarks/idea-tree-validation/prepare_imdb_ensemble.py \
  --data "$IMDB_PARQUET_DIR" --output "$VALIDATION_DATA"
VALIDATION_TASK=imdb VALIDATION_PAIRS=10 \
  pnpm exec tsx test/benchmarks/idea-tree-validation/paired-product.mts
```

Set `VALIDATION_DATA` to a dedicated directory and `VALIDATION_REPORT` to a fresh JSON file before running each task. For Burgers, use a checkout of CodePDE at the revision named in `score.py` and the published `.hdf5` development and test files.

```bash
python test/benchmarks/idea-tree-validation/burgers_ensemble.py prepare \
  --data "$BURGERS_HDF5_DIR" --output "$VALIDATION_DATA" --codepde "$CODEPDE_SOURCE"
VALIDATION_TASK=burgers VALIDATION_PAIRS=10 \
  pnpm exec tsx test/benchmarks/idea-tree-validation/paired-product.mts
python test/benchmarks/idea-tree-validation/burgers_ensemble.py grade \
  --data "$BURGERS_HDF5_DIR" --output "$VALIDATION_DATA" --codepde "$CODEPDE_SOURCE" \
  --locked "$VALIDATION_REPORT.locked" --report "$VALIDATION_REPORT"
python test/benchmarks/idea-tree-validation/summarize.py "$VALIDATION_REPORT"
```

`paired.py` and `score.py` also reproduce the initial fixed-menu trial. The product journey is `test/api/idea-candidate-validation.ts`. Install the repository's E2E dependencies as described in `test/sync-e2e.mjs` before running it. Set `E2E_DESKTOP_URL` to the desktop renderer served by Vite with `SCIENCE_AGENT_API_URL` pointing at the same isolated stack to exercise both UIs.
