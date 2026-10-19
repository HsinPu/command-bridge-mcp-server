#!/usr/bin/env bash
prepare_job_migration_runtime() {
  mkdir -p "$TEMP_DIR/node-runtime/bin" "$TEMP_DIR/source"
  ln -s "${TEST_NODE:-$(command -v node)}" "$TEMP_DIR/node-runtime/bin/node"
  ln -s "$(pwd)/dist" "$TEMP_DIR/source/dist"
  ln -s "$(pwd)/node_modules" "$TEMP_DIR/source/node_modules"
  printf '{"type":"module"}\n' > "$TEMP_DIR/source/package.json"
}
