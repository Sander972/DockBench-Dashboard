// Claude Code sign-in inside a dev container. `claude auth login --claudeai` keeps the PKCE verifier in its process, so it runs detached and reads the code from a named pipe; two short execs start it and feed it. Kept free of env so tests can import it.

const D = '/tmp/dockbench-claude-login'

// true while the attempt's shell still runs: /tmp outlives a container restart and pids get reused, so a pid alone may name another process (or this shell)
const ALIVE = `alive() { p=$(cat $D/pid 2>/dev/null) && [ ! -e $D/rc ] && [ "$p" != $$ ] && grep -qs "$D" /proc/"$p"/cmdline; }`

// exit 4: no claude; exit 5: no link within 10 s. A new start kills the earlier attempt's process group (setsid makes the shell its leader; --foreground keeps timeout and claude in that group) with KILL, so its shell never writes rc into the new directory. The pipe is held open read-write on fd 3, so claude never sees EOF and a writer never blocks. rc is written through a rename, so a reader never sees it empty.
const START = `D=${D}
${ALIVE}
command -v claude >/dev/null || exit 4
alive && kill -KILL -"$p" 2>/dev/null
rm -rf $D && mkdir -m 700 $D && mkfifo $D/in || exit 1
setsid sh -c 'D=$1; echo $$ > $D/pid; exec 3<>$D/in; timeout --foreground 600 claude auth login --claudeai <&3 >$D/out 2>&1; echo $? > $D/rc.t; mv $D/rc.t $D/rc' sh $D </dev/null >/dev/null 2>&1 &
i=0
while [ $i -lt 100 ]; do
  grep -m1 'visit: *https://' $D/out 2>/dev/null && exit 0
  [ -e $D/rc ] && break
  sleep 0.1
  i=$((i + 1))
done
tail -n 3 $D/out 2>/dev/null
exit 5`

// $1 is the code. exit 6: nothing pending (also when a restart killed the attempt, since nothing would read the pipe and the write would block); exit 7: no answer within 30 s. Otherwise claude's exit code, after its last line; the directory goes once claude has answered, since the attempt is over either way.
const CODE = `D=${D}
${ALIVE}
[ -p $D/in ] && alive || exit 6
printf '%s\\n' "$1" > $D/in
i=0
while [ ! -e $D/rc ]; do
  [ $i -ge 300 ] && exit 7
  sleep 0.1
  i=$((i + 1))
done
grep . $D/out | tail -n 1
rc=$(cat $D/rc)
rm -rf $D
exit $rc`

export const loginStartCmd = ['sh', '-c', START]

// sign out, so the Bench page can sign another account in. exit 4: no claude. The credentials file goes too: /status reports "signed in" on its presence alone, and the callout shows only once it is gone.
export const logoutCmd = ['sh', '-c', 'command -v claude >/dev/null || exit 4; claude auth logout && rm -f /home/dev/.claude/.credentials.json']
// fetch the config repo again and reset ~/.claude onto it, as DockBench entrypoint.sh does on every start: tracked files are overwritten, untracked ones (credentials, history) stay. The repo and key come from the container's own env. exit 3: config injection is off. Prints the short commit on success. The fetch is bounded by `timeout 45`, inside the 60 s the route allows the exec, so a hung fetch cannot outlive the pending lock and collide with the next click.
export const configPullCmd = ['sh', '-c', `[ -n "\${CLAUDE_CONFIG_REPO:-}" ] || exit 3
d=/home/dev/.claude
mkdir -p $d && git -C $d init -q || exit 1
[ -n "\${CLAUDE_CONFIG_KEY:-}" ] && set -- -c "core.sshCommand=ssh -i /home/dev/.ssh/claude_config -o IdentitiesOnly=yes"
timeout 45 git "$@" -C $d fetch -q --depth 1 "$CLAUDE_CONFIG_REPO" HEAD && git -C $d reset -q --hard FETCH_HEAD && git -C $d log -1 --format=%h`]
// what ~/.claude changed since the config commit it last downloaded: edits and deletions of tracked files, plus new files the repo's .gitignore lets in (so credentials and history never show). Read-only: the index is never touched, since a file added to it would be deleted by the next reset --hard. exit 3: config injection is off; exit 4: no config downloaded yet. Prints the short commit, then the diff capped at CONFIG_DIFF_MAX + 1 bytes; stderr goes, as exec mixes it into the output.
export const CONFIG_DIFF_MAX = 200_000
export const configDiffCmd = ['sh', '-c', `[ -n "\${CLAUDE_CONFIG_REPO:-}" ] || exit 3
cd /home/dev/.claude 2>/dev/null && git rev-parse -q --verify HEAD >/dev/null || exit 4
git log -1 --format=%h || exit 1
{ git diff --no-color --no-ext-diff HEAD --; git ls-files -z -o --exclude-standard | xargs -0 -r -n1 git diff --no-color --no-ext-diff --no-index -- /dev/null; } 2>/dev/null | head -c ${CONFIG_DIFF_MAX + 1}`]

// splits configDiffCmd's output; a diff over the cap is cut at its last whole line
export function parseConfigDiff(out: string) {
  const nl = out.indexOf('\n')
  const commit = (nl < 0 ? out : out.slice(0, nl)).trim()
  let diff = nl < 0 ? '' : out.slice(nl + 1)
  const truncated = Buffer.byteLength(diff) > CONFIG_DIFF_MAX
  if (truncated) diff = diff.slice(0, diff.lastIndexOf('\n', CONFIG_DIFF_MAX - 1) + 1)
  return { commit, diff, truncated }
}
// the code goes in as an argument, never through the shell string
export const loginCodeCmd = (code: string) => ['sh', '-c', CODE, 'sh', code]

// the authorize link from the "If the browser didn't open, visit: <url>" line
export const loginUrl = (out: string) => out.match(/visit:\s*(https:\/\/\S+)/)?.[1] ?? null

// claude prints its prompt without a newline, so the answer lands on the prompt's line. Query strings go, since the authorize link carries the OAuth state and this line ends up in the log.
export const lastLine = (out: string) => out.split('\n').map((l) => l.replace('Paste code here if prompted >', '').replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''
