#!/bin/bash
# Local debugging helper: call a dsh Remote endpoint with a signed browser
# cookie. Not used by the plugin at runtime.
set -euo pipefail
PORT="${DSH_PORT:-3080}"
AUTHORITY="127.0.0.1:${PORT}"
SECRET_B64="${DSH_BROWSER_SECRET:?set DSH_BROWSER_SECRET from ~/.dsh/.credentials.yaml}"
COOKIE=$(python3 - "$AUTHORITY" "$SECRET_B64" <<'PY'
import json, hmac, hashlib, base64, time, sys
authority, secret_b64 = sys.argv[1], sys.argv[2]
secret=base64.urlsafe_b64decode(secret_b64+'='*((4-len(secret_b64)%4)%4))
def b64(b): return base64.urlsafe_b64encode(b).decode().rstrip('=')
now=int(time.time()*1000)
payload={'version':1,'authority':authority,'issuedAt':now,'expiresAt':now+30*24*3600*1000}
body=b64(json.dumps(payload,separators=(',',':')).encode())
sig=b64(hmac.new(secret,body.encode(),hashlib.sha256).digest())
print('dsh-auth-'+b64(hashlib.sha256(authority.encode()).digest())+'=v1.'+body+'.'+sig)
PY
)
RPCID=$(python3 -c "import uuid;print(uuid.uuid4())")
BODY=$(python3 -c "import json,sys;print(json.dumps({'type':'client-request','rpcId':'$RPCID','method':sys.argv[1],'payload':{'args':json.loads(sys.argv[2])}}))" "$1" "$2")
curl -sS --max-time 300 -X POST -H "Cookie: $COOKIE" -H 'content-type: application/json' --data "$BODY" "http://127.0.0.1:${PORT}/api/$1"
