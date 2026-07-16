#!/usr/bin/env sh
set -eu

cat > "$ORBITAL_PATCH_PATH" <<'PATCH'
diff --git a/orbital-local-worker.txt b/orbital-local-worker.txt
new file mode 100644
--- /dev/null
+++ b/orbital-local-worker.txt
@@ -0,0 +1 @@
+local worker completed
PATCH

printf 'Prepared patch artifact for mission %s\n' "$ORBITAL_MISSION_ID"
