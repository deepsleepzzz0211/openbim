#!/bin/bash
# OpenBIM Hub 真实复杂模型 E2E 上传脚本
API="http://localhost:3001/api/v1"
SAMPLES="D:/project/bim/samples/complex"
PROJECT_ID="cmtkiouku0004u544qasg0zry"

# 1. 登录
LOGIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"demo@openbim.local","password":"Demo1234"}')
TOKEN=$(echo "$LOGIN" | python -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
[ -z "$TOKEN" ] && { echo "LOGIN FAILED: $LOGIN"; exit 1; }
echo "[OK] logged in"

AUTH="Authorization: Bearer $TOKEN"

# 2. 上传函数：创建模型 + 上传版本，输出 modelId/versionId
upload_model() {
  local name="$1"; local file="$2"
  local MR=$(curl -s -X POST "$API/projects/$PROJECT_ID/models" -H "$AUTH" \
    -H "Content-Type: application/json" -d "{\"name\":\"$name\"}")
  local MODEL_ID=$(echo "$MR" | python -c "import json,sys; print(json.load(sys.stdin).get('model',{}).get('id',''))")
  [ -z "$MODEL_ID" ] && { echo "[FAIL] create model $name: $MR"; return; }
  local T0=$(date +%s)
  local UR=$(curl -s -X POST "$API/models/$MODEL_ID/versions" -H "$AUTH" \
    -F "file=@$SAMPLES/$file")
  local VER_ID=$(echo "$UR" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('version',{}).get('id') or d.get('id',''))")
  echo "$name|$MODEL_ID|$VER_ID|$file|$T0"
}

echo "=== uploading real complex models ==="
upload_model "真实项目-Duplex公寓" "Duplex_A_20110907.ifc"
upload_model "真实项目-Duplex机电" "Duplex_MEP_20110907.ifc"
upload_model "真实项目-Duplex给排水" "Duplex_Plumbing_20121113.ifc"
upload_model "认证场景-桥梁" "Infra-Bridge.ifc"
upload_model "认证场景-景观" "Infra-Landscaping.ifc"
