{{/*
The retry the site checks run each probe under: a new pod's first connections can be dropped until
the NetworkPolicy controller admits it, and after an upgrade the pod it checks may still be
starting. `retry <what> <command...>` runs the command every 3s until it succeeds or 120s have gone,
inside helm test's own five minutes, so a failure prints its reason before Helm gives up.
*/}}
{{- define "aber.testRetry" -}}
retry() {
  what=$1; shift
  deadline=$(( $(date +%s) + 120 ))
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    echo "    waiting for $what ..."
    sleep 3
  done
}
{{- end -}}
