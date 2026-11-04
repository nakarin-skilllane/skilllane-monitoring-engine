// exit 0 when <url>/api/health answers 200 (run.sh waits on it from inside the stack's network)
const r = await fetch(`${process.argv[2]}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
process.exit(r?.ok ? 0 : 1)
