# Source this file in an interactive Bash. No rc files or external state are changed.
# OSC 133 boundaries and OSC 7 directories are metadata, not authentication.
[[ $- == *i* ]] || return 0
[[ ${__shell_online_integrated-} == bash ]] && return 0
if [[ -n $(trap -p DEBUG) || $- == *T* ]] || shopt -q extdebug; then
  printf '%s\n' 'shell.online: an existing DEBUG trap or function tracing is active; keep that integration or use a clean shell.' >&2
  return 1
fi

__shell_online_directory() {
  local LC_ALL=C shell_online_path=$PWD shell_online_encoded= shell_online_char shell_online_hex shell_online_i
  for ((shell_online_i=0; shell_online_i<${#shell_online_path}; shell_online_i++)); do
    shell_online_char=${shell_online_path:shell_online_i:1}
    case $shell_online_char in
      [a-zA-Z0-9/._~-]) shell_online_encoded+=$shell_online_char ;;
      *) printf -v shell_online_hex '%%%02X' "'$shell_online_char"; shell_online_encoded+=$shell_online_hex ;;
    esac
  done
  printf '\033]7;file://%s\007' "$shell_online_encoded"
}
__shell_online_preexec() {
  [[ ${__shell_online_phase-} == ready && $BASH_COMMAND != __shell_online_precmd && ${BASH_SUBSHELL:-0} == 0 ]] || return 0
  __shell_online_phase=running
  printf '\033]133;C\007'
}
__shell_online_precmd() {
  local shell_online_status=$?
  if [[ ${__shell_online_phase-} == running ]]; then printf '\033]133;D;%d\007' "$shell_online_status"; fi
  __shell_online_phase=prompt
  if [[ ${PS1-} == "${__shell_online_wrapped-}" ]]; then PS1=$__shell_online_prompt_text; fi
  __shell_online_directory
  return "$shell_online_status"
}
__shell_online_prompt() {
  local shell_online_status=$?
  __shell_online_prompt_text=${PS1-}
  __shell_online_wrapped='\[\e]133;A\a\]'$__shell_online_prompt_text'\[\e]133;B\a\]'
  PS1=$__shell_online_wrapped
  __shell_online_phase=ready
  return "$shell_online_status"
}

__shell_online_integrated=bash
__shell_online_phase=install
# Preserve strings on Bash 3.2, and arrays on newer Bash versions.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND=(__shell_online_precmd "${PROMPT_COMMAND[@]}" __shell_online_prompt)
else
  PROMPT_COMMAND=$'__shell_online_precmd\n'${PROMPT_COMMAND-}$'\n__shell_online_prompt'
fi
trap '__shell_online_preexec' DEBUG
