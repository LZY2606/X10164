#!/usr/bin/env bash
# lib.sh: sourced by main.sh

# A token shared across the library and its consumers.
SHARED_TOKEN="from-lib"

# A global that main.sh shadows with a function-local declaration.
SHADOWED_VALUE="global-from-lib"

# Helper provided by the library.
shared_helper() {
  echo "$SHARED_TOKEN"
}
