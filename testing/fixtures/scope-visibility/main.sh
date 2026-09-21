#!/usr/bin/env bash

source ./lib.sh

use_shared() {
  # Local declaration shadows the sourced global within this function.
  local SHADOWED_VALUE="local-from-main"
  echo "$SHADOWED_VALUE"
  echo "$SHARED_TOKEN"
  shared_helper
}

use_shared
