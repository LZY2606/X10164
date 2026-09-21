#!/bin/sh

source ./lib.sh

use_token() {
  local SHARED_TOKEN="local-shadow"
  echo "$SHARED_TOKEN"
}

echo "$SHARED_TOKEN"
shared_helper

source "$OPTIONAL_CONFIG_DIR/optional.sh"
