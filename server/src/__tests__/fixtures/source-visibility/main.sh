source ./lib.sh
source ./alias/../lib2.sh
source ./alias/lib-alias.sh
source ./lib.sh
usage() {
  local value=local
  echo "$value"
}
usage
shared_func
source "$UNTRUSTED_DIR/lib.sh"
source ./lib2.sh
echo "$lib2_value"
