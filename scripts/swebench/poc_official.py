"""Pinned, no-model official SWE-bench adjudication probe.

The gold patch is used only inside this probe, never as agent input. Generated
dataset rows and logs stay outside the repository; the committed output is only
the protocol and the resulting evidence description.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
DATASET_SHA256 = "a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd"
HARNESS_COMMIT = "3f01bd622c0a22c00406139f69a234ef08225f22"
INSTANCE_ID = "sympy__sympy-20590"


def command(args, *, cwd=None, timeout=30, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {(result.stderr or result.stdout)[-2000:]}")
    return result.stdout.strip()


def prepare(dataset: Path, harness: Path, out: Path):
    import pyarrow.parquet as parquet

    actual_hash = hashlib.sha256(dataset.read_bytes()).hexdigest()
    if actual_hash != DATASET_SHA256:
        raise ValueError(f"dataset SHA-256 mismatch: {actual_hash}")
    actual_commit = command(["git", "-C", str(harness), "rev-parse", "HEAD"])
    if actual_commit != HARNESS_COMMIT:
        raise ValueError(f"official harness commit mismatch: {actual_commit}")
    rows = parquet.read_table(dataset).to_pylist()
    matches = [row for row in rows if row["instance_id"] == INSTANCE_ID]
    if len(rows) != 500 or len(matches) != 1:
        raise ValueError("expected 500 Verified rows and one pinned instance")
    instance = matches[0]
    if instance["base_commit"] != "cffd4e0f86fefd4802349a9f9b19ed70934ea354":
        raise ValueError("pinned instance base commit changed")
    out.mkdir(parents=True, exist_ok=True)
    one = out / "one-instance.json"
    one.write_text(json.dumps([instance], ensure_ascii=False), encoding="utf-8")
    return instance, one, {
        "datasetRevision": DATASET_REVISION,
        "datasetSha256": actual_hash,
        "harnessCommit": actual_commit,
        "instanceId": INSTANCE_ID,
        "baseCommit": instance["base_commit"],
        "goldPatchSha256": hashlib.sha256(instance["patch"].encode()).hexdigest(),
        "providerRequests": 0,
        "status": "preflight-only",
    }


def evaluate(instance, one: Path, out: Path, prefix: str, manifest: dict):
    from swebench.harness.test_spec.test_spec import make_test_spec

    engine = command(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=15)
    image = make_test_spec(instance, namespace="swebench").instance_image_key
    env = {key: value for key, value in os.environ.items() if key not in {
        "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"
    }}
    reports = []
    for index in (1, 2):
        run_id = f"{prefix}-gold-{index}"
        args = [sys.executable, "-m", "swebench.harness.run_evaluation", "--dataset_name", str(one),
                "--predictions_path", "gold", "--instance_ids", INSTANCE_ID, "--max_workers", "1",
                "--timeout", "600", "--cache_level", "instance", "--clean", "false",
                "--namespace", "swebench", "--run_id", run_id]
        with (out / f"{run_id}.log").open("w", encoding="utf-8") as log:
            result = subprocess.run(args, cwd=out, env=env, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=1800, check=False)
        if result.returncode:
            tail = (out / f"{run_id}.log").read_text(encoding="utf-8", errors="replace")[-4000:]
            raise RuntimeError(f"official evaluation {run_id} exited {result.returncode}: {tail}")
        report = json.loads((out / f"gold.{run_id}.json").read_text(encoding="utf-8"))
        if report["resolved_ids"] != [INSTANCE_ID] or report["error_instances"]:
            raise RuntimeError(f"official gold patch did not resolve the pinned instance: {report}")
        remaining = command(["docker", "ps", "-aq", "--filter", f"name={run_id}"], timeout=15)
        if remaining:
            raise RuntimeError(f"evaluation left a container: {remaining}")
        reports.append({"runId": run_id, "resolvedIds": report["resolved_ids"], "errorInstances": report["error_instances"]})
    image_info = json.loads(command(["docker", "image", "inspect", image], timeout=15))[0]
    manifest.update({"status": "official-gold-scored-twice", "dockerServerVersion": engine,
                     "image": image, "imageDigests": image_info["RepoDigests"], "runs": reports})
    if not manifest["imageDigests"]:
        raise RuntimeError("published image has no immutable RepoDigest")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-id-prefix", default="mini-dsh-poc")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    instance, one, manifest = prepare(args.dataset, args.harness, args.out)
    if args.execute:
        evaluate(instance, one, args.out, args.run_id_prefix, manifest)
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
