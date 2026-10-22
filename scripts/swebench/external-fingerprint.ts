import { spawnSync } from 'node:child_process'

// The installed mini-SWE-agent package is pinned by both its version string and
// a digest of the files that define the agent loop, prompts, model client and
// Docker environment. The hash catches an editable install whose version did
// not change. Nothing here calls a model or starts a container.
export const BASELINE_FILES = [
  'run/benchmarks/swebench.py',
  'environments/docker.py',
  'agents/default.py',
  'models/litellm_model.py',
  'run/benchmarks/utils/common.py',
  'run/benchmarks/utils/batch_progress.py',
  'config/benchmarks/swebench.yaml',
  'config/__init__.py',
  'utils/serialize.py',
] as const

export interface BaselineFingerprint {
  version: string
  packageRoot: string
  configPath: string
  upstreamConfigSha256: string
  installSha256: string
  datasetsVersion: string
  pyarrowVersion: string
  litellmVersion: string
  pythonVersion: string
  vcsCommit: string | null
}

const script = String.raw`
import hashlib, importlib, json, pathlib, sys

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

import minisweagent
root = pathlib.Path(minisweagent.__file__).resolve().parent
files = ${JSON.stringify(BASELINE_FILES)}
parts = []
missing = []
for relative in files:
    path = root / relative
    if not path.is_file():
        missing.append(relative)
        continue
    parts.append(relative + "\0" + digest(path) + "\n")
if missing:
    raise SystemExit("missing baseline file: " + ",".join(missing))
install = hashlib.sha256("".join(sorted(parts)).encode()).hexdigest()
config = root / "config" / "benchmarks" / "swebench.yaml"
def version(name):
    try:
        module = importlib.import_module(name)
        return str(getattr(module, "__version__", "unknown"))
    except Exception:
        return "missing"
vcs = None
direct_url = root.parent / ("mini_swe_agent-" + str(getattr(minisweagent, "__version__", "unknown")) + ".dist-info") / "direct_url.json"
if direct_url.is_file():
    try:
        vcs = json.loads(direct_url.read_text()).get("vcs_info", {}).get("commit_id")
    except Exception:
        vcs = None
print(json.dumps({
    "version": str(getattr(minisweagent, "__version__", "unknown")),
    "packageRoot": str(root),
    "configPath": str(config),
    "upstreamConfigSha256": digest(config),
    "installSha256": install,
    "datasetsVersion": version("datasets"),
    "pyarrowVersion": version("pyarrow"),
    "litellmVersion": version("litellm"),
    "pythonVersion": sys.version.split()[0],
    "vcsCommit": vcs,
}))
`

export function fingerprintBaseline(python: string): BaselineFingerprint {
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`could not fingerprint the external baseline: ${(result.stderr ?? '').slice(-2000)}`)
  // mini-SWE-agent prints a version banner on import; the JSON is the last line.
  const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean)
  const parsed = JSON.parse(lines.at(-1) ?? '{}') as BaselineFingerprint
  for (const key of ['version', 'packageRoot', 'configPath', 'upstreamConfigSha256', 'installSha256'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`baseline fingerprint is missing ${key}`)
  }
  return parsed
}
