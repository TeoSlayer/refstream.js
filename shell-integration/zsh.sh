# Source this file in an interactive Zsh. Existing preexec/precmd hooks are kept.
[[ -o interactive ]] || return 0
[[ ${__shell_online_integrated-} == zsh ]] && return 0

__shell_online_directory() {
  emulate -L zsh
  local LC_ALL=C shell_online_path=$PWD shell_online_encoded= shell_online_char shell_online_hex
  local -i shell_online_i
  for ((shell_online_i=1; shell_online_i<=${#shell_online_path}; shell_online_i++)); do
    shell_online_char=${shell_online_path[shell_online_i]}
    case $shell_online_char in
      [a-zA-Z0-9/._~-]) shell_online_encoded+=$shell_online_char ;;
      *) printf -v shell_online_hex '%%%02X' "'$shell_online_char"; shell_online_encoded+=$shell_online_hex ;;
    esac
  done
  printf '\033]7;file://%s\007' "$shell_online_encoded"
}
__shell_online_preexec() {
  __shell_online_running=1
  printf '\033]133;C\007'
}
__shell_online_precmd() {
  local shell_online_status=$?
  emulate -L zsh
  if [[ ${__shell_online_running-} == 1 ]]; then printf '\033]133;D;%d\007' "$shell_online_status"; fi
  __shell_online_running=0
  __shell_online_directory
  if [[ $PROMPT == "${__shell_online_wrapped-}" ]]; then PROMPT=$__shell_online_prompt_text; fi
  __shell_online_prompt_text=$PROMPT
  __shell_online_wrapped=$'%{\e]133;A\a%}'$__shell_online_prompt_text$'%{\e]133;B\a%}'
  PROMPT=$__shell_online_wrapped
  return 0
}

__shell_online_integrated=zsh
autoload -Uz add-zsh-hook
add-zsh-hook preexec __shell_online_preexec
add-zsh-hook precmd __shell_online_precmd
